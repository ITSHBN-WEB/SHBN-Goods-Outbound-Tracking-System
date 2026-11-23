// All login / account endpoints in ONE function (Vercel free plan limits). Pick the job with ?action=
//   POST login      { loginId, password }                -> { token, user, timeoutMinutes }   (no login needed)
//   POST logout                                          -> ends this session
//   GET  me                                              -> { user }  (also keeps the session alive)
//   POST password   { current, next }                    -> change your own password
//   GET  accounts                                        -> Management: every account
//   POST account    { loginId, name, category }          -> Management: create an account (starting password = default)
//   PATCH account   { loginId, active?, name?, reset? }  -> Management: deactivate / reactivate / rename / reset password to default
//   GET  audit      ?kind=deleted|supplier|revert &q=    -> Head Office + Management: deleted records, supplier change log
const { route, HttpError, query, audit } = require('../lib/core');
const C = require('../lib/core');

const LOCK_AFTER = 5, LOCK_MINUTES = 10;
const GENERIC = 'Invalid Login ID or password, or the account is temporarily locked.';   // never says which part was wrong

function need(req, cats) {
  if (cats.indexOf(req.user.category) === -1) throw new HttpError(403, 'Your account does not have access to this function.', 'FORBIDDEN');
}
function cleanId(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(s)) throw new HttpError(400, 'Login ID must be 3-30 characters: letters, numbers, - _ .');
  return s;
}
function checkNewPassword(pw, loginId) {
  const s = String(pw || '');
  if (s.length < 6 || s.length > 72) throw new HttpError(400, 'The new password must be 6 to 72 characters.');
  if (loginId && s.toLowerCase() === String(loginId).toLowerCase()) throw new HttpError(400, 'The password cannot be the same as the Login ID.');
  return s;
}

async function login(req) {
  const b = req.body || {};
  const id = String(b.loginId || '').trim().slice(0, 60), pw = String(b.password || '').slice(0, 200);
  if (!id || !pw) throw new HttpError(400, 'Enter your Login ID and password.');
  await C.ensureSeed();
  const rows = await query('SELECT * FROM accounts WHERE lower(login_id) = lower($1)', [id]);
  const a = rows[0];
  const locked = a && a.locked_until && new Date(a.locked_until) > new Date();
  const ok = await C.verifyPassword(pw, a ? a.password_hash : await C.DUMMY_HASH_PROMISE);
  if (!a || !a.active || locked || !ok) {
    if (a && a.active && !locked) {
      await query(
        `UPDATE accounts SET
                locked_until = CASE WHEN failed_count + 1 >= ${LOCK_AFTER} THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END,
                failed_count = CASE WHEN failed_count + 1 >= ${LOCK_AFTER} THEN 0 ELSE failed_count + 1 END
          WHERE login_id = $1`, [a.login_id]);
    }
    throw new HttpError(401, GENERIC, 'BAD_LOGIN');
  }
  await query('UPDATE accounts SET failed_count = 0, locked_until = NULL, last_login = now() WHERE login_id = $1', [a.login_id]);
  return { success: true, token: await C.startSession(a), user: C.publicUser(a), timeoutMinutes: C.SESSION_MINUTES };
}

module.exports = route(['GET', 'POST', 'PATCH'], async function (req) {
  const action = String((req.query && req.query.action) || '');

  if (action === 'login' && req.method === 'POST') return await login(req);

  // everything below needs a session
  if (!req.user) req.user = await C.authenticate(req);
  const me = req.user;
  if (me.mustChange && action !== 'password' && action !== 'logout' && action !== 'me') {
    throw new HttpError(403, 'Please set a new password first.', 'MUST_CHANGE_PASSWORD');
  }

  if (action === 'me' && req.method === 'GET') return { success: true, user: me, timeoutMinutes: C.SESSION_MINUTES };

  if (action === 'logout' && req.method === 'POST') {
    await query('DELETE FROM sessions WHERE token_hash = $1', [C.sha(String(req.headers.authorization || '').slice(7))]);
    return { success: true };
  }

  if (action === 'password' && req.method === 'POST') {
    const b = req.body || {};
    const row = (await query('SELECT password_hash FROM accounts WHERE login_id = $1', [me.loginId]))[0];
    if (!row || !(await C.verifyPassword(String(b.current || ''), row.password_hash))) throw new HttpError(400, 'Your current password is not correct.', 'BAD_CURRENT');
    const next = checkNewPassword(b.next, me.loginId);
    if (next === String(b.current)) throw new HttpError(400, 'Choose a password different from the current one.');
    await query('UPDATE accounts SET password_hash = $1, must_change = false WHERE login_id = $2', [await C.hashPassword(next), me.loginId]);
    // every OTHER session of this account ends; the one in use stays
    await query('DELETE FROM sessions WHERE login_id = $1 AND token_hash <> $2', [me.loginId, C.sha(String(req.headers.authorization || '').slice(7))]);
    return { success: true };
  }

  if (action === 'accounts') {
    need(req, ['MANAGEMENT']);
    if (req.method === 'GET') {
      return await query(
        `SELECT login_id AS "loginId", name, category, active, must_change AS "mustChange",
                to_char(last_login AT TIME ZONE 'Asia/Kuala_Lumpur', 'FMDD.FMMM.YYYY FMHH12.MIPM') AS "lastLogin",
                (locked_until IS NOT NULL AND locked_until > now()) AS locked
           FROM accounts ORDER BY CASE category WHEN 'MANAGEMENT' THEN 0 WHEN 'HEAD_OFFICE' THEN 1 ELSE 2 END, login_id`);
    }
  }

  if (action === 'account') {
    need(req, ['MANAGEMENT']);
    const b = req.body || {};
    if (req.method === 'POST') {
      const loginId = cleanId(b.loginId);
      const category = String(b.category || 'OUTLET').toUpperCase();
      if (C.CATEGORIES.indexOf(category) === -1) throw new HttpError(400, 'Choose a valid category.');
      const name = String(b.name || loginId).trim().slice(0, 80) || loginId;
      const taken = await query('SELECT 1 FROM accounts WHERE lower(login_id) = lower($1)', [loginId]);
      if (taken.length) throw new HttpError(409, 'That Login ID already exists.', 'DUPLICATE_ACCOUNT');
      await query(
        `INSERT INTO accounts (login_id, name, category, outlet, password_hash, must_change) VALUES ($1,$2,$3,$4,$5,true)`,
        [loginId, name, category, category === 'OUTLET' ? loginId : null, await C.hashPassword(C.defaultPassword(loginId))]);
      await audit(req, 'ACCOUNT_CREATE', 'ACCOUNT', loginId, category);
      return { success: true, defaultPassword: C.defaultPassword(loginId) };
    }
    if (req.method === 'PATCH') {
      const loginId = cleanId(b.loginId);
      const cur = (await query('SELECT * FROM accounts WHERE lower(login_id) = lower($1)', [loginId]))[0];
      if (!cur) throw new HttpError(404, 'Account not found.');
      if (b.active !== undefined) {
        const on = !!b.active;
        if (!on && cur.login_id === me.loginId) throw new HttpError(400, 'You cannot deactivate the account you are using.');
        if (!on && cur.category === 'MANAGEMENT') {
          const others = await query("SELECT count(*)::int AS n FROM accounts WHERE category = 'MANAGEMENT' AND active AND login_id <> $1", [cur.login_id]);
          if (!others[0].n) throw new HttpError(400, 'At least one Management account must stay active.');
        }
        await query('UPDATE accounts SET active = $1 WHERE login_id = $2', [on, cur.login_id]);
        if (!on) await query('DELETE FROM sessions WHERE login_id = $1', [cur.login_id]);
        await audit(req, on ? 'ACCOUNT_ACTIVATE' : 'ACCOUNT_DEACTIVATE', 'ACCOUNT', cur.login_id, '');
      }
      if (b.name !== undefined) {
        const name = String(b.name).trim().slice(0, 80);
        if (!name) throw new HttpError(400, 'Name cannot be empty.');
        await query('UPDATE accounts SET name = $1 WHERE login_id = $2', [name, cur.login_id]);
      }
      let defaultPassword;
      if (b.reset) {
        defaultPassword = C.defaultPassword(cur.login_id);
        await query('UPDATE accounts SET password_hash = $1, must_change = $2, failed_count = 0, locked_until = NULL WHERE login_id = $3',
          [await C.hashPassword(defaultPassword), cur.category !== 'MANAGEMENT', cur.login_id]);
        await query('DELETE FROM sessions WHERE login_id = $1', [cur.login_id]);
        await audit(req, 'PASSWORD_RESET', 'ACCOUNT', cur.login_id, '');
      }
      return { success: true, defaultPassword };
    }
  }

  if (action === 'audit' && req.method === 'GET') {
    need(req, ['HEAD_OFFICE', 'MANAGEMENT']);
    const kind = String(req.query.kind || 'deleted');
    const where = [], params = [];
    if (kind === 'deleted') where.push("action = 'DELETE'");
    else if (kind === 'supplier') where.push("kind = 'SUPPLIER'");
    else if (kind === 'revert') where.push("action = 'REVERT'");
    else throw new HttpError(400, 'Unknown log.');
    const needle = String(req.query.q || '').trim().slice(0, 80);
    if (needle) { params.push('%' + needle.replace(/[\\%_]/g, '\\$&') + '%'); where.push('(ref ILIKE $1 OR detail ILIKE $1 OR actor ILIKE $1 OR COALESCE(origin, \'\') ILIKE $1)'); }
    return await query(
      `SELECT id::text AS id, to_char(at AT TIME ZONE 'Asia/Kuala_Lumpur', 'FMDD.FMMM.YYYY FMHH12.MIPM') AS "at", actor, action, kind, ref, detail,
              origin AS outlet, snapshot
         FROM audit_log WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT 500`, params);
  }

  throw new HttpError(400, 'Unknown request.');
}, { public: true, allowMustChange: true });

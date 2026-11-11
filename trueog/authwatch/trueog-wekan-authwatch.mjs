#!/usr/bin/env node
// trueog-wekan-authwatch: locks a WeKan account within about a second of its Staff-Auth account being
// deactivated or deleted, and unlocks it when the Staff-Auth account is active again.
//
// Operator 2026-11-11: WeKan signs in through Staff-Auth (Hydra client "TrueOG WeKan"); any active staff
// account may sign in; demotion between roles does not matter for WeKan; deactivation and deletion lock;
// open sessions must end within seconds ("A": through WeKan's own API).
//
// How: once a second it reads uuid and deactivated from Staff-Auth's users table (PostgreSQL role
// wekan_authwatch, SELECT on those two columns only) and every WeKan user linked to Staff-Auth
// (services.oidc.id = the Staff-Auth uuid, which is Hydra's subject). A linked WeKan account whose
// Staff-Auth account is missing or deactivated, confirmed by a second read 0.5 s later, is locked:
//   1. directly in the database, in one conditional update: loginDisabled=true, loginDisabledReason=
//      "staff-auth", resume tokens cleared. This is the lock. WeKan refuses that account's sign-in (every
//      login type, OIDC included), REST, files and exports from this moment;
//   2. then through WeKan's REST API as the password-less admin account staffauth-lockbot (PUT /api/users/:id
//      {action: disableLogin}, the same change made inside WeKan). A write made inside WeKan makes its
//      observers re-read at once, so an open browser tab is closed within about 2 s
//      (METEOR_POLLING_THROTTLE_MS) instead of at WeKan's next poll (METEOR_POLLING_INTERVAL_MS, 30 s).
//      If this step fails the lock from step 1 stands and the tab closes at that next poll.
// Sign-out (operator 2026-11-11: logging out of Staff-Auth must sign people out of the apps too): every few seconds
// the Staff-Auth access token WeKan stored at the person's last sign-in (services.oidc.accessToken; the Hydra client
// "TrueOG WeKan" issues them for 2160 h) is checked with Hydra's introspection on the admin loopback. A token Hydra
// reports inactive (Staff-Auth revoked the person's grants: logout, role change, deactivation; or it expired), twice
// 0.5 s apart, ends that account's WeKan sessions: resume tokens cleared, account NOT disabled, conditional on the
// stored token being unchanged (a fresh sign-in in between wins). An account with sessions but no stored token (from
// before WeKan used Staff-Auth) is signed out too. WeKan then sends the person to Staff-Auth to sign in again. Any
// Hydra error (or a non-200 answer) changes nothing. Open tabs close at WeKan's next poll.
// An account this service locked is unlocked (loginDisabled=false, reason removed, inactivity clock
// restarted as WeKan's own re-enable does) once its Staff-Auth account is active again; the person then
// signs in again. Nothing is ever deleted.
//
// Safeguards:
//   - acts only when /opt/wekan/current is a WeKan release listed in REVIEWED_WEKAN (the meaning of
//     loginDisabled, the resume tokens and the REST action were read in that version's source);
//     otherwise watch only;
//   - an account disabled by anyone else (an administrator, WeKan's inactive-user job) is never unlocked,
//     and an account already disabled is never touched. Known limit: an administrator who disables an
//     account this service had already locked leaves the reason "staff-auth", so it is unlocked when the
//     person's Staff-Auth account is active again;
//   - no account is exempt (operator 2026-11-11: "no account should be exempt"); Staff-Auth subjects listed in
//     TRUEOG_WEKAN_AUTHWATCH_EXEMPT (empty by default, matched by uuid) would never be locked;
//   - any database error or an empty Staff-Auth user list ends the pass with nothing changed (backoff);
//   - more than MAX_LOCKS locks at once, or locking every lockable account when two or more are linked,
//     is refused (a restore or a broken read looks like that) and alerted every 10 minutes until it
//     clears, unless the operator creates /etc/trueog-wekan-authwatch/allow-mass-lock (alerted every 10
//     minutes while it exists; every installer run removes it).
// Off switch: rc-service trueog-wekan-authwatch stop (Staff-Auth still refuses sign-in for deactivated or
// deleted accounts; only WeKan sessions already open would then stay).
//
// Modes: no argument = run; --check = connect to both databases, one pass without writing, print what
// would change, exit 0 with WEKAN_AUTHWATCH_CHECK_OK; --provision-bot = create or reset the password-less
// WeKan admin account staffauth-lockbot and prove it acts through the REST API (WEKAN_LOCKBOT_OK);
// --remove-bot = delete that account (only one this tool made: marked trueogLockBot).

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const REVIEWED_WEKAN = ['13.06'];
export const REASON = 'staff-auth';
export const BOT_USERNAME = 'staffauth-lockbot';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function settings(env = process.env) {
  return {
    wekanHome: env.TRUEOG_WEKAN_HOME || '/opt/wekan',
    envFile: env.TRUEOG_WEKAN_ENV_FILE || '/opt/wekan/wekan.env',
    wekanUrl: env.TRUEOG_WEKAN_URL || 'http://127.0.0.1:3001',
    psql: env.TRUEOG_WEKAN_AUTHWATCH_PSQL || '/usr/bin/psql',
    pgConninfo: env.TRUEOG_WEKAN_AUTHWATCH_PG || 'host=127.0.0.1 dbname=staffauth user=wekan_authwatch connect_timeout=3',
    pgpass: env.PGPASSFILE || '/etc/trueog-wekan-authwatch/pgpass',
    hydraAdmin: env.TRUEOG_WEKAN_AUTHWATCH_HYDRA_ADMIN || 'http://127.0.0.1:4445',
    signOutEveryMs: Number(env.TRUEOG_WEKAN_AUTHWATCH_SIGNOUT_MS || 3000),
    massLockFile: env.TRUEOG_WEKAN_AUTHWATCH_MASS_LOCK || '/etc/trueog-wekan-authwatch/allow-mass-lock',
    exempt: (env.TRUEOG_WEKAN_AUTHWATCH_EXEMPT ?? '')
      .split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase()),
    intervalMs: Number(env.TRUEOG_WEKAN_AUTHWATCH_INTERVAL_MS || 1000),
    confirmMs: Number(env.TRUEOG_WEKAN_AUTHWATCH_CONFIRM_MS || 500),
    maxLocks: 2,
  };
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Error text may quote a connection string or a token: keep it short and blank those.
export const clean = e => String(e?.message ?? e).replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://...')
  .replace(/[A-Za-z0-9_\-]{32,}/g, '...').split('\n')[0].slice(0, 300);

// MONGO_URL from WeKan's own env file (export MONGO_URL='...'); never logged.
export function mongoUrl(envFile) {
  const text = fs.readFileSync(envFile, 'utf8');
  const m = text.match(/^\s*export\s+MONGO_URL=(?:'([^'\n]*)'|"([^"\n]*)"|([^\s'"#]+))\s*$/m);
  const url = m && (m[1] ?? m[2] ?? m[3]);
  if (!url || !/^mongodb(\+srv)?:\/\//.test(url)) throw new Error('no MONGO_URL in ' + envFile);
  return url;
}

// The WeKan release /opt/wekan/current points at ("13.06"), or null.
export function wekanVersion(wekanHome) {
  try {
    return path.basename(fs.readlinkSync(path.join(wekanHome, 'current')));
  } catch {
    return null;
  }
}

const bundleRequire = (wekanHome, dir) => createRequire(path.join(wekanHome, 'current/bundle/programs/server/npm/node_modules/meteor', dir, 'index.js'));
export const loadMongo = wekanHome => bundleRequire(wekanHome, 'npm-mongo/node_modules')('mongodb');

// Staff-Auth's accounts: Map(uuid -> active). Throws on any problem, including an empty table.
export function readStaffViaPsql(s) {
  return new Promise((resolve, reject) => {
    const child = spawn(s.psql, ['-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-d', s.pgConninfo,
      '-c', 'select uuid, deactivated from users'], {
      env: { PATH: '/usr/bin:/bin', PGPASSFILE: s.pgpass, PGCONNECT_TIMEOUT: '3', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Error('psql could not run (' + e.code + ')')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('psql exit ' + code + ': ' + clean(err)));
      try { resolve(parseStaff(out)); } catch (e) { reject(e); }
    });
  });
}

export function parseStaff(out) {
  const staff = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [uuid, deactivated, extra] = line.split('\t');
    if (extra !== undefined || !UUID.test(uuid) || !['t', 'f'].includes(deactivated)) {
      throw new Error('unexpected Staff-Auth row');
    }
    staff.set(uuid, deactivated === 'f');
  }
  if (!staff.size) throw new Error('Staff-Auth has no users (refusing to judge)');
  return staff;
}

export const subOf = u => {
  const id = u?.services?.oidc?.id;
  return typeof id === 'string' && UUID.test(id.toLowerCase()) ? id.toLowerCase() : null;
};

// What one pass would do, from two reads of Staff-Auth taken confirmMs apart.
export function decide(users, staff, staffAgain, s, allowMass = false) {
  const linked = users.filter(subOf);
  const lockable = linked.filter(u => !s.exempt.includes(subOf(u)));
  const lock = [], unlock = [], exemptHits = [];
  for (const u of linked) {
    const sub = subOf(u);
    const active = staff.get(sub) === true, activeAgain = staffAgain.get(sub) === true;
    if (!active && !activeAgain && u.loginDisabled !== true) {
      if (s.exempt.includes(sub)) exemptHits.push(u);
      else lock.push(u);
    } else if (active && activeAgain && u.loginDisabled === true && u.loginDisabledReason === REASON) {
      unlock.push(u);
    }
  }
  let refused = null;
  if (!allowMass) {
    if (lock.length > s.maxLocks) refused = `${lock.length} accounts at once (limit ${s.maxLocks})`;
    else if (lock.length >= 2 && lock.length === lockable.length) refused = `every lockable account (${lock.length})`;
  }
  return { lock: refused ? [] : lock, unlock, refused, exemptHits, linked: linked.length };
}

export async function lockUser(users, u) {
  const r = await users.updateOne(
    { _id: u._id, 'services.oidc.id': u.services.oidc.id, loginDisabled: { $ne: true } },
    { $set: { loginDisabled: true, loginDisabledReason: REASON, 'services.resume.loginTokens': [] } });
  return r.modifiedCount === 1;
}

export async function unlockUser(users, u) {
  const r = await users.updateOne(
    { _id: u._id, 'services.oidc.id': u.services.oidc.id, loginDisabled: true, loginDisabledReason: REASON },
    { $set: { loginDisabled: false, inactivityClockStart: new Date() }, $unset: { loginDisabledReason: '' } });
  return r.modifiedCount === 1;
}

const PROJECTION = { username: 1, loginDisabled: 1, loginDisabledReason: 1, 'services.oidc.id': 1 };

// One pass. ctx: { users, readStaff(), s, version, write, note(key, msg), alert(msg), nudge(id), allowMass() }.
export async function runPass(ctx) {
  const { users, s } = ctx;
  const allowMass = ctx.allowMass ? ctx.allowMass() : false;
  const staff = await ctx.readStaff();
  const linked = await users.find({ 'services.oidc.id': { $exists: true } }, { projection: PROJECTION }).toArray();
  let d = decide(linked, staff, staff, s, allowMass);
  if (!d.lock.length && !d.unlock.length && !d.refused) return { ...d, done: [] };
  await sleep(s.confirmMs);
  const staffAgain = await ctx.readStaff();
  const fresh = await users.find({ 'services.oidc.id': { $exists: true } }, { projection: PROJECTION }).toArray();
  d = decide(fresh, staff, staffAgain, s, allowMass);
  const done = [];
  if (d.refused) {
    ctx.alert(`NOT locking ${d.refused}: looks like a restore or a broken read. Check by hand; if it is real, ` +
      `create ${s.massLockFile} (and remove it afterwards)`);
  }
  const reviewed = REVIEWED_WEKAN.includes(ctx.version);
  if ((d.lock.length || d.unlock.length) && !reviewed) {
    ctx.note('unreviewed', `WeKan ${ctx.version} is not in REVIEWED_WEKAN: watching only (would lock ${d.lock.length}, unlock ${d.unlock.length})`);
    return { ...d, done };
  }
  if (!ctx.write) return { ...d, done };
  for (const u of d.lock) {
    if (await lockUser(users, u)) {
      log(`locked WeKan account ${u.username} (${subOf(u)}): Staff-Auth account deactivated or deleted`);
      done.push(['lock', u.username]);
      if (ctx.nudge) {
        try {
          await ctx.nudge(u._id);
          log(`  WeKan disabled ${u.username} itself too: open sessions close within seconds`);
        } catch (e) {
          log(`  WeKan API nudge failed (${clean(e)}): ${u.username} is locked, open sessions close at WeKan's next poll`);
        }
      }
    }
  }
  for (const u of d.unlock) {
    if (await unlockUser(users, u)) { log(`unlocked WeKan account ${u.username} (${subOf(u)}): Staff-Auth account active again`); done.push(['unlock', u.username]); }
  }
  return { ...d, done };
}

// --- sign-out: Staff-Auth tokens Hydra no longer accepts ------------------------------------------------------
// true = active, false = inactive; throws on any doubt (network, non-200, malformed answer).
export async function introspect(s, token) {
  const r = await fetch(s.hydraAdmin + '/admin/oauth2/introspect', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (r.status !== 200) throw new Error('Hydra introspection: HTTP ' + r.status);
  const j = await r.json();
  if (typeof j?.active !== 'boolean') throw new Error('Hydra introspection: no active field');
  return j.active;
}

const SIGNOUT_PROJECTION = { username: 1, loginDisabled: 1, 'services.oidc.id': 1, 'services.oidc.accessToken': 1, 'services.resume.loginTokens': 1 };

// Which signed-in, enabled, linked accounts no longer hold a Staff-Auth token Hydra accepts.
export async function signOutCandidates(users, isActive) {
  const list = await users.find({ 'services.oidc.id': { $exists: true }, loginDisabled: { $ne: true },
    'services.resume.loginTokens.0': { $exists: true } }, { projection: SIGNOUT_PROJECTION }).toArray();
  const out = [];
  for (const u of list) {
    if (!subOf(u)) continue;
    const token = u.services?.oidc?.accessToken;
    if (typeof token !== 'string' || !token) { out.push({ u, token: null }); continue; }
    if (!(await isActive(token))) out.push({ u, token });
  }
  return out;
}

export async function signOutUser(users, u, token) {
  const filter = { _id: u._id, 'services.oidc.id': u.services.oidc.id, loginDisabled: { $ne: true },
    'services.oidc.accessToken': token === null ? { $exists: false } : token };
  const r = await users.updateOne(filter, { $set: { 'services.resume.loginTokens': [] } });
  return r.modifiedCount === 1;
}

// One sign-out pass: candidates confirmed by a second look confirmMs later. ctx as runPass, plus isActive(token).
export async function runSignOutPass(ctx) {
  const { users, s } = ctx;
  const first = await signOutCandidates(users, ctx.isActive);
  if (!first.length) return { signedOut: [], candidates: [] };
  await sleep(s.confirmMs);
  const again = await signOutCandidates(users, ctx.isActive);
  const confirmed = again.filter(c => first.some(f => f.u._id === c.u._id && f.token === c.token));
  const signedOut = [];
  if (!ctx.write || !REVIEWED_WEKAN.includes(ctx.version)) return { signedOut, candidates: confirmed };
  for (const { u, token } of confirmed) {
    if (await signOutUser(users, u, token)) {
      log(`signed out WeKan account ${u.username} (${subOf(u)}): ` +
        (token === null ? 'it had sessions but no Staff-Auth sign-in' : 'its Staff-Auth sign-in ended (logout, revocation or expiry)'));
      signedOut.push(u.username);
    }
  }
  return { signedOut, candidates: confirmed };
}

// --- staffauth-lockbot: a WeKan administrator with no password ------------------------------------------
// It cannot sign in anywhere. The service gives it a login token by writing the token's hash straight into
// the account (as Meteor itself stores them) and keeps the token in memory only; a new one replaces the old
// at every start, every 12 hours, and whenever WeKan answers 401/403. Without a password WeKan's 2FA
// requirement does not apply to it (models/lib/twoFactorRequirement.js: password sign-ins only).
const METEOR_ID = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
const meteorId = () => Array.from({ length: 17 }, () => METEOR_ID[randomInt(METEOR_ID.length)]).join('');
const BOT_FILTER = { username: BOT_USERNAME, trueogLockBot: true };

// Create the bot, or reset it (administrator, enabled, no password, no tokens). Returns its _id.
export async function provisionBot(users) {
  const existing = await users.findOne({ username: BOT_USERNAME });
  if (existing) {
    if (existing.trueogLockBot !== true) throw new Error(`a WeKan account named ${BOT_USERNAME} exists that this tool did not make`);
    await users.updateOne({ _id: existing._id }, {
      $set: { isAdmin: true, loginDisabled: false, 'services.resume.loginTokens': [], modifiedAt: new Date() },
      $unset: { loginDisabledReason: '', 'services.password': '' } });
    return existing._id;
  }
  const id = meteorId(), now = new Date();
  await users.insertOne({
    _id: id, createdAt: now, modifiedAt: now, username: BOT_USERNAME, trueogLockBot: true,
    emails: [{ address: 'staffauth-lockbot@wekan.invalid', verified: true }],
    services: { resume: { loginTokens: [] } },
    isAdmin: true, loginDisabled: false, authenticationMethod: 'password', teams: [], orgs: [],
    profile: { fullname: 'Staff-Auth lock bot (no password; used by trueog-wekan-authwatch)', initials: 'SA', boardView: 'board-view-swimlanes' },
  });
  return id;
}

export async function removeBot(users) {
  return (await users.deleteOne(BOT_FILTER)).deletedCount;
}

// A fresh login token for the bot (replacing any other); throws if the bot is missing or disabled.
export async function mintBotToken(users) {
  const token = randomBytes(32).toString('base64url');
  const hashedToken = createHash('sha256').update(token).digest('base64');
  const r = await users.updateOne({ ...BOT_FILTER, isAdmin: true, loginDisabled: { $ne: true } },
    { $set: { 'services.resume.loginTokens': [{ hashedToken, when: new Date() }] } });
  if (r.matchedCount !== 1) throw new Error(`WeKan account ${BOT_USERNAME} is missing, disabled or not an administrator (run the installer)`);
  return token;
}

async function http(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(5000), redirect: 'error' });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body };
}

export function makeRestClient(s, mint) {
  let token = null, mintedAt = 0;
  const fresh = async () => { token = await mint(); mintedAt = Date.now(); };
  const call = async (method, p, body) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token || Date.now() - mintedAt > 12 * 3600e3) await fresh();
      const r = await http(s.wekanUrl + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if ((r.status === 401 || r.status === 403) && attempt === 0) { token = null; continue; }
      if (r.status !== 200) throw new Error(`${method} ${p.replace(/[^/]+$/, ':id')}: HTTP ${r.status}`);
      return r.body;
    }
  };
  return {
    async disableLogin(id) {
      const b = await call('PUT', '/api/users/' + encodeURIComponent(id), { action: 'disableLogin' });
      if (b?.loginDisabled !== true) throw new Error('WeKan did not report the account disabled');
    },
    // Signs in with a new token and proves it is the bot and an administrator.
    async verify() {
      await fresh();
      const me = await call('GET', '/api/user');
      if (me?.username !== BOT_USERNAME || me?.isAdmin !== true) throw new Error('the token does not act as the admin bot');
    },
  };
}

async function main() {
  const s = settings();
  const args = process.argv.slice(2);
  const { MongoClient } = loadMongo(s.wekanHome);
  const client = new MongoClient(mongoUrl(s.envFile), { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const users = client.db().collection('users');
  const rest = makeRestClient(s, () => mintBotToken(users));

  if (args[0] === '--provision-bot') {
    const id = await provisionBot(users);
    await rest.verify();
    await users.updateOne({ _id: id }, { $set: { 'services.resume.loginTokens': [] } });
    await client.close();
    console.log(`${BOT_USERNAME} (${id}) is an administrator without a password and acts through the REST API`);
    console.log('WEKAN_LOCKBOT_OK');
    return;
  }
  if (args[0] === '--remove-bot') {
    console.log(`removed ${await removeBot(users)} account(s) named ${BOT_USERNAME} made by this tool`);
    await client.close();
    return;
  }

  const check = args.includes('--check');
  const seen = new Map();
  const note = (key, msg) => { if (seen.get(key) !== msg) { seen.set(key, msg); log(msg); } };
  const lastAlert = new Map();
  const alert = (msg, key = 'refused') => {
    if (Date.now() - (lastAlert.get(key) || 0) >= 600000) { lastAlert.set(key, Date.now()); log('ALERT ' + msg); }
  };
  let nudgeOn = false;
  try { await rest.verify(); nudgeOn = true; } catch (e) { note('bot', `WeKan API nudge unavailable (${clean(e)}): open sessions close at WeKan's next poll`); }
  const ctx = {
    users, s, write: !check, note, alert, version: wekanVersion(s.wekanHome),
    readStaff: () => readStaffViaPsql(s),
    nudge: id => rest.disableLogin(id),
    allowMass: () => fs.existsSync(s.massLockFile),
    isActive: token => introspect(s, token),
  };

  if (check) {
    let refusedMsg = null;
    ctx.alert = m => { refusedMsg = m; };
    const r = await runPass(ctx);
    const so = await runSignOutPass(ctx);
    const exemptNames = (await users.find({ 'services.oidc.id': { $exists: true } }, { projection: PROJECTION }).toArray())
      .filter(u => s.exempt.includes(subOf(u))).map(u => u.username);
    await users.updateOne(BOT_FILTER, { $set: { 'services.resume.loginTokens': [] } });
    console.log(`WeKan ${ctx.version} (${REVIEWED_WEKAN.includes(ctx.version) ? 'reviewed' : 'NOT reviewed: watch only'}), ` +
      `${r.linked} linked accounts, exempt [${exemptNames}], would lock [${r.lock.map(u => u.username)}], unlock [${r.unlock.map(u => u.username)}]` +
      (refusedMsg ? `, refused: ${r.refused}` : '') + (r.exemptHits.length ? `, exempt and inactive: [${r.exemptHits.map(u => u.username)}]` : '') +
      (ctx.allowMass() ? ', MASS-LOCK GUARD OFF' : '') + `, would sign out [${so.candidates.map(c => c.u.username)}]` +
      `, API: ${nudgeOn ? 'bot signs in' : 'bot UNAVAILABLE'}`);
    await client.close();
    console.log('WEKAN_AUTHWATCH_CHECK_OK');
    return;
  }

  let stopping = false, wake = null;
  const pause = ms => stopping ? Promise.resolve() : new Promise(r => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; if (wake) wake(); });
  const own = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
  log(`started version=${own} : WeKan ${ctx.version}${REVIEWED_WEKAN.includes(ctx.version) ? '' : ' (not reviewed: watch only)'}, ` +
    `exempt [${s.exempt}], API nudge ${nudgeOn ? 'on' : 'OFF'}`);
  let backoff = 0, lastLinked = -1, lastSignOut = 0;
  while (!stopping) {
    try {
      ctx.version = wekanVersion(s.wekanHome);
      if (Date.now() - lastSignOut >= s.signOutEveryMs) { lastSignOut = Date.now(); await runSignOutPass(ctx); }
      if (ctx.allowMass()) alert(`${s.massLockFile} exists: the mass-lock guard is OFF; remove the file when done`, 'massfile');
      const r = await runPass(ctx);
      if (r.linked !== lastLinked) { log(`watching ${r.linked} linked WeKan accounts`); lastLinked = r.linked; }
      for (const u of r.exemptHits) note('exempt:' + subOf(u), `exempt account ${u.username}: its Staff-Auth account is deactivated or deleted; not locked`);
      if (!r.refused) lastAlert.delete('refused');
      if (backoff) { log('recovered'); seen.delete('error'); }
      backoff = 0;
      await pause(s.intervalMs);
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : 1000, 30000);
      note('error', `pass failed, nothing changed: ${clean(e)} (retrying, backoff up to 30 s)`);
      await pause(backoff);
    }
  }
  log('stopping');
  await users.updateOne(BOT_FILTER, { $set: { 'services.resume.loginTokens': [] } }).catch(() => {});
  await client.close().catch(() => {});
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { log('fatal:', clean(e)); process.exit(1); });
}

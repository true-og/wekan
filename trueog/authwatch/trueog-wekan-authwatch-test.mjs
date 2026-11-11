#!/usr/bin/env node
// Tests for trueog-wekan-authwatch. Run as root from /:
//   /home/system/.nvm/versions/node/v26.13.0/bin/node /home/system/gitea-upgrade/trueog-wekan-authwatch-test.mjs
// Uses a scratch FerretDB database (wekan_authwatch_test, dropped at the end) through WeKan's own driver and
// MONGO_URL, and a scratch PostgreSQL database (wekan_authwatch_test, dropped at the end) for the psql path.
// The live WeKan and Staff-Auth databases are never written.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const W = await import(path.join(here, 'trueog-wekan-authwatch.mjs'));

let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.log('FAIL', name); } };

const s = { ...W.settings({}), confirmMs: 20, exempt: [] };
const live = W.mongoUrl('/opt/wekan/wekan.env');
const u = new URL(live);
if (u.pathname.replace(/^\//, '') === 'wekan_authwatch_test') throw new Error('refusing');
u.pathname = '/wekan_authwatch_test';
const { MongoClient } = W.loadMongo('/opt/wekan');
const client = new MongoClient(u.toString(), { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db();
if (db.databaseName !== 'wekan_authwatch_test') throw new Error('wrong scratch db ' + db.databaseName);
await db.dropDatabase();
const users = db.collection('users');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tok = [{ hashedToken: 'x', when: new Date() }];
async function reset(docs) {
  await users.deleteMany({});
  await users.insertMany(docs.map(d => ({ services: { resume: { loginTokens: tok } }, ...d })));
}
const user = (name, n, extra = {}) => ({ _id: name, username: name, services: { oidc: { id: id(n) }, resume: { loginTokens: tok } }, ...extra });
const staffMap = entries => new Map(entries.map(([n, active]) => [id(n), active]));
const nudged = [];
const ctxWith = (staffSeq, over = {}) => {
  let i = 0;
  const notes = [];
  return {
    users, s: over.s || s, write: true, version: '13.06', notes,
    readStaff: async () => { const v = staffSeq[Math.min(i++, staffSeq.length - 1)]; if (v instanceof Error) throw v; return v; },
    note: (k, m) => notes.push(k + ': ' + m), alert: m => notes.push('refused: ' + m),
    nudge: async id => { nudged.push(id); }, ...over,
  };
};
const get = name => users.findOne({ _id: name });

// 1 active, untouched
await reset([user('a', 1), user('b', 2), user('owner', 9)]);
let r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [9, true]])]));
ok(r.done.length === 0 && !(await get('a')).loginDisabled, 'active accounts untouched');

// 2 deactivated -> locked, tokens cleared, reason set
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true], [9, true]])]));
let a = await get('a');
ok(a.loginDisabled === true && a.loginDisabledReason === 'staff-auth' && a.services.resume.loginTokens.length === 0, 'deactivated -> locked, tokens cleared');
ok((await get('b')).services.resume.loginTokens.length === 1, 'other account keeps its tokens');
ok(a.services.oidc.id === id(1) && a.username === 'a', 'nothing else changed on the locked account');

// 3 reactivated -> unlocked, reason gone
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [9, true]])]));
a = await get('a');
ok(a.loginDisabled === false && a.loginDisabledReason === undefined, 'reactivated -> unlocked');

// 4 deleted (missing from Staff-Auth) -> locked
r = await W.runPass(ctxWith([staffMap([[2, true], [9, true]])]));
ok((await get('a')).loginDisabled === true, 'deleted -> locked');

// 5 transient: deactivated on first read, active on the confirming read -> nothing
await reset([user('a', 1), user('b', 2), user('owner', 9)]);
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true], [9, true]]), staffMap([[1, true], [2, true], [9, true]])]));
ok(!(await get('a')).loginDisabled, 'not confirmed -> not locked');

// 6 exempt owner deactivated -> not locked, reported (exempt by Staff-Auth uuid, any username)
s.exempt = [id(9)];
await users.updateOne({ _id: 'owner' }, { $set: { username: 'Renamed' } });
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [9, false]])]));
ok(!(await get('owner')).loginDisabled && r.exemptHits.length === 1, 'exempt account never locked');

// 7 disabled by someone else, Staff-Auth active -> stays disabled; deactivated -> untouched
await reset([user('a', 1, { loginDisabled: true, loginDisabledReason: 'inactive' }), user('b', 2, { loginDisabled: true }), user('c', 3)]);
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [3, true]])]));
ok((await get('a')).loginDisabled === true && (await get('a')).loginDisabledReason === 'inactive' && (await get('b')).loginDisabled === true, 'other disables never undone');
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true], [3, true]])]));
ok((await get('a')).loginDisabledReason === 'inactive' && (await get('a')).services.resume.loginTokens.length === 1, 'already disabled account untouched');

// 8 mass: three at once -> refused
await reset([user('a', 1), user('b', 2), user('c', 3), user('d', 4), user('owner', 9)]);
let ctx = ctxWith([staffMap([[4, true], [9, true]])]);
r = await W.runPass(ctx);
ok(r.refused && !(await get('a')).loginDisabled && !(await get('c')).loginDisabled && ctx.notes.some(n => n.startsWith('refused')), 'three at once refused');

// 9 every lockable account (2 of 2) -> refused; 1 of 2 -> allowed
await reset([user('a', 1), user('b', 2), user('owner', 9)]);
r = await W.runPass(ctxWith([staffMap([[9, true], [5, true]])]));
ok(r.refused && !(await get('a')).loginDisabled, 'every lockable account refused');
r = await W.runPass(ctxWith([staffMap([[1, true], [9, true]])]));
ok((await get('b')).loginDisabled === true && !r.refused, 'one of two allowed');

// 10 read error -> throws, nothing changed
await reset([user('a', 1), user('b', 2)]);
let threw = false;
try { await W.runPass(ctxWith([new Error('db down')])); } catch { threw = true; }
ok(threw && !(await get('a')).loginDisabled, 'read error changes nothing');
threw = false;
try { await W.runPass(ctxWith([staffMap([[1, false], [2, true]]), new Error('db down')])); } catch { threw = true; }
ok(threw && !(await get('a')).loginDisabled, 'error on the confirming read changes nothing');

// 11 unreviewed WeKan version -> watch only
ctx = ctxWith([staffMap([[1, false], [2, true]])], { version: '13.99' });
r = await W.runPass(ctx);
ok(!(await get('a')).loginDisabled && ctx.notes.some(n => n.startsWith('unreviewed')), 'unreviewed version watches only');
ctx = ctxWith([staffMap([[1, false], [2, true]])], { version: null });
r = await W.runPass(ctx);
ok(!(await get('a')).loginDisabled, 'unknown version watches only');

// 12 --check style (write false) -> nothing written
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true]])], { write: false }));
ok(r.lock.length === 1 && !(await get('a')).loginDisabled, 'dry run writes nothing');

// 13 accounts without Staff-Auth link or with a malformed id are ignored
await reset([{ _id: 'local', username: 'local' }, { _id: 'bad', username: 'bad', services: { oidc: { id: 'not-a-uuid' } } }, user('a', 1), user('b', 2)]);
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true]])]));
ok(!(await get('local')).loginDisabled && !(await get('bad')).loginDisabled && r.linked === 2, 'unlinked and malformed ignored');

// 14 upper-case uuid in WeKan matches Staff-Auth's lower-case
await reset([user('a', 1), user('b', 2)]);
await users.updateOne({ _id: 'a' }, { $set: { 'services.oidc.id': id(1).toUpperCase() } });
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true]])]));
ok(!(await get('a')).loginDisabled, 'upper-case id treated as the same subject');

// 18 nudge: called once per lock, never for unlocks; its failure keeps the lock
await reset([user('a', 1), user('b', 2), user('owner', 9)]);
nudged.length = 0;
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true], [9, true]])]));
ok(nudged.length === 1 && nudged[0] === 'a', 'nudge called for the locked account');
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [9, true]])]));
ok(nudged.length === 1, 'no nudge on unlock');
a = await get('a');
ok(a.inactivityClockStart instanceof Date, 'unlock restarts the inactivity clock');
r = await W.runPass(ctxWith([staffMap([[1, false], [2, true], [9, true]])], { nudge: async () => { throw new Error('HTTP 500'); } }));
ok((await get('a')).loginDisabled === true && r.done.length === 1, 'failed nudge keeps the lock');
r = await W.runPass(ctxWith([staffMap([[1, true], [2, true], [9, true]])], { nudge: null }));
ok((await get('a')).loginDisabled === false, 'works without a nudge');

// 19 mass-lock override file
await reset([user('a', 1), user('b', 2), user('c', 3), user('owner', 9)]);
r = await W.runPass(ctxWith([staffMap([[9, true]])], { allowMass: () => true }));
ok(!r.refused && (await get('a')).loginDisabled && (await get('c')).loginDisabled, 'override lets a mass lock through');

// 20 clean() blanks connection strings and long tokens
ok(!W.clean(new Error('connect mongodb://' + 'u:p' + '@h:1/db failed')).includes('u:' + 'p') && !W.clean('x ' + 'A'.repeat(40)).includes('AAAA'), 'clean redacts');

// 21 the password-less bot on the scratch database (no REST here)
await users.deleteMany({});
const botId = await W.provisionBot(users);
let bot = await users.findOne({ _id: botId });
ok(bot.isAdmin === true && bot.trueogLockBot === true && !bot.services.password && bot.loginDisabled === false, 'bot: admin, marked, no password');
const tk = await W.mintBotToken(users);
bot = await users.findOne({ _id: botId });
const sha64 = (await import('node:crypto')).createHash('sha256').update(tk).digest('base64');
ok(bot.services.resume.loginTokens.length === 1 && bot.services.resume.loginTokens[0].hashedToken === sha64, 'minted token stored as Meteor hashes it');
const tk2 = await W.mintBotToken(users);
bot = await users.findOne({ _id: botId });
ok(tk2 !== tk && bot.services.resume.loginTokens.length === 1, 'a new token replaces the old one');
await users.updateOne({ _id: botId }, { $set: { loginDisabled: true, 'services.password': { bcrypt: 'x' } } });
threw = false; try { await W.mintBotToken(users); } catch { threw = true; } ok(threw, 'no token for a disabled bot');
ok(await W.provisionBot(users) === botId, 'reprovision keeps the account');
bot = await users.findOne({ _id: botId });
ok(bot.loginDisabled === false && !bot.services.password && bot.services.resume.loginTokens.length === 0, 'reprovision re-enables, drops any password and tokens');
await users.deleteOne({ _id: botId });
await users.insertOne({ _id: 'imposter', username: W.BOT_USERNAME, isAdmin: true, profile: { trueogLockBot: true } });
threw = false; try { await W.provisionBot(users); } catch { threw = true; } ok(threw, 'refuses an account it did not make');
threw = false; try { await W.mintBotToken(users); } catch { threw = true; } ok(threw, 'no token for an account it did not make');
ok(await W.removeBot(users) === 0 && await users.findOne({ _id: 'imposter' }), 'remove leaves a foreign account alone');
await users.deleteOne({ _id: 'imposter' });
await W.provisionBot(users);
ok(await W.removeBot(users) === 1 && !(await users.findOne({ username: W.BOT_USERNAME })), 'remove deletes the bot');

// 22 sign-out: inactive Staff-Auth token ends WeKan sessions (not a lock); fresh sign-in wins; errors change nothing
await users.deleteMany({});
const withTok = (name, n, token, extra = {}) => ({ _id: name, username: name,
  services: { oidc: { id: id(n), ...(token ? { accessToken: token } : {}) }, resume: { loginTokens: tok } }, ...extra });
await users.insertMany([withTok('a', 1, 'T-a'), withTok('b', 2, 'T-b'), withTok('nt', 3, null),
  withTok('off', 4, 'T-off', { loginDisabled: true }), { _id: 'local', username: 'local', services: { resume: { loginTokens: tok } } },
  { ...withTok('idle', 5, 'T-idle'), services: { oidc: { id: id(5), accessToken: 'T-idle' }, resume: { loginTokens: [] } } }]);
const activeSet = new Set(['T-b']);
const soCtx = (over = {}) => ({ users, s, write: true, version: '13.06', isActive: async tk => activeSet.has(tk), ...over });
let so = await W.runSignOutPass(soCtx());
const tokensOf = async n => (await get(n)).services.resume.loginTokens.length;
ok(so.signedOut.sort().join() === 'a,nt', 'signs out inactive-token and no-token accounts');
ok(await tokensOf('a') === 0 && await tokensOf('nt') === 0 && (await get('a')).loginDisabled !== true, 'sessions cleared, account not disabled');
ok(await tokensOf('b') === 1 && await tokensOf('off') === 1 && await tokensOf('local') === 1, 'active, disabled and unlinked accounts untouched');
ok((await get('a')).services.oidc.accessToken === 'T-a', 'stored token kept');
// a fresh sign-in between the look and the write wins
await users.updateOne({ _id: 'a' }, { $set: { 'services.resume.loginTokens': tok } });
let calls = 0;
so = await W.runSignOutPass(soCtx({ isActive: async tk => { calls++; if (calls === 2) await users.updateOne({ _id: 'a' }, { $set: { 'services.oidc.accessToken': 'T-new' } }); return tk === 'T-new' || activeSet.has(tk); } }));
ok(await tokensOf('a') === 1, 'fresh sign-in during the check is not signed out');
// introspection error: nothing changes
await users.updateOne({ _id: 'a' }, { $set: { 'services.oidc.accessToken': 'T-a' } });
threw = false; try { await W.runSignOutPass(soCtx({ isActive: async () => { throw new Error('hydra down'); } })); } catch { threw = true; }
ok(threw && await tokensOf('a') === 1, 'Hydra error changes nothing');
// not confirmed on the second look (became active again): nothing
let flip = 0;
so = await W.runSignOutPass(soCtx({ isActive: async tk => tk === 'T-a' ? (flip++ > 0) : activeSet.has(tk) }));
ok(await tokensOf('a') === 1, 'not confirmed -> not signed out');
// dry run and unreviewed version write nothing
so = await W.runSignOutPass(soCtx({ write: false }));
ok(so.candidates.length === 1 && await tokensOf('a') === 1, 'dry run writes nothing');
so = await W.runSignOutPass(soCtx({ version: '13.99' }));
ok(await tokensOf('a') === 1, 'unreviewed version writes nothing');
// introspect() against a stand-in Hydra
const http = await import('node:http');
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const tk = new URLSearchParams(b).get('token');
  if (tk === 'boom') { res.writeHead(500); return res.end('x'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(tk === 'odd' ? {} : { active: tk === 'good' })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const hs = { ...s, hydraAdmin: 'http://127.0.0.1:' + srv.address().port };
ok(await W.introspect(hs, 'good') === true && await W.introspect(hs, 'bad') === false, 'introspect active/inactive');
for (const bad of ['boom', 'odd']) { threw = false; try { await W.introspect(hs, bad); } catch { threw = true; } ok(threw, 'introspect throws on ' + bad); }
srv.close();

// 15 parseStaff
ok(W.parseStaff(`${id(1)}\tf\n${id(2)}\tt\n`).get(id(2)) === false, 'parseStaff t/f');
for (const [bad, name] of [['', 'empty'], [`${id(1)}\tx\n`, 'bad flag'], [`nope\tf\n`, 'bad uuid'], [`${id(1)}\tf\textra\n`, 'extra column']]) {
  let t = false; try { W.parseStaff(bad); } catch { t = true; } ok(t, 'parseStaff rejects ' + name);
}

// 16 mongoUrl parsing
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wauth-'));
const envf = path.join(tmp, 'e');
for (const [text, want] of [["export MONGO_URL='mongodb://x/y'\n", 'mongodb://x/y'], ['export MONGO_URL="mongodb://x/z"\n', 'mongodb://x/z'], ['export MONGO_URL=mongodb://x/w\n', 'mongodb://x/w']]) {
  fs.writeFileSync(envf, '# c\nexport A=1\n' + text); ok(W.mongoUrl(envf) === want, 'mongoUrl ' + want);
}
fs.writeFileSync(envf, 'export MONGO_URL=http://x\n'); { let t = false; try { W.mongoUrl(envf); } catch { t = true; } ok(t, 'mongoUrl rejects non-mongodb'); }

if (process.getuid() === 0) {
// 17 real psql path against a scratch PostgreSQL database
const pg = (sql, db = 'postgres') => spawnSync('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
pg('drop database if exists wekan_authwatch_test');
ok(pg('create database wekan_authwatch_test').status === 0, 'scratch pg created');
pg(`create table users (id serial, uuid uuid not null, deactivated boolean not null, totp_secret text); insert into users (uuid, deactivated, totp_secret) values ('${id(1)}', false, 'S'), ('${id(2)}', true, 'S')`, 'wekan_authwatch_test');
const wrapper = path.join(tmp, 'psql');
fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/sbin/runuser -u postgres -- /usr/bin/psql "$@"\n', { mode: 0o755 });
const ps = { ...s, psql: wrapper, pgConninfo: 'dbname=wekan_authwatch_test' };
const staff = await W.readStaffViaPsql(ps);
ok(staff.get(id(1)) === true && staff.get(id(2)) === false && staff.size === 2, 'psql read');
threw = false; try { await W.readStaffViaPsql({ ...ps, pgConninfo: 'dbname=does_not_exist_x' }); } catch { threw = true; } ok(threw, 'psql error throws');
pg('delete from users', 'wekan_authwatch_test');
threw = false; try { await W.readStaffViaPsql(ps); } catch { threw = true; } ok(threw, 'empty Staff-Auth throws');
// column grant: a role with SELECT on uuid, deactivated only can run the query but not read totp_secret
pg(`drop role if exists wekan_authwatch_t; create role wekan_authwatch_t; grant select (uuid, deactivated) on users to wekan_authwatch_t; insert into users (uuid, deactivated) values ('${id(1)}', false)`, 'wekan_authwatch_test');
ok(pg('set role wekan_authwatch_t; select uuid, deactivated from users', 'wekan_authwatch_test').status === 0, 'column grant allows the query');
ok(pg('set role wekan_authwatch_t; select totp_secret from users', 'wekan_authwatch_test').status !== 0, 'column grant hides other columns');
pg('drop database wekan_authwatch_test'); pg('drop role wekan_authwatch_t');

} else {
  console.log('psql section skipped (needs root for scratch PostgreSQL)');
}

await db.dropDatabase();
await client.close();
fs.rmSync(tmp, { recursive: true });
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

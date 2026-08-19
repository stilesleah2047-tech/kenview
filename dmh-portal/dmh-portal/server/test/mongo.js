'use strict';

/**
 * Verifies the MongoDB code path without a MongoDB.
 *
 * A stub driver stands in for the real one and records every call, so we can
 * check that the store issues the right filters, upserts on the right natural
 * keys, and creates the indexes that make re-imports idempotent. The stub
 * implements enough of the driver surface to run the store for real.
 */

process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32chars';

const Module = require('module');
const path = require('path');

const calls = [];
const collections = new Map();

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
}

function fakeCollection(name) {
  if (!collections.has(name)) collections.set(name, { docs: [], indexes: [] });
  const c = collections.get(name);
  return {
    async createIndex(spec, opts) { c.indexes.push({ spec, opts }); },
    find(filter = {}) {
      return { async toArray() {
        calls.push([name, 'find', filter]);
        return c.docs.filter(d => matches(d, filter)).map(d => Object.assign({ _id: 'x' }, d));
      } };
    },
    async findOne(filter) {
      calls.push([name, 'findOne', filter]);
      const d = c.docs.find(d => matches(d, filter));
      return d ? Object.assign({ _id: 'x' }, d) : null;
    },
    async updateOne(filter, update, opts = {}) {
      calls.push([name, 'updateOne', filter, opts]);
      const i = c.docs.findIndex(d => matches(d, filter));
      if (i > -1) {
        Object.assign(c.docs[i], update.$set || {});
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      c.docs.push(Object.assign({}, filter, update.$setOnInsert || {}, update.$set || {}));
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
    async deleteOne(filter) {
      calls.push([name, 'deleteOne', filter]);
      const i = c.docs.findIndex(d => matches(d, filter));
      if (i > -1) c.docs.splice(i, 1);
      return { deletedCount: i > -1 ? 1 : 0 };
    },
    async deleteMany(filter) {
      calls.push([name, 'deleteMany', filter]);
      const before = c.docs.length;
      c.docs = c.docs.filter(d => !matches(d, filter));
      return { deletedCount: before - c.docs.length };
    },
    async bulkWrite(ops) {
      calls.push([name, 'bulkWrite', ops.length]);
      let upserted = 0, modified = 0;
      for (const op of ops) {
        const { filter, update, upsert } = op.updateOne;
        const i = c.docs.findIndex(d => matches(d, filter));
        if (i > -1) { Object.assign(c.docs[i], update.$set || {}); modified++; }
        else if (upsert) { c.docs.push(Object.assign({}, filter, update.$set || {})); upserted++; }
      }
      return { upsertedCount: upserted, modifiedCount: modified };
    },
  };
}

// Intercept require('mongodb') for this process only.
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongodb') {
    return {
      MongoClient: class {
        constructor(uri, opts) { calls.push(['client', 'new', uri, opts]); }
        async connect() { calls.push(['client', 'connect']); }
        async close() { calls.push(['client', 'close']); }
        db(name) {
          calls.push(['client', 'db', name]);
          return { collection: fakeCollection, async command(c) { calls.push(['db', 'command', c]); return { ok: 1 }; } };
        }
      },
    };
  }
  return realLoad(request, parent, isMain);
};

const { mongoStore, mongoHint } = require(path.resolve(__dirname, '..', 'src', 'store'));
const { handle } = require(path.resolve(__dirname, '..', 'src', 'api'));
const { seedIfEmpty } = require(path.resolve(__dirname, '..', 'src', 'seed'));

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? ' — ' + extra : ''));
};

(async () => {
  const store = mongoStore('mongodb://127.0.0.1:27017', 'dmh_test');
  await store.init();

  ok('the driver is asked for a connection', calls.some(c => c[0] === 'client' && c[1] === 'connect'));
  ok('the server is pinged before use', calls.some(c => c[1] === 'command' && c[2].ping === 1));
  ok('the configured database name is used',
    calls.some(c => c[1] === 'db' && c[2] === 'dmh_test'));

  const idx = name => collections.get(name).indexes;
  ok('client codes are unique',
    idx('clients').some(i => i.spec.code === 1 && i.opts.unique));
  ok('user emails are unique',
    idx('users').some(i => i.spec.email === 1 && i.opts.unique));
  ok('campaign IDs are unique',
    idx('campaigns').some(i => i.spec.campaignId === 1 && i.opts.unique));
  ok('one delivery row per campaign per day is enforced by index',
    idx('actuals').some(i => i.spec.campaignId === 1 && i.spec.date === 1 && i.opts.unique));
  ok('campaigns are indexed by client for per-client reads',
    idx('campaigns').some(i => i.spec.clientCode === 1));

  // seed + full round trip through the real API
  const seeded = await seedIfEmpty(store);
  ok('the first administrator is created in the database', !!seeded && !!seeded.password);

  const call = (action, body) => handle(store, Object.assign({ action }, body));
  const admin = await call('login', { email: seeded.email, password: seeded.password });
  ok('that administrator can sign in against MongoDB', admin.ok === true);
  const A = { token: admin.token };

  await call('admin.saveClient', Object.assign({ id: 'KCB', name: 'KCB Group', budget: 42000 }, A));
  await call('admin.saveClient', Object.assign({ id: 'SAF', name: 'Safaricom PLC', budget: 68000 }, A));
  ok('clients round-trip through the driver', (await call('admin.clients', A)).clients.length === 2);

  await call('admin.saveCampaign', Object.assign({
    clientId: 'KCB', campaignId: '41040', name: 'Common_Cents', billing: 'cpm',
    rate: 1.5, ctr: 0.0336, budget: 42000, startDate: '2026-08-01', endDate: '2026-08-31',
  }, A));
  await call('admin.saveCampaign', Object.assign({
    clientId: 'SAF', campaignId: '39210', name: 'Positioning', billing: 'cpi',
    rate: 0.42, ctr: 0.041, convRate: 0.1, budget: 10000,
    startDate: '2026-08-01', endDate: '2026-08-20',
  }, A));

  await call('admin.saveUser', Object.assign({
    email: 'sarah@kcb.co.ke', name: 'Sarah W.', clientId: 'KCB', password: 'kcb-test-pass',
  }, A));
  const sarah = await call('login', { email: 'sarah@kcb.co.ke', password: 'kcb-test-pass' });

  const kcb = await call('data', { token: sarah.token, clientId: 'KCB' });
  ok('a client sees only their own campaigns from the database',
    kcb.campaigns.length === 1 && kcb.campaigns[0].id === 41040);
  ok('the projection is stored and returned', kcb.campaigns[0].plan.length === 31);
  // The isolation is in the query, not a filter applied after reading everything.
  ok('a client read is scoped by clientCode in the query itself',
    calls.some(c => c[0] === 'campaigns' && c[1] === 'find' && c[2].clientCode === 'KCB'));
  ok('and delivery is read the same way',
    calls.some(c => c[0] === 'actuals' && c[1] === 'find' && c[2].clientCode === 'KCB'));

  let denied = false;
  try { await call('data', { token: sarah.token, clientId: 'SAF' }); } catch (e) { denied = true; }
  ok('another client is refused at the query layer', denied);

  // delivery import, twice
  await call('admin.importActuals', Object.assign({ rows: [
    { campaignId: '41040', date: '2026-08-01', impressions: 640000, clicks: 21100, spend: 960, downloads: 0 },
    { campaignId: '41040', date: '2026-08-02', impressions: 655000, clicks: 22400, spend: 982.5, downloads: 0 },
  ] }, A));
  ok('delivery is written in one bulk operation',
    calls.some(c => c[0] === 'actuals' && c[1] === 'bulkWrite' && c[2] === 2));

  await call('admin.importActuals', Object.assign({ rows: [
    { campaignId: '41040', date: '2026-08-01', impressions: 641000, clicks: 21150, spend: 961.5, downloads: 0 },
  ] }, A));
  const after = await call('data', { token: sarah.token, clientId: 'KCB' });
  ok('re-importing a day corrects it instead of duplicating',
    after.campaigns[0].rows.length === 2 && after.campaigns[0].rows[0][1] === 641000,
    after.campaigns[0].rows.length + ' rows');
  ok('the projection is untouched by an import', after.campaigns[0].plan.length === 31);

  // deleting a campaign takes its delivery with it
  await call('admin.deleteCampaign', Object.assign({ campaignId: '41040' }, A));
  ok('deleting a campaign also clears its delivery rows',
    calls.some(c => c[0] === 'actuals' && c[1] === 'deleteMany' && c[2].campaignId === '41040'));

  await store.close();
  ok('the connection is closed on shutdown', calls.some(c => c[0] === 'client' && c[1] === 'close'));

  /* ── the messages someone actually sees when it will not connect ── */
  const hint = (msg, uri) => mongoHint(new Error(msg), uri);
  ok('a bad password explains where to look',
    /username or password/i.test(hint('Authentication failed.', 'mongodb+srv://a:b@c.mongodb.net')));
  ok('a bad password mentions percent-encoding',
    /percent-encoded/i.test(hint('bad auth : authentication failed', 'mongodb+srv://a:b@c.mongodb.net')));
  ok('a timeout on Atlas points at the IP allowlist',
    /allowlist/i.test(hint('Server selection timed out after 8000 ms', 'mongodb+srv://a:b@c.mongodb.net')));
  ok('a refused local connection suggests starting MongoDB',
    /systemctl start mongod/.test(hint('connect ECONNREFUSED 127.0.0.1:27017', 'mongodb://127.0.0.1:27017')));
  ok('an unresolvable host says to recopy the string',
    /does not resolve/i.test(hint('getaddrinfo ENOTFOUND cluster0.typo.net', 'mongodb+srv://a:b@cluster0.typo.net')));
  ok('a malformed URI says what it must start with',
    /must start with mongodb/i.test(hint('Invalid scheme, expected connection string', 'http://localhost')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

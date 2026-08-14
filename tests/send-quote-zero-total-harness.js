#!/usr/bin/env node
'use strict';

/**
 * Regression cover for the 2026-08 field report (job SWF-261202): a fully
 * scoped, approved quote could not be sent. The send flow reserved a quote
 * number (Q-0617), generated + uploaded the PDF/web quote, then failed with
 *   "Quote total is zero or missing. Set pricing on the job in the scoping
 *    tool before sending."
 * while the Quotes view showed the correct $8,803 total.
 *
 * ROOT CAUSE (confirmed against production data):
 *   - The server send gate (`quotePricingGateError` in the send-quote edge
 *     function) validates jobs.pricing_json.totalIncGST — the SERVER-persisted
 *     pricing, NOT the client payload.
 *   - After a session eviction right after the job was minted, the minted job
 *     row carried scope_json = {} and pricing_json = {} (verified: the single
 *     jobs row for SWF-261202 had updated_at == created_at — no scope save ever
 *     landed).
 *   - The client-rendered PDF/HTML (built from the in-memory scope) still showed
 *     $8,803, masking the empty server row — hence the contradiction.
 *
 * FIX: `app._ensureServerPricingBeforeSend(jobId)` gates the send BEFORE any
 * quote number is reserved: local pricing must be non-zero, the server row must
 * carry a non-zero total, and if it doesn't the current scope+pricing is pushed
 * via the existing save path and re-verified — otherwise the send stops cleanly
 * instead of burning a quote number on a scope the server rejects.
 *
 * This harness runs the REAL guard body extracted from index.html against stubs.
 * No network, no real Supabase.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function sliceBlock(source, start) {
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('could not slice block');
}

// ── Extract the REAL guard body from index.html ──
const SIGNATURE = 'app._ensureServerPricingBeforeSend = async function(jobId) {';
const sigStart = indexSource.indexOf(SIGNATURE);
assert(sigStart >= 0, 'app._ensureServerPricingBeforeSend exists in index.html');
const fnBodyStart = sigStart + SIGNATURE.length - 1; // point at the opening brace
const fnBlock = sliceBlock(indexSource, fnBodyStart);
const guardBody = fnBlock.slice(fnBlock.indexOf('{') + 1, fnBlock.lastIndexOf('}'));

// Build an `app` with the real guard bound, over an injectable environment.
function buildApp(env) {
  const app = {
    job: { _pricing_json: null },
    buildPricingJson() { return env.localPricing; },
  };
  const sandbox = {
    window: { app, SECUREWORKS_CLOUD: env.cloud, _swIntegration: env.integration },
    console: { warn() {}, log() {}, error() {} },
    JSON, String, Object, Error, Number, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `window.app._ensureServerPricingBeforeSend = async function(jobId) {${guardBody}};`,
    sandbox
  );
  return app;
}

// A cloud stub whose loadJob reflects a mutable server-side pricing_json store,
// so a save can flip the server total between reads.
function makeCloud(serverStore) {
  return {
    ghl: {
      async loadJob() { return { id: serverStore.jobId, pricing_json: serverStore.pricing_json }; },
    },
  };
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.error('  ✗', name, '\n     ', e.message); }
}

(async function run() {
  console.log('send-quote zero-total guard');

  // Case A — server already carries the correct total: happy path, no resave.
  await test('passes when server pricing_json already has a non-zero total', async () => {
    const server = { jobId: 'job-1', pricing_json: { totalIncGST: 8803 } };
    let saveCalls = 0;
    const app = buildApp({
      localPricing: { totalIncGST: 8803 },
      cloud: makeCloud(server),
      integration: { async save() { saveCalls++; } },
    });
    const res = await app._ensureServerPricingBeforeSend('job-1');
    assert.strictEqual(res.ok, true, 'guard should allow the send');
    assert.strictEqual(saveCalls, 0, 'no resave when server is already priced');
  });

  // Case B — the SWF-261202 shape: server row is {} but a save DOES persist.
  await test('resyncs then passes when server pricing is empty but save lands', async () => {
    const server = { jobId: 'job-2', pricing_json: {} }; // empty {} — like SWF-261202
    const app = buildApp({
      localPricing: { totalIncGST: 8803 },
      cloud: makeCloud(server),
      integration: {
        // Simulate a successful save writing the pricing to the server row.
        async save() { server.pricing_json = { totalIncGST: 8803 }; },
      },
    });
    const res = await app._ensureServerPricingBeforeSend('job-2');
    assert.strictEqual(res.ok, true, 'guard should allow the send after resync');
    assert.strictEqual(res.resynced, true, 'guard should report it resynced');
  });

  // Case C — session truly lost: save cannot land, server stays {}. Must STOP.
  await test('stops with an actionable message when the resave cannot land', async () => {
    const server = { jobId: 'job-3', pricing_json: {} };
    const app = buildApp({
      localPricing: { totalIncGST: 8803 },
      cloud: makeCloud(server),
      integration: { async save() { /* queued locally — server unchanged */ } },
    });
    const res = await app._ensureServerPricingBeforeSend('job-3');
    assert.strictEqual(res.ok, false, 'guard must block the send');
    assert(/sync/i.test(res.message), 'message should point at the sync problem');
  });

  // Case D — the in-memory pricing itself is zero: block before any network.
  await test('blocks when the local pricing total is zero/missing', async () => {
    const server = { jobId: 'job-4', pricing_json: { totalIncGST: 8803 } };
    let loadCalls = 0;
    const cloud = { ghl: { async loadJob() { loadCalls++; return { pricing_json: server.pricing_json }; } } };
    const app = buildApp({
      localPricing: { totalIncGST: 0 },
      cloud,
      integration: { async save() {} },
    });
    const res = await app._ensureServerPricingBeforeSend('job-4');
    assert.strictEqual(res.ok, false, 'guard must block a $0 local total');
    assert.strictEqual(loadCalls, 0, 'local guard should short-circuit before reading the server');
  });

  // Case E — local/offline jobs are left untouched (no cloud validation).
  await test('skips the guard for local- job ids and when cloud is absent', async () => {
    const app = buildApp({
      localPricing: { totalIncGST: 0 },
      cloud: makeCloud({ jobId: 'x', pricing_json: {} }),
      integration: { async save() {} },
    });
    const localRes = await app._ensureServerPricingBeforeSend('local-1699');
    assert.strictEqual(localRes.ok, true, 'local- jobs bypass the guard');
    assert.strictEqual(localRes.skipped, true);

    const noCloudApp = buildApp({
      localPricing: { totalIncGST: 0 },
      cloud: null,
      integration: { async save() {} },
    });
    const noCloudRes = await noCloudApp._ensureServerPricingBeforeSend('job-5');
    assert.strictEqual(noCloudRes.ok, true, 'no cloud => guard is a no-op');
  });

  // Case F — fail OPEN: a transient loadJob failure must not newly block sends.
  await test('does not block the send when the server total cannot be read', async () => {
    let saveCalls = 0;
    const cloud = { ghl: { async loadJob() { throw new Error('503 cold start'); } } };
    const app = buildApp({
      localPricing: { totalIncGST: 8803 },
      cloud,
      integration: { async save() { saveCalls++; } },
    });
    const res = await app._ensureServerPricingBeforeSend('job-6');
    assert.strictEqual(res.ok, true, 'unreadable server total must fail open');
    assert.strictEqual(res.unknown, true, 'guard flags the read as unknown');
    assert.strictEqual(saveCalls, 0, 'no resave attempted on an unknown read');
  });

  // ── Static wiring: the guard must run BEFORE the quote number is reserved ──
  await test('executeSendQuote calls the guard before reserving a quote number', async () => {
    const execStart = indexSource.indexOf('async function executeSendQuote()');
    assert(execStart >= 0, 'executeSendQuote exists');
    const execBlock = sliceBlock(indexSource, execStart);
    const guardIdx = execBlock.indexOf('_ensureServerPricingBeforeSend(');
    const reserveIdx = execBlock.indexOf('Reserving quote number');
    const prepareIdx = execBlock.indexOf('prepare_quote');
    const prepareNbIdx = execBlock.indexOf('prepare_neighbour_quotes');
    assert(guardIdx >= 0, 'executeSendQuote invokes the pricing guard');
    assert(reserveIdx >= 0, 'executeSendQuote reserves a quote number');
    assert(guardIdx < reserveIdx, 'guard must run before "Reserving quote number..."');
    assert(prepareIdx < 0 || guardIdx < prepareIdx, 'guard must run before prepare_quote');
    assert(prepareNbIdx < 0 || guardIdx < prepareNbIdx, 'guard must run before prepare_neighbour_quotes');
  });

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll send-quote zero-total checks passed');
})();

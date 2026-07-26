#!/usr/bin/env node
'use strict';

// Regression cover for the 2026-07-26 field report: creating a job from a local
// fence draft carrying a satellite site plan hard-blocked with
//   "Could not verify the local checkpoint. The current fence scope was kept
//    open and the target was not switched."
//
// Runs the REAL index.html checkpoint methods and the REAL integration.js guard
// against a simulated browser localStorage with the ~5MB origin quota.
//
// The safety property under test is NOT "the checkpoint always succeeds". It is
// "never switch away from a draft that cannot be recovered". A draft held by the
// primary save is recoverable even when the redundant checkpoint copy will not
// fit, and blocking in that case is a false stop.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const integrationSource = fs.readFileSync('integration.js', 'utf8');
const indexSource = fs.readFileSync('index.html', 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists in integration.js`);
  return sliceBlock(source, start);
}

function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  assert(start >= 0, `${signature} exists in index.html`);
  return sliceBlock(source, start);
}

function sliceBlock(source, start) {
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('could not slice block');
}

const QUOTA_BYTES = 5 * 1024 * 1024;
function makeLocalStorage() {
  const store = new Map();
  const used = () => {
    let n = 0;
    for (const [k, v] of store) n += k.length + v.length;
    return n;
  };
  return {
    _used: used,
    _keys: () => Array.from(store.keys()),
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) {
      v = String(v);
      const after = used() - (store.has(k) ? k.length + store.get(k).length : 0) + k.length + v.length;
      if (after > QUOTA_BYTES) {
        const e = new Error("Failed to execute 'setItem' on 'Storage': quota exceeded");
        e.name = 'QuotaExceededError';
        e.code = 22;
        throw e;
      }
      store.set(k, v);
    },
    removeItem(k) { store.delete(k); },
  };
}

function makeJob(sitePlanBytes) {
  return {
    clientFirstName: 'Trevor',
    clientLastName: 'Lawsons',
    phone: '+61416096745',
    address: '3 Maryport Way, Butler WA 6036',
    suburb: 'Butler',
    runs: [{ length: 12, panels: [{ type: 'colorbond' }] }],
    gates: [],
    checklist: { photos: [] },
    sitePlanImage: sitePlanBytes ? 'data:image/png;base64,' + 'A'.repeat(sitePlanBytes) : '',
    _fieldSync: {
      localDraftId: 'draft_b301e00a',
      syncState: 'local_dirty',
      lastLocalEditAt: new Date().toISOString(),
      pendingOps: [],
    },
  };
}

// `primarySaveWorks: false` models a genuinely unrecoverable draft: not even the
// ordinary save landed. The guard MUST still refuse in that case.
function buildSandbox({ sitePlanBytes, primarySaveWorks = true, cleanupReclaims = false }) {
  const localStorage = makeLocalStorage();
  const job = makeJob(sitePlanBytes);

  const app = {
    job,
    _hasMeaningfulLocalDraft() {
      const j = this.job || {};
      return !!(j.clientFirstName || j.clientLastName || j.phone || j.address);
    },
    _ensureFieldSync() { return this.job._fieldSync; },
    _cleanupStorage() {
      if (!cleanupReclaims) return;
      for (const k of localStorage._keys()) {
        if (k.indexOf('orphan_') === 0) localStorage.removeItem(k);
      }
    },
    save() {
      if (!primarySaveWorks) return;
      try { localStorage.setItem('fenceJob', JSON.stringify(this.job)); } catch (e) { /* mirrors save()'s own recovery */ }
    },
  };

  const sandbox = {
    window: { app },
    localStorage,
    console: { warn() {}, log() {} },
    Date, JSON, String, Object, Error, Number,
    _toolType: 'fencing',
    _entryError(code, message) { const e = new Error(message); e.code = code; return e; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const methods = [
    ['_checkpointPayloadJob(omitSitePlan)', '_checkpointPayloadJob', 'omitSitePlan'],
    ['_writeLocalDraftCheckpoint(localDraftId, source)', '_writeLocalDraftCheckpoint', 'localDraftId, source'],
    ['_restoreCheckpointSitePlan(job)', '_restoreCheckpointSitePlan', 'job'],
    ['_localDraftIsRecoverable(localDraftId)', '_localDraftIsRecoverable', 'localDraftId'],
    ['_checkpointLocalDraftBeforeLoad(source)', '_checkpointLocalDraftBeforeLoad', 'source'],
  ];
  for (const [signature, name, args] of methods) {
    const block = extractMethod(indexSource, signature);
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
    vm.runInContext(`window.app.${name} = function(${args}) {${body}};`, sandbox);
  }

  for (const fn of ['_hasDirtyFencingDraft', '_verifiedFenceCheckpoint', '_checkpointLocalDraftBeforeLoad']) {
    vm.runInContext(extractFunction(integrationSource, fn), sandbox);
  }
  return sandbox;
}

function attemptMint(options) {
  const sandbox = buildSandbox(options);
  let thrown = null;
  try {
    vm.runInContext("_checkpointLocalDraftBeforeLoad('server_mint_preflight')", sandbox);
  } catch (e) { thrown = e; }
  return { sandbox, thrown };
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS: ${label}`); }
  catch (e) { failures++; console.log(`  FAIL: ${label}\n        ${e.message}`); }
}

console.log('[checkpoint-recovery] fence draft checkpoint under localStorage pressure');

// The exact field condition Khairo hit.
check('a 3MB satellite site plan no longer blocks job creation', () => {
  const { thrown } = attemptMint({ sitePlanBytes: 3 * 1024 * 1024 });
  assert(!thrown, thrown && `still threw ${thrown.code}: ${thrown.message}`);
});

check('a 4.5MB site plan still does not block job creation', () => {
  const { thrown } = attemptMint({ sitePlanBytes: Math.floor(4.5 * 1024 * 1024) });
  assert(!thrown, thrown && `still threw ${thrown.code}`);
});

check('a site plan that fits is KEPT in the checkpoint', () => {
  const { sandbox, thrown } = attemptMint({ sitePlanBytes: 512 * 1024 });
  assert(!thrown, 'small site plan must not block');
  const raw = sandbox.localStorage.getItem('fenceJob_checkpoint_draft_b301e00a');
  assert(raw, 'checkpoint was written');
  assert(/data:image\/png/.test(raw), 'a site plan that fits must be preserved, not dropped');
});

check('only a site plan that cannot fit is dropped, and it is flagged', () => {
  const { sandbox } = attemptMint({ sitePlanBytes: 3 * 1024 * 1024 });
  const raw = sandbox.localStorage.getItem('fenceJob_checkpoint_draft_b301e00a');
  assert(raw, 'checkpoint was written');
  assert(!/data:image\/png/.test(raw), 'the oversized site plan is dropped as the last resort');
  assert(/_sitePlanOmitted/.test(raw), 'the omission must be recorded so resume can backfill it');
  assert(/Trevor/.test(raw), 'checkpoint still carries the draft field work');
});

check('resume backfills an omitted site plan from the primary save', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 3 * 1024 * 1024 });
  vm.runInContext('window.app.save()', sandbox);
  vm.runInContext("window.app._writeLocalDraftCheckpoint('draft_b301e00a', 'probe')", sandbox);
  const restored = vm.runInContext(
    "JSON.parse(JSON.stringify(window.app._restoreCheckpointSitePlan(JSON.parse(localStorage.getItem('fenceJob_checkpoint_draft_b301e00a')).job)))",
    sandbox
  );
  assert(restored.sitePlanImage && restored.sitePlanImage.indexOf('data:image/png') === 0,
    'resume must restore the site plan from the primary save');
  assert(!('_sitePlanOmitted' in restored), 'the omission flag must be cleared once backfilled');
});

check('the app-side checkpoint reports failure honestly when it cannot write', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 0 });
  // Fill the origin so no further write of any size can land.
  sandbox.localStorage.setItem('ballast', 'x'.repeat(QUOTA_BYTES - 32));
  const wrote = vm.runInContext("window.app._writeLocalDraftCheckpoint('draft_b301e00a', 'probe')", sandbox);
  assert.strictEqual(wrote, false, 'must return false, never a bare true, on a failed write');
});

check('quota recovery retries once after reclaiming space', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 0, cleanupReclaims: true });
  sandbox.localStorage.setItem('orphan_old_draft', 'x'.repeat(QUOTA_BYTES - 4096));
  const wrote = vm.runInContext("window.app._writeLocalDraftCheckpoint('draft_b301e00a', 'probe')", sandbox);
  assert.strictEqual(wrote, true, 'cleanup should reclaim space and the retry should land');
});

// The safety property must survive the fix.
check('SAFETY: still blocks when the draft is genuinely unrecoverable', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 0, primarySaveWorks: false });
  sandbox.localStorage.setItem('ballast', 'x'.repeat(QUOTA_BYTES - 32));
  let thrown = null;
  try {
    vm.runInContext("_checkpointLocalDraftBeforeLoad('server_mint_preflight')", sandbox);
  } catch (e) { thrown = e; }
  assert(thrown, 'must refuse to switch target when nothing holds the draft');
  assert.strictEqual(thrown.code, 'checkpoint_failed');
});

check('SAFETY: the primary save alone is accepted as recoverable', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 0 });
  vm.runInContext('window.app.save()', sandbox);
  const recoverable = vm.runInContext("window.app._localDraftIsRecoverable('draft_b301e00a')", sandbox);
  assert.strictEqual(recoverable, true);
});

check('SAFETY: a foreign draft id is not treated as recoverable', () => {
  const sandbox = buildSandbox({ sitePlanBytes: 0 });
  vm.runInContext('window.app.save()', sandbox);
  const recoverable = vm.runInContext("window.app._localDraftIsRecoverable('draft_somebody_else')", sandbox);
  assert.strictEqual(recoverable, false);
});

check('the legacy guard fallback also degrades instead of hard-blocking', () => {
  // Any app build without the writer above still reaches _verifiedFenceCheckpoint's
  // own fallback, which must drop the site plan rather than fail the quota.
  const guard = sliceBlock(integrationSource, integrationSource.indexOf('function _verifiedFenceCheckpoint('));
  assert(/sitePlanImage/.test(guard), 'the fallback must explicitly exclude sitePlanImage');
  assert(/localStorage\.setItem/.test(guard),
    'the fallback must still WRITE the checkpoint; divergence recovery depends on that side effect');
});

if (failures) {
  console.log(`\n[checkpoint-recovery] ${failures} FAILED`);
  process.exit(1);
}
console.log('\n[checkpoint-recovery] all checks passed');

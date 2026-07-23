#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const integrationSource = fs.readFileSync('integration.js', 'utf8');
const indexSource = fs.readFileSync('index.html', 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

function sourceContract() {
  const requiredDoors = [
    [indexSource, /startLocalDraft\(\)[\s\S]{0,500}enterJob\('new_local'/, 'launcher option 3 / blank local'],
    [indexSource, /_openLocalDraftCheckpoint\(key\)[\s\S]{0,700}enterJob\('resume_local'/, 'local checkpoint resume'],
    [integrationSource, /showGHLPicker[\s\S]{0,500}_enterJob\('ghl_context'/, 'GHL picker'],
    [integrationSource, /showLeadSearch[\s\S]{0,900}_enterJob\('ghl_context'/, 'lead/contact search'],
    [indexSource, /selectGHLContact\(idx\)[\s\S]{0,4500}enterJob\('ghl_context'/, 'inline GHL autocomplete'],
    [integrationSource, /_enterJob\('existing_job', \{ jobId: urlJobId/, 'direct existing-job URL'],
    [integrationSource, /_enterJob\('editable_scope', \{ jobId: jobId/, 'editable previous scope'],
    [integrationSource, /_enterJob\('frozen_revision'/, 'frozen revision URL'],
    [integrationSource, /_enterJob\('amendment'/, 'amendment request']
  ];
  for (const [source, pattern, label] of requiredDoors) {
    assert(pattern.test(source), `${label} must invoke the guarded owner`);
  }

  assert(/mintFenceJob/.test(integrationSource), 'guarded owner delegates unresolved identity to server mint');
  assert(/action=mint_fence_job/.test(fs.readFileSync('cloud.js', 'utf8')), 'cloud transport uses the server-owned mint action');
  assert(!/else \{\s*\/\/ Create a new Supabase job linked/.test(integrationSource));
  assert(/\['baseScopeHash', 'currentScopeHash'/.test(integrationSource));
  assert(/draft_already_exists/.test(integrationSource));
  // The inline autocomplete must link through the scrub boundary, never by
  // calling app._linkCloudAnchor itself.
  const inlineSelect = indexSource.slice(indexSource.indexOf('async selectGHLContact(idx)'));
  const inlineBody = inlineSelect.slice(0, inlineSelect.indexOf('\n      hideClientNameDropdown() {'));
  assert(/_swIntegration\.linkFencingAnchor\(/.test(inlineBody), 'inline autocomplete links via the guarded anchor');
  assert(!/this\._linkCloudAnchor\(/.test(inlineBody), 'inline autocomplete never bypasses the scrub boundary');
  assert(/_jobStatus = 'frozen'/.test(integrationSource));
  assert(/_shouldAutoSave\(\)[\s\S]{0,120}_isReadonly/.test(integrationSource) || /if \(_isReadonly\) return false/.test(integrationSource));

  // loadPicker must CONSUME the id the guarded owner already resolved/minted,
  // never re-resolve via findJobByOpportunity after the mint (replication race
  // would orphan a freshly minted job).
  const loadPickerBody = integrationSource.slice(
    integrationSource.indexOf('loadPicker: function()'),
    integrationSource.indexOf('searchLeads: function('));
  assert(/opp\.supabaseJobId \|\| opp\._supabaseJobId/.test(loadPickerBody),
    'loadPicker consumes the resolved/minted job id');
  assert(/cloud\.ghl\.loadJob\(resolvedJobId\)/.test(loadPickerBody),
    'loadPicker loads the resolved id directly');
  // Fencing must NEVER re-resolve after the guarded preflight (replication race
  // would orphan a freshly minted job). The only permitted findJobByOpportunity
  // is the non-fencing load-existing-job fallback, since _enterJob does not
  // resolve/mint for non-fencing tools and would otherwise throw on a real job.
  assert(/else if \(_toolType !== 'fencing'\)[\s\S]{0,300}findJobByOpportunity\(opp\.id/.test(loadPickerBody),
    'loadPicker re-resolves by opportunity only inside the non-fencing guard');
  const preFallback = loadPickerBody.slice(0, loadPickerBody.search(/else if \(_toolType !== 'fencing'\)/));
  assert(!/findJobByOpportunity\(opp\.id/.test(preFallback),
    'loadPicker never re-resolves by opportunity on the fencing path');

  // A local_save_promotion into an EXISTING scoped job must not clobber it:
  // requiresLoad routes through the redirect (unless the operator explicitly
  // chose keep_link) and the promotion caller bails before any saveScope write.
  assert(!/if \(requiresLoad && !keepLocal\)/.test(integrationSource),
    'requiresLoad redirect is no longer bypassed by the local_save_promotion source flag');
  assert(/if \(requiresLoad && permit\.target\.switchChoice !== 'keep_link'\)/.test(integrationSource),
    'requiresLoad redirects unless the operator explicitly kept the local draft');
  assert(/local_save_promotion'\);[\s\S]{0,400}\.requiresLoad\) return;/.test(integrationSource),
    'promotion bails before saveScope when the existing cloud scope must be reconciled first');

  // Execute the production scrub function, not a reimplementation: stale job A
  // cursor/ref/revision/pending ownership must be gone before job B can save.
  const scrubSource = extractFunction(integrationSource, '_scrubCrossJobIdentity');
  const window = { app: { job: { ref: 'SWF-100', _fieldSync: {
    syncAnchorType: 'job', syncAnchorId: 'job-a', baseScopeHash: 'cursor-a',
    currentScopeHash: 'cursor-a', scopeCursorJobId: 'job-a',
    syncAnchorRevisionId: 'rev-a', keep_link_job_id: 'job-a', pendingMintRequestId: 'mint-a',
    pendingMintFingerprint: 'fingerprint-a', completedMintCanonical: { jobId: 'job-a' }, pendingOps: [{ jobId: 'job-a' }]
  } } } };
  const runScrub = new Function('window', 'jobNumber', 'nextJobId', `
    var _toolType = 'fencing', _lastJobNumber = jobNumber;
    var _baseScopeHash = 'cursor-a', _baseScopeUpdatedAt = 'old', _scopeCursorJobId = 'job-a';
    function _isRealFenceRef(ref) { return /^SWF?-?\\d+/i.test(String(ref || '').trim()); }
    function _entryError(code, message) { var e = new Error(message); e.code = code; return e; }
    ${scrubSource}
    var thrown = null;
    try { _scrubCrossJobIdentity(nextJobId, 'opp-b', 'contact-b', 'fixture'); }
    catch (e) { thrown = e; }
    return { hash: _baseScopeHash, owner: _scopeCursorJobId, job: window.app.job, thrown: thrown };
  `);
  const freshWindow = () => ({ app: { job: { ref: 'SWF-100', _fieldSync: {
    syncAnchorType: 'job', syncAnchorId: 'job-a', identityVersion: 3, baseScopeHash: 'cursor-a',
    currentScopeHash: 'cursor-a', scopeCursorJobId: 'job-a',
    syncAnchorRevisionId: 'rev-a', keep_link_job_id: 'job-a', pendingMintRequestId: 'mint-a',
    pendingMintFingerprint: 'fingerprint-a', completedMintCanonical: { jobId: 'job-a' }, pendingOps: [{ jobId: 'job-a' }]
  } } } });

  const scrubbed = runScrub(window, 'SWF-200', 'job-b');
  assert.strictEqual(scrubbed.thrown, null);
  assert.strictEqual(scrubbed.hash, null);
  assert.strictEqual(scrubbed.owner, null);
  assert.strictEqual(scrubbed.job.ref, 'SWF-200');
  assert.strictEqual(scrubbed.job._fieldSync.syncAnchorId, 'job-b');
  assert.deepStrictEqual(scrubbed.job._fieldSync.pendingOps, []);
  for (const stale of ['baseScopeHash', 'currentScopeHash', 'scopeCursorJobId', 'syncAnchorRevisionId', 'keep_link_job_id', 'pendingMintRequestId', 'pendingMintFingerprint', 'completedMintCanonical']) {
    assert(!(stale in scrubbed.job._fieldSync), `${stale} removed at identity boundary`);
  }

  // identityVersion must distinguish successive rebinds, not sit at a constant.
  const versioned = runScrub(freshWindow(), 'SWF-200', 'job-b');
  assert.strictEqual(versioned.job._fieldSync.identityVersion, 4, 'identityVersion increments per rebind');

  // An unknown target job number must not silently blank a real on-screen ref.
  const refKept = runScrub(freshWindow(), null, 'job-b');
  assert.strictEqual(refKept.thrown, null, 'unknown job number is not a rebind failure');
  assert.strictEqual(refKept.job.ref, 'SWF-100', 'a real ref survives an unfetched job number');

  // A rejected rebind must leave _fieldSync exactly as it was found.
  const rejected = freshWindow();
  const before = JSON.parse(JSON.stringify(rejected.app.job));
  Object.defineProperty(rejected.app.job._fieldSync, 'syncAnchorId', {
    get() { return 'job-a'; }, set() {}, configurable: true, enumerable: true
  });
  const failed = runScrub(rejected, 'SWF-200', 'job-b');
  assert(failed.thrown && failed.thrown.code === 'identity_rebind_failed', 'unverifiable rebind stops');
  assert.strictEqual(failed.job.ref, before.ref, 'ref restored after a rejected rebind');
  for (const stale of ['baseScopeHash', 'scopeCursorJobId', 'syncAnchorRevisionId', 'keep_link_job_id', 'pendingMintRequestId', 'pendingMintFingerprint', 'completedMintCanonical']) {
    assert.deepStrictEqual(failed.job._fieldSync[stale], before._fieldSync[stale], `${stale} restored after a rejected rebind`);
  }
  assert.strictEqual(failed.hash, 'cursor-a', 'module cursor restored after a rejected rebind');
  assert.strictEqual(failed.owner, 'job-a', 'module cursor owner restored after a rejected rebind');
}

function makeRuntime() {
  let readyCallback = null;
  let networkLookups = 0;
  const mintCalls = [];
  const cloud = {
    auth: { isLoggedIn: () => false },
    on: () => {},
    ghl: {
      findJobByOpportunity: async (id) => {
        networkLookups++;
        if (id === 'opp-existing') return { id: 'job-existing' };
        if (id === 'opp-duplicate') return [{ id: 'job-a' }, { id: 'job-b' }];
        return null;
      },
      mintFenceJob: async (input) => {
        mintCalls.push(JSON.parse(JSON.stringify(input)));
        if (input.contactId === 'contact-flaky' && mintCalls.filter((call) => call.contactId === 'contact-flaky').length === 1) {
          const error = new Error('lost response'); error.code = 'mint_transport_error'; throw error;
        }
        const repeat = input.intent === 'DELIBERATE_REPEAT';
        return {
          success: true, requestId: input.requestId,
          jobId: repeat ? 'job-repeat' : 'job-minted', jobNumber: repeat ? 'SWF-202' : 'SWF-201',
          contactId: input.contactId || 'contact-created',
          opportunityId: repeat ? 'opp-repeat' : (input.opportunityId || 'opp-created'),
          mapping: { outcome: 'created', canonicalOutcome: 'created' },
          revision: { scopeVersion: 1, scopeHash: null, updatedAt: '2026-07-21T00:00:00Z', requiresLoad: false }
        };
      }
    }
  };
  const document = {
    readyState: 'loading', title: 'Fence Designer',
    body: { dataset: {}, classList: { add() {}, remove() {} }, style: {} },
    documentElement: { dataset: {}, classList: { add() {}, remove() {} } },
    head: { appendChild() {} },
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') readyCallback = cb; },
    getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return { style: {}, dataset: {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {} } }; }
  };
  let savedFenceJob = null;
  const app = {
    job: { _fieldSync: { localDraftId: 'local-current' } },
    _hasMeaningfulLocalDraft: () => false,
    _listLocalDraftCheckpoints: () => [],
    save() { savedFenceJob = JSON.parse(JSON.stringify(this.job)); }
  };
  let uuidSeq = 0;
  const window = {
    document, app, SECUREWORKS_CLOUD: cloud,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}` },
    location: { search: '', pathname: '/index.html', href: 'http://fixture/index.html' },
    history: { replaceState() {} },
    addEventListener() {},
    confirm: () => true, alert() {}
  };
  const context = vm.createContext({
    window, document, console, URL, URLSearchParams, AbortController,
    localStorage: {
      length: 0,
      getItem: (key) => key === 'fenceJob' && savedFenceJob ? JSON.stringify(savedFenceJob) : null,
      setItem() {}, removeItem() {}, key: () => null
    },
    setTimeout: (fn, ms) => { if ((ms || 0) < 45000) fn(); return 1; }, clearTimeout() {}, setInterval() {}, clearInterval() {},
    Event: function Event() {}, fetch: async () => { throw new Error('unexpected fetch'); }
  });
  vm.runInContext(integrationSource, context, { filename: 'integration.js' });
  assert(readyCallback, 'integration init callback registered');
  readyCallback();
  return { integration: window._swIntegration, app, getLookups: () => networkLookups, getMints: () => mintCalls };
}

async function runtimeContract() {
  const { integration, app, getLookups, getMints } = makeRuntime();

  const before = getLookups();
  await integration.enterJob('new_local', { localDraftId: 'local-new', source: 'option3' });
  assert.strictEqual(getLookups(), before, 'option 3 remains zero-network');

  await integration.enterJob('resume_local', { localDraftId: 'checkpoint-1' });
  await integration.enterJob('existing_job', { jobId: 'job-direct' });
  await integration.enterJob('editable_scope', { jobId: 'job-draft' });
  await integration.enterJob('frozen_revision', { jobId: 'job-sent', scopeRevisionId: 'rev-1' });
  await integration.enterJob('amendment', { jobId: 'job-sent', scopeRevisionId: 'rev-1' });

  const existing = await integration.enterJob('ghl_context', { row: { id: 'opp-existing', contactId: 'contact-1' } });
  assert.strictEqual(existing.target.jobId, 'job-existing');

  await assert.rejects(
    integration.enterJob('ghl_context', { row: { id: 'opp-duplicate', contactId: 'contact-1' } }),
    (error) => error.code === 'ambiguous_identity'
  );
  const flakyTarget = { row: { id: null, contactId: 'contact-flaky', contactName: 'Flaky Contact' } };
  await assert.rejects(integration.enterJob('ghl_context', flakyTarget), (error) => error.code === 'mint_transport_error');
  const firstFlakyId = getMints()[0].requestId;
  const flakyRetry = await integration.enterJob('ghl_context', flakyTarget);
  assert.strictEqual(flakyRetry.target.jobId, 'job-minted');
  assert.strictEqual(getMints()[1].requestId, firstFlakyId, 'lost response reuses the persisted request UUID');

  const contactOnly = await integration.enterJob('ghl_context', {
    row: { id: null, contactId: 'contact-only', contactName: 'Contact Only' }
  });
  assert.strictEqual(contactOnly.target.jobId, 'job-minted');
  assert.strictEqual(getMints()[2].intent, 'RESOLVED_NO_JOB');
  assert.match(getMints()[2].requestId, /^[0-9a-f-]{36}$/i, 'client persists a UUID before mint');

  const repeat = await integration.enterJob('ghl_context', {
    row: { id: 'opp-existing', contactId: 'contact-1', contactName: 'Repeat Client' },
    requestNew: true,
    repeatReason: 'Second property boundary'
  });
  assert.strictEqual(repeat.target.jobId, 'job-repeat');
  assert.strictEqual(getMints()[3].intent, 'DELIBERATE_REPEAT');
  assert.strictEqual(getMints()[3].opportunityId, null, 'repeat work never reuses the completed source opportunity');
  assert.deepStrictEqual(getMints()[3].expectedExistingJobIds, ['job-existing']);

  app._listLocalDraftCheckpoints = () => [
    { id: 'one', job: { email: 'same@example.com' } },
    { id: 'two', job: { email: 'same@example.com' } }
  ];
  await assert.rejects(
    integration.enterJob('ghl_context', { row: { id: 'opp-existing', contactEmail: 'same@example.com' } }),
    (error) => error.code === 'ambiguous_local_checkpoints'
  );

  const intents = integration.getEntryAudit().filter((row) => row.state === 'permitted').map((row) => row.intent);
  for (const intent of ['new_local', 'resume_local', 'existing_job', 'editable_scope', 'frozen_revision', 'amendment', 'ghl_context']) {
    assert(intents.includes(intent), `${intent} audited by the guarded owner`);
  }
}

(async () => {
  sourceContract();
  await runtimeContract();
  console.log('PASS all supported fence entry doors invoke one guarded owner');
  console.log('PASS option 3 is zero-network; ambiguous/raw mappings stop before mint');
  console.log('PASS unresolved contexts use server mint and lost responses replay one request UUID');
  console.log('PASS direct/editable/frozen/amendment intents are runtime-audited');
  console.log('PASS stale ref/cursor scrub and immutable amendment contracts are wired');
})().catch((error) => { console.error(error); process.exit(1); });

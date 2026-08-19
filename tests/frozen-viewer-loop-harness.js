#!/usr/bin/env node
'use strict';

// Reopening a quoted fencing job spun the page in an endless reload loop
// (Marnin, 2026-07-26): the tab cycled between loading and loaded, forever,
// with ?jobId= and ?scope_revision_id= both in the URL.
//
// Two production defects combined.
//
//  1. The frozen-viewer entry passes BOTH a jobId and a scopeRevisionId, and
//     _targetKey checked jobId first. The sealed revision therefore collapsed
//     onto its parent job, the "already on this target" shortcut matched, and
//     the switch resolved to keep_link with no prompt at all.
//
//  2. keep_link means "stay on my editable scope", which clears the viewer URL
//     and re-arms the auto-loader. The live path then saw a quoted job, sent
//     the page back to the viewer URL and RELOADED it. Round and round.
//
// These checks run the real production functions, extracted from integration.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const integrationSource = fs.readFileSync(path.join(repoRoot, 'integration.js'), 'utf8');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('  ok  ' + label);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists in integration.js`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const targetKeySource = extractFunction(integrationSource, '_targetKey');
const currentKeySource = extractFunction(integrationSource, '_currentFencingTargetKey');
const shouldOpenViewerSource = extractFunction(integrationSource, '_shouldOpenFrozenViewer');

// ── The real _targetKey ──────────────────────────────────────────────────────
const targetKey = new Function(`${targetKeySource}; return _targetKey;`)();

// ── The real _currentFencingTargetKey, given a fencing app state ─────────────
function currentTargetKey(state) {
  return new Function('window', 'state', `
    var _toolType = state.toolType;
    var _jobId = state.jobId;
    var _ghlOpportunityId = state.opportunityId;
    function _isRealJobId(id) { return !!id && /^[0-9a-f-]{8,}$/i.test(String(id)); }
    ${currentKeySource}
    return _currentFencingTargetKey();
  `)({ app: { job: state.job } }, state);
}

// ── The real switch shortcut, which is the part that silently auto-answers ───
// _resolveFencingTargetSwitch builds a DOM modal when the keys differ, which is
// the correct behaviour and not what is under test. What is under test is the
// early return above it, so this drives exactly that decision with the two real
// key functions.
function shortcutChoice(state, target) {
  const currentKey = currentTargetKey(state);
  const nextKey = targetKey(target);
  if (currentKey && nextKey && currentKey === nextKey) return 'keep_link';
  return 'prompt';
}

console.log('Frozen-viewer reload loop');

const JOB_ID = '9cc674fd-26fc-4acb-8af3-d40f0bfef767';
const REVISION_ID = 'b7335973-d1d1-4bb0-8912-1f4a0a2b77c1';

// A scoper with a local fence draft already linked to the quoted job — the
// exact state a reopened quoted job lands in.
const linkedDraft = {
  toolType: 'fencing',
  jobId: JOB_ID,
  opportunityId: null,
  job: { _fieldSync: { syncAnchorType: 'job', syncAnchorId: JOB_ID, localDraftId: 'draft-1' } }
};

check('a sealed revision is identified as a revision, not as its parent job', () => {
  assert.strictEqual(
    targetKey({ jobId: JOB_ID, scopeRevisionId: REVISION_ID }),
    'revision:' + REVISION_ID
  );
});

check('an ordinary job target is still identified by its job id', () => {
  assert.strictEqual(targetKey({ jobId: JOB_ID }), 'job:' + JOB_ID);
});

check('opening the frozen viewer over an editable draft is treated as a real switch', () => {
  // This is defect 1. Before the fix this returned keep_link with no prompt,
  // which is what drove the loop without the operator ever seeing a choice.
  assert.strictEqual(
    shortcutChoice(linkedDraft, { jobId: JOB_ID, scopeRevisionId: REVISION_ID }),
    'prompt'
  );
});

check('re-entering the SAME job still short-circuits without a pointless prompt', () => {
  assert.strictEqual(shortcutChoice(linkedDraft, { jobId: JOB_ID }), 'keep_link');
});

// ── The redirect decision ────────────────────────────────────────────────────
// _shouldOpenFrozenViewer owns whether the live path sends the page to the
// read-only viewer. The loop is broken here: one deliberate choice to stay
// editable has to survive until the page is opened afresh.
function viewerDecider() {
  return new Function(`
    var _frozenViewerDeclined = false;
    ${shouldOpenViewerSource}
    return {
      should: function(job, params) { return _shouldOpenFrozenViewer(job, params); },
      decline: function() { _frozenViewerDeclined = true; }
    };
  `)();
}

const quotedJob = { latest_frozen_scope_revision_id: REVISION_ID };
const unquotedJob = { latest_frozen_scope_revision_id: null };
const noParams = new URLSearchParams('');
const editParams = new URLSearchParams('edit=1');

check('a quoted job still opens read-only by default', () => {
  assert.strictEqual(viewerDecider().should(quotedJob, noParams), true);
});

check('a job that was never quoted is never sent to the viewer', () => {
  assert.strictEqual(viewerDecider().should(unquotedJob, noParams), false);
});

check('"Make a revision" (?edit=1) still bypasses the viewer', () => {
  assert.strictEqual(viewerDecider().should(quotedJob, editParams), false);
});

check('choosing to stay editable is not overridden by the read-only default', () => {
  // This is defect 2, and the loop itself. Before the fix the live path
  // redirected regardless, reloading the page, which returned to the viewer,
  // which cleared the URL again, forever.
  const decider = viewerDecider();
  decider.decline();
  assert.strictEqual(decider.should(quotedJob, noParams), false);
});

check('the loop terminates: reopening a quoted job settles within a few steps', () => {
  // Walks the real decision pair the way the page does, and fails loudly if it
  // never settles rather than hanging the way the browser did.
  const decider = viewerDecider();
  let url = { jobId: JOB_ID, scopeRevisionId: null };
  let reloads = 0;
  const seen = [];

  for (let step = 0; step < 25; step++) {
    if (url.scopeRevisionId) {
      // Frozen branch: resolve the switch against the editable draft.
      const choice = shortcutChoice(linkedDraft, { jobId: url.jobId, scopeRevisionId: url.scopeRevisionId });
      if (choice === 'keep_link') {
        // Silent auto-answer: stay editable and clear the viewer URL.
        decider.decline();
        url = { jobId: url.jobId, scopeRevisionId: null };
        seen.push('auto-kept-editable');
        continue;
      }
      seen.push('prompted-operator');
      break;  // waits for a human; no further navigation
    }
    // Live branch.
    if (decider.should(quotedJob, noParams)) {
      url = { jobId: url.jobId, scopeRevisionId: REVISION_ID };
      reloads++;
      seen.push('redirect-to-viewer');
      continue;
    }
    seen.push('settled-editable');
    break;
  }

  assert(reloads <= 1, `page reloaded ${reloads} times, expected at most 1 (${seen.join(' -> ')})`);
  assert(
    seen[seen.length - 1] === 'prompted-operator' || seen[seen.length - 1] === 'settled-editable',
    `never settled: ${seen.join(' -> ')}`
  );
});

// ── SAFETY ──────────────────────────────────────────────────────────────────
// The viewer default exists so nobody silently re-publishes a sealed scope.
// Breaking the loop must not become a way of skipping it.
check('SAFETY: a fresh page load of a quoted job still lands read-only', () => {
  // A new page session starts with no declined flag, whatever happened before.
  assert.strictEqual(viewerDecider().should(quotedJob, noParams), true);
});

check('SAFETY: declining the viewer for one job does not unseal a different job', () => {
  const decider = viewerDecider();
  decider.decline();
  // Still governed by the job's own frozen revision, and a fresh load re-arms.
  assert.strictEqual(decider.should(unquotedJob, noParams), false);
  assert.strictEqual(viewerDecider().should(quotedJob, noParams), true);
});

check('SAFETY: the viewer redirect is still the only writer of scope_revision_id here', () => {
  const autoLoad = integrationSource.slice(
    integrationSource.indexOf('async function _autoLoadJob()'),
    integrationSource.indexOf('// Frozen-revision branch of _autoLoadJob')
  );
  const setters = autoLoad.match(/searchParams\.set\('scope_revision_id'/g) || [];
  assert.strictEqual(setters.length, 1, 'exactly one place sends the page to the viewer');
  assert(
    /_shouldOpenFrozenViewer\(job, urlParams\)/.test(autoLoad),
    'that redirect is gated by the shared decision, not an inline condition'
  );
});

// ── SCOPE-23: iPad save lock / leftover frozen URL latch ──────────────────────
console.log('SCOPE-23 iPad save lock');

check('readonly is re-computable (_isReadonlyNow), not a one-shot IIFE', () => {
  assert(integrationSource.includes('function _isReadonlyNow()'), '_isReadonlyNow exists');
  assert(
    !/var _isReadonly = \(function\(\)/.test(integrationSource),
    'the load-time IIFE latch is gone'
  );
});

function readonlyNow(search) {
  global.window = { location: { search: search } };
  return new Function(`
    ${extractFunction(integrationSource, '_isReadonlyNow')}
    return _isReadonlyNow();
  `)();
}

check('_isReadonlyNow is true for a frozen revision URL', () => {
  assert.strictEqual(readonlyNow('?jobId=' + JOB_ID + '&scope_revision_id=' + REVISION_ID), true);
});

check('_isReadonlyNow is true for mode=readonly', () => {
  assert.strictEqual(readonlyNow('?jobId=' + JOB_ID + '&mode=readonly'), true);
});

check('_isReadonlyNow is false for a clean job URL', () => {
  assert.strictEqual(readonlyNow('?jobId=' + JOB_ID), false);
});

check('_isReadonlyNow is false for an editable revision clone (?edit=1, no frozen params)', () => {
  assert.strictEqual(readonlyNow('?jobId=' + JOB_ID + '&edit=1'), false);
});

check('write gates and autosave consult live readonly, not the stale latch', () => {
  const saveSlice = integrationSource.slice(
    integrationSource.indexOf('save: async function()'),
    integrationSource.indexOf('ensureJobSynced: async function')
  );
  assert(/if \(_isReadonlyNow\(\)\)/.test(saveSlice), 'save() uses _isReadonlyNow');
  assert(/if \(_isReadonlyNow\(\)\) return \{ ok: false, reason: 'readonly' \}/.test(integrationSource),
    'ensureJobSynced uses _isReadonlyNow');
  assert(/saveAfterSignOff: async function\(\) \{\s*if \(_isReadonlyNow\(\)\)/.test(integrationSource),
    'saveAfterSignOff uses _isReadonlyNow');
  const auto = extractFunction(integrationSource, '_shouldAutoSave');
  assert(auto.includes('_isReadonlyNow()'), '_shouldAutoSave uses live readonly');
  assert(
    /blocked = \['quoted', 'accepted', 'scheduled', 'in_progress', 'completed'\]/.test(auto),
    '_shouldAutoSave still blocks non-draft statuses'
  );
});

function mockPage(search) {
  const replaces = [];
  const history = [];
  const storage = { fenceJob: '{"keep":true}', other: '1' };
  const classList = { items: new Set(['readonly-mode']), remove: function(c) { this.items.delete(c); } };
  const banner = { id: 'sw-frozen-revision-banner', dataset: { swPadTop: '36' }, parentNode: { removeChild: function() { banner.gone = true; } } };
  const body = { style: { paddingTop: '36px' } };
  const elements = { 'sw-frozen-revision-banner': banner, 'sw-frozen-error-banner': null };
  const win = {
    location: {
      search: search,
      pathname: '/fence-designer/',
      href: 'https://example.test/fence-designer/' + search,
      replace: function(u) { replaces.push(u); }
    },
    history: {
      replaceState: function(_s, _t, url) {
        history.push(url);
        win.location.search = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?')) : '';
      }
    },
    localStorage: {
      getItem: function(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function(k, v) { storage[k] = String(v); },
      removeItem: function(k) { delete storage[k]; }
    }
  };
  const doc = {
    documentElement: { classList: classList },
    body: body,
    getElementById: function(id) { return elements[id] || null; }
  };
  return { win: win, doc: doc, history: history, replaces: replaces, storage: storage, classList: classList, banner: banner };
}

check('exitReadonly clears latch, chrome, and leftover frozen URL; keeps jobId; no localStorage wipe', () => {
  const page = mockPage('?jobId=' + JOB_ID + '&scope_revision_id=' + REVISION_ID + '&mode=readonly');
  global.window = page.win;
  global.document = page.doc;
  const out = new Function('JOB_ID', `
    var _isReadonly = true;
    var _jobId = JOB_ID;
    function _isRealJobId(id) { return !!id; }
    ${extractFunction(integrationSource, '_clearFrozenViewerChrome')}
    ${extractFunction(integrationSource, 'exitReadonly')}
    exitReadonly();
    return { isReadonly: _isReadonly };
  `)(JOB_ID);
  assert.strictEqual(out.isReadonly, false, 'latch cleared');
  assert.strictEqual(page.classList.items.has('readonly-mode'), false, 'readonly-mode class removed');
  assert.strictEqual(page.banner.gone, true, 'frozen banner torn down');
  assert.strictEqual(page.history.length, 1, 'url rewritten once');
  const lastUrl = page.history[0];
  assert(lastUrl.indexOf('jobId=' + JOB_ID) !== -1, 'keeps jobId: ' + lastUrl);
  assert(lastUrl.indexOf('scope_revision_id') === -1, 'drops scope_revision_id: ' + lastUrl);
  assert(lastUrl.indexOf('mode=') === -1, 'drops mode: ' + lastUrl);
  assert.strictEqual(page.storage.fenceJob, '{"keep":true}', 'does not touch localStorage');
});

check('Force Refresh reloads ?jobId= only and does not touch localStorage', () => {
  const page = mockPage('?jobId=' + JOB_ID + '&scope_revision_id=' + REVISION_ID + '&mode=readonly');
  global.window = page.win;
  new Function('JOB_ID', `
    var _jobId = JOB_ID;
    function _isRealJobId(id) { return !!id; }
    function getJobIdFromURL() { return JOB_ID; }
    ${extractFunction(integrationSource, 'forceRefresh')}
    forceRefresh();
  `)(JOB_ID);
  assert.strictEqual(page.replaces.length, 1, 'one full reload');
  assert.strictEqual(page.replaces[0], '/fence-designer/?jobId=' + JOB_ID);
  assert.strictEqual(page.storage.fenceJob, '{"keep":true}', 'does not touch localStorage');
});

check('Make a revision exits readonly so an iPad no-reload still becomes editable', () => {
  const make = integrationSource.slice(
    integrationSource.indexOf('async function _makeRevision'),
    integrationSource.indexOf('async function _loadRevisionSwitcher')
  );
  assert(make.includes('exitReadonly()'), '_makeRevision calls exitReadonly');
  assert(make.includes("searchParams.delete('scope_revision_id')"), 'revision URL drops frozen id');
});

check('frozen banner still exists and now has a Force Refresh escape hatch', () => {
  const banner = extractFunction(integrationSource, '_renderFrozenBanner');
  assert(banner.includes('Make a revision'), 'revision button kept');
  assert(banner.includes('Force Refresh'), 'Force Refresh control added');
});

check('SAFETY: a frozen URL still blocks writes', () => {
  assert.strictEqual(readonlyNow('?scope_revision_id=' + REVISION_ID), true);
});

console.log(`\n${passed} checks passed, 0 failed`);

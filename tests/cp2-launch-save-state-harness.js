#!/usr/bin/env node
'use strict';

/**
 * CP2 frontend launch/save-state harness.
 * No network, no browser. This checks the field contract Marnin approved:
 * explicit launcher, local iPad draft wins, phone-only GHL leads are usable,
 * duplicate job-number conflicts cannot show success, and release is blocked
 * until the scope has a sync anchor.
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('index.html');
const integration = read('integration.js');
const cloud = read('cloud.js');
const all = [index, integration, cloud].join('\n');

const passes = [];
const failures = [];
function record(id, ok, evidence) {
  (ok ? passes : failures).push({ id, evidence });
}
function has(text, pattern) {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}
function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`method not found: ${signature}`);
  const bodyStart = start + signature.length;
  const bodyEnd = source.indexOf('\n      },', bodyStart);
  if (bodyEnd < 0) throw new Error(`method end not found: ${signature}`);
  return new Function('job', source.slice(bodyStart, bodyEnd));
}
record(
  'launcher has the four approved entry points',
  has(index, 'showLaunchModal()') &&
    has(index, '1. Load GHL lead/contact') &&
    has(index, '2. Resume draft / previous scope') &&
    has(index, '3. Start new local draft') &&
    has(index, '4. New job for existing client/lead'),
  'launcher strings and showLaunchModal present (incl. repeat-client new-job entry)'
);

record(
  'new-job launcher entry opens lead search in new_job mode',
  /launchNewJobBtn'\)\.onclick[\s\S]{0,160}searchLeads\('',\s*\{\s*mode:\s*'new_job'\s*\}\)/.test(index),
  'option 4 calls _swIntegration.searchLeads with mode:new_job'
);

record(
  'header has no fake search launcher',
  !/id="headerSearch"/.test(index) && !/Launch \/ resume \/ link scope/.test(index),
  'the search-looking duplicate launcher was removed'
);

record(
  'header has one launcher and no separate New Local shortcut',
  /<button class="btn-header" onclick="app\.showLaunchModal\(\)">Launch<\/button>/.test(index) &&
    !/<button class="btn-header" onclick="app\.startLocalDraft\(\)">New Local<\/button>/.test(index) &&
    /Sign in to link \/ sync/.test(index) &&
    !/Sign in to save &amp; freeze/.test(index),
  'header exposes Launch only; new local remains inside the launcher confirmation flow'
);

record(
  'phone-only draft labels are honest about progressive client identity',
  /First Name <span[^>]*>\(optional for local draft/.test(index) &&
    /Last Name <span[^>]*>\(optional for local draft\)/.test(index) &&
    /Email <span[^>]*>\(required only to email quote\)/.test(index) &&
    /<label>Phone \*<\/label>/.test(index),
  'name/email are optional for local draft; phone remains the minimum identity and email is required at send'
);

record(
  'First Name field has no hidden GHL lookup side effect',
  /id="clientFirstNameInput"[\s\S]{0,220}oninput="app\.updateField\('clientFirstName', this\.value\)"/.test(index) &&
    !/id="clientFirstNameInput"[\s\S]{0,260}oninput="app\.onClientNameInput/.test(index) &&
    !/id="clientFirstNameInput"[\s\S]{0,320}onkeydown="app\.onClientNameKeydown/.test(index),
  'first-name typing updates local state only; linking/search remains behind launcher/link surfaces'
);

record(
  'duplicate top cloud Save Load Dashboard bar is skipped for fencing',
  /detectToolType\(\) === 'fencing'[\s\S]{0,220}skipping duplicate cloud Save\/Load\/Dashboard bar/.test(integration),
  'integration toolbar no-ops for fencing so launcher/buttons are not duplicated'
);

record(
  'local draft metadata and checkpoint are durable',
  /localDraftId/.test(index) && /requiresLinkBeforeRelease/.test(index) && /fenceJob_checkpoint_/.test(index) && /_checkpointLocalDraftBeforeLoad/.test(index),
  'field sync metadata plus checkpoint storage present'
);

record(
  'GHL/cloud contact data is fill-empty only',
  /Fill-empty only: GHL\/cloud data must not overwrite local iPad edits/.test(integration) && /if \(current\) return;/.test(integration) && /_fillEmptyFromContact/.test(index),
  'prefill preserves non-empty local fields'
);

record(
  'load paths checkpoint local draft before reset',
  /_openFencingTargetSeparately/.test(integration) && /_checkpointLocalDraftBeforeLoad\(\(source \|\| 'cloud_load'\)/.test(integration) && /_keep_link'\)/.test(integration),
  'loadPicker/search/loadFromSupabase use local-wins checkpoint seam'
);

record(
  'phone-only GHL leads remain selectable',
  /Phone lead/.test(cloud) && !/leads = leads\.filter\(function\(o\)[\s\S]{0,120}phone-only names/.test(cloud),
  'phone-only filter removed; fallback label exists'
);

record(
  'phone-only and no-name drafts/saves do not require name or email',
  !/if \(!this\.job\.email\) missing\.push\('Email'\)/.test(index) &&
    !/if \(!d\.name\)\s+errors\.push\('Client name is required'\)/.test(integration) &&
    /Email is intentionally not required here/.test(integration) &&
    !/errors\.push\('Email address is required'\)/.test(integration) &&
    !/if \(!meta\.client_name\) meta\.client_name = prompt\(/.test(integration),
  'draft/output save validation allows phone-only/no-name contact data; send flow still validates email recipients'
);

record(
  'no-name GHL contacts can receive phone/address writeback',
  /if \(_ghlContactId && \(meta\.client_name \|\| meta\.client_email \|\| meta\.client_phone \|\| meta\.site_address \|\| meta\.site_suburb\)\)/.test(integration) &&
    /if \(meta\.client_name\) contactUpdate\.name = meta\.client_name/.test(integration),
  'GHL update is keyed by contact id and sends non-empty details without requiring a name'
);

record(
  'resume draft enumerates local checkpoints without auth and preserves cloud previous-scope picker',
  /showResumeDraftModal\(\)/.test(index) &&
    /_listLocalDraftCheckpoints\(\)/.test(index) &&
    /hasMeaningfulJob/.test(index) &&
    /seenIds/.test(index) &&
    /fenceJob_checkpoint_/.test(index) &&
    /_openLocalDraftCheckpoint/.test(index) &&
    /window\._swIntegration\.loadFromSupabase\(\)/.test(index),
  'Resume draft opens local fenceJob/checkpoint entries directly and keeps existing Supabase job picker behind a cloud button'
);

record(
  'dirty draft target switch requires explicit keep-link/open-separately/cancel decision',
  /resolveFencingTargetSwitch/.test(integration) &&
    /targetKeepLinkBtn/.test(integration) &&
    /targetOpenSeparateBtn/.test(integration) &&
    /targetCancelBtn/.test(integration) &&
    /switchChoice === 'cancel'/.test(integration) &&
    /switchChoice === 'keep_link'/.test(integration) &&
    /inline_ghl_contact_keep_link/.test(index),
  'GHL picker, lead search, Supabase picker, and inline GHL selection route through an explicit target-switch choice'
);

try {
  const scrubLocalResumeJob = extractMethod(index, '_scrubLocalResumeJob(job) {');
  const resumed = scrubLocalResumeJob({
    ref: 'SW-OLD-123',
    clientFirstName: 'Offline',
    _fieldSync: {
      localDraftId: 'draft-1',
      syncAnchorType: 'job',
      syncAnchorId: 'cloud-old',
      ghlContactId: 'contact-old',
      syncState: 'linked_job_local_dirty'
    }
  });
  record(
    'local checkpoint resume scrubs stale cloud identity',
    resumed.ref === '' && resumed._fieldSync.syncAnchorType === 'local_only' &&
      resumed._fieldSync.syncAnchorId === null && resumed._fieldSync.ghlContactId === null &&
      resumed._fieldSync.requiresLinkBeforeRelease === true && resumed._fieldSync.syncState === 'local_dirty',
    'executed the production _scrubLocalResumeJob method against a checkpoint carrying stale job/GHL anchors'
  );
} catch (e) {
  record('local checkpoint resume scrubs stale cloud identity', false, e.message);
}

try {
  const linkStart = index.indexOf('_linkCloudAnchor(anchor) {');
  const linkEnd = index.indexOf('\n      },', linkStart);
  const linkCloudAnchor = new Function('anchor', index.slice(linkStart + '_linkCloudAnchor(anchor) {'.length, linkEnd));
  const fakeApp = {
    job: { _fieldSync: {} },
    _ensureFieldSync() { return this.job._fieldSync; },
    save() {},
    _updateHeaderStatus() {}
  };
  linkCloudAnchor.call(fakeApp, { jobId: 'cloud-123', opportunityId: 'opp-123', contactId: 'contact-123', launchMode: 'load_from_supabase' });
  record(
    'linking a selected cloud target makes the app anchor explicit',
    fakeApp.job._fieldSync.syncAnchorType === 'job' && fakeApp.job._fieldSync.syncAnchorId === 'cloud-123' &&
      fakeApp.job._fieldSync.requiresLinkBeforeRelease === false && fakeApp.job._fieldSync.ghlContactId === 'contact-123',
    'executed the production _linkCloudAnchor method for a selected Supabase target'
  );
} catch (e) {
  record('linking a selected cloud target makes the app anchor explicit', false, e.message);
}

record(
  'Supabase keep-link updates app anchor before autosave',
  /_linkFencingAnchor\(_jobId, _ghlOpportunityId, _ghlContactId, 'load_from_supabase'\)/.test(integration) &&
    /_linkFencingAnchor\(_jobId, _ghlOpportunityId, _ghlContactId, 'supabase_job_load'\)/.test(integration),
  'selected cloud jobs link the app field-sync metadata before autosave can start'
);

const inlineWireStart = index.indexOf('// Write the app anchor before connecting integration; _connectJob can arm autosave immediately.');
const inlineWireEnd = index.indexOf('this.save();', inlineWireStart);
const inlineWireBlock = index.slice(inlineWireStart, inlineWireEnd > inlineWireStart ? inlineWireEnd : undefined);
record(
  'inline GHL keep-link anchors app before connecting integration',
  inlineWireStart >= 0 && inlineWireEnd > inlineWireStart &&
    inlineWireBlock.indexOf('this._linkCloudAnchor(') >= 0 &&
    inlineWireBlock.indexOf('this._linkCloudAnchor(') < inlineWireBlock.indexOf('window._swIntegration._connectJob('),
  'inline contact linking writes field-sync metadata before _connectJob can arm autosave'
);

record(
  'local-wins cloud target does not hydrate remote number or media',
  /if \(!localDraftWins\) \{\s*_applyJobNumber\(_lastJobNumber\);\s*try \{ await _loadCloudMedia\(_jobId\)/.test(integration) &&
    /local draft wins and remote job number\/media stay out of the field draft/.test(integration),
  'local-wins guards cover Supabase/GHL target job-number and media hydration'
);

const autoLoadStart = integration.indexOf('async function _autoLoadJob()');
const autoLoadEnd = integration.indexOf('\n  // Frozen-revision branch of _autoLoadJob', autoLoadStart);
const autoLoadBranch = integration.slice(autoLoadStart, autoLoadEnd > autoLoadStart ? autoLoadEnd : undefined);
record(
  'URL auto-load prompts before setting job anchor or autosave',
  autoLoadStart >= 0 &&
    /_resolveFencingTargetSwitch\('auto_load_url_job'/.test(autoLoadBranch) &&
    /switchChoice === 'cancel'[\s\S]{0,160}_jobLoaded = false/.test(autoLoadBranch) &&
    autoLoadBranch.indexOf("_resolveFencingTargetSwitch('auto_load_url_job'") < autoLoadBranch.indexOf('_jobId = urlJobId') &&
    autoLoadBranch.indexOf('_jobId = urlJobId') < autoLoadBranch.indexOf("_linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'auto_load_url_job')") &&
    /if \(_shouldAutoSave\(\) && !localDraftWins\)/.test(autoLoadBranch),
  '?jobId= target switch is resolved before _jobId/link/autosave; cancel exits without anchoring'
);

record(
  'release is blocked until linked/synced',
  /hasReleaseAnchor/.test(integration) && /ensureJobSynced\s*:\s*async function/.test(integration) && /link_required/.test(integration) && /Release blocked until/.test(index),
  'release readiness seam blocks local-only unanchored drafts'
);

record(
  'direct operator backend calls require authorized cloud fetch',
  /authenticated_request_unavailable: cloud\.authorizedFetch is required/.test(index) &&
    /authenticated_request_unavailable: cloud\.authorizedFetch is required/.test(integration) &&
    !/x-api-key': window\.SW_API_KEY/.test(index) &&
    !/x-api-key': window\.SW_API_KEY/.test(integration) &&
    !/Bearer ' \+ cloud\.supabaseAnonKey/.test(index),
  'index/integration use cloud.authorizedFetch for ops-api/ghl-proxy/send-quote operator requests'
);

record(
  'Create Job for Ops does not claim client quote sent',
  /Create Job for Ops/.test(index) &&
    /This does not send the client quote/.test(index) &&
    /Job Created for Ops/.test(index) &&
    /partialFailures/.test(index) &&
    !/Quote PDF \+ POs sent to ops/.test(index),
  'release action and success copy describe ops job creation only and expose partial failures'
);

record(
  'Create Job retains photo upload failures in its final partial-failure result',
  integration.indexOf('if (_isSignOff) _lastReleasePartialFailures = [];') > -1 &&
    integration.indexOf('var sitePhotos = window.sitePhotos || [];', integration.indexOf('if (_isSignOff) _lastReleasePartialFailures = [];')) > integration.indexOf('if (_isSignOff) _lastReleasePartialFailures = [];') &&
    /_lastReleasePartialFailures\.push\(\{ step: 'media'/.test(integration),
  'release failures are reset before media work, so failed photos remain visible in the returned summary'
);

record(
  'Supabase picker restores the selected real job number',
  /loadFromSupabase:[\s\S]{0,2600}_lastJobNumber = job\.job_number \|\| null;[\s\S]{0,120}_applyJobNumber\(_lastJobNumber\)/.test(integration),
  'opening a previous Supabase scope cannot silently reopen a numbered job as an unnumbered draft'
);

record(
  'duplicate job number conflict cannot show success',
  /idx_jobs_job_number|duplicate key value|23505/.test(integration) && /Recoverable conflict: duplicate job number/.test(integration) && /throw e;/.test(integration),
  'save catch surfaces conflict and rethrows so success UI cannot proceed'
);

record(
  'offline create_job queue flushes before dependent saves',
  /action\.type === 'create_job'/.test(cloud) && /localJobIdMap/.test(cloud) && /localJobIdMap\[action\.jobId\] \|\| action\.jobId/.test(cloud),
  'offline create_job branch maps local IDs before save_job flush'
);

record(
  'photos keep a reloadable local upload copy or honest reattach state',
  /uploadDataUrl/.test(index) && /mediaManifestState/.test(index) && /needsReattach/.test(index) && /cp\.uploadDataUrl/.test(integration),
  'photo upload copy persisted in draft; video marks reattach until cloud upload'
);


record(
  'URL auto-load/reconnect uses local-wins guard',
  /auto_load_url_job/.test(integration) && /Never attach an existing local draft to a different \?jobId without an explicit operator choice/.test(integration) && /if \(!localDraftWins\) _loadFencingStateLocalWins\(job\.scope_json, 'auto_load_url_job'\)/.test(integration),
  '?jobId= auto-load asks first and does not hydrate remote scope when local wins'
);

try {
  const startLocalDraft = extractMethod(index, 'startLocalDraft() {');
  let confirmed = false;
  let checkpointed = false;
  global.confirm = function() { return confirmed; };
  global.window = { SECUREWORKS_CLOUD: { stopAutoSave() {} }, _swIntegration: { _connectJob() {} }, history: { replaceState() {} }, location: { pathname: '/fence' }, scrollTo() {} };
  global.localStorage = { removeItem() {} };
  const fakeApp = {
    job: { clientFirstName: 'Existing' },
    currentRunId: 'run-1',
    _siteInfoTab: 'client',
    _hasMeaningfulLocalDraft() { return true; },
    _checkpointLocalDraftBeforeLoad() { checkpointed = true; },
    _resetSections() {},
    init() { this.job = {}; },
    _ensureFieldSync() {},
    save() {},
    _updateHeaderStatus() {},
    showToast() {}
  };
  const cancelled = startLocalDraft.call(fakeApp);
  confirmed = true;
  const proceeded = startLocalDraft.call(fakeApp);
  record(
    'New Local confirmation gates meaningful draft reset',
    cancelled === false && proceeded === true && checkpointed === true,
    'executed production startLocalDraft twice: cancel preserved draft, confirm checkpointed before reset'
  );
} catch (e) {
  record('New Local confirmation gates meaningful draft reset', false, e.message);
}

record(
  'empty-scope Supabase load fills blank client fields only',
  /_prefillContact\(\{ name: job\.client_name/.test(integration) && /if \(!f\.value\) f\.value = job\.client_name/.test(integration),
  'loadFromSupabase empty-scope client data uses fill-empty helper / non-fencing fill-empty guard'
);

// ── Repeat-client new-job path (P2 fix) ──────────────────────────────────────
const searchLeadsBody = (function () {
  const start = cloud.indexOf('async searchLeads(');
  const end = cloud.indexOf('\n    },', start);
  return start >= 0 && end > start ? cloud.slice(start, end) : '';
})();
record(
  'searchLeads uses the fast lead_search backend action',
  /'lead_search'/.test(searchLeadsBody) && /opts\.signal/.test(searchLeadsBody),
  'cloud.ghl.searchLeads points at lead_search, forwards an abort signal'
);

// Review round 3: a Pages build must not break when it ships ahead of the
// ghl-proxy deploy that adds the lead_search action.
record(
  'searchLeads falls back to the legacy search action (review #10)',
  /_unknownActionSignal\(res, data\)/.test(searchLeadsBody) &&
    /'search' \+ qs/.test(searchLeadsBody) &&
    /res\.status === 404/.test(cloud) &&
    /unknown\|invalid\|unsupported/.test(cloud),
  'an undeployed lead_search (404 / unknown-action 400) retries against action=search'
);

// Review round 5: the fallback is sticky for the session, so the 400ms-debounced
// autocomplete stops paying for a doomed lead_search probe on every keystroke.
record(
  'searchLeads stops re-probing lead_search once it is known missing (review #19)',
  /var _leadSearchUnavailable = false;/.test(cloud) &&
    /if \(!_leadSearchUnavailable\) \{/.test(searchLeadsBody) &&
    /_leadSearchUnavailable = true;/.test(searchLeadsBody),
  'a module-scoped sticky flag keeps post-fallback calls at one request each'
);

// Review round 6: a transient 404/non-JSON blip must fall back for THAT call
// only — latching the session onto legacy search silently drops contact-only
// rows, which are exactly what the repeat-client path exists to find.
record(
  'searchLeads only latches the sticky flag on a confirmed signal (review #21)',
  /return 'confirmed';/.test(cloud) &&
    /return 'maybe';/.test(cloud) &&
    /if \(signal === 'maybe'\) _leadSearchMisses\+\+;/.test(searchLeadsBody) &&
    /signal === 'confirmed' \|\| _leadSearchMisses >= _LEAD_SEARCH_MISS_LIMIT/.test(searchLeadsBody) &&
    /if \(res\.ok\) \{\s*\n\s*_leadSearchMisses = 0;/.test(searchLeadsBody),
  'an ambiguous miss falls back once without latching, and a success resets the counter'
);

// Review round 4: a non-JSON error body (plain-text 404, HTML 502) must not
// throw before the fallback is consulted.
record(
  'searchLeads parses error bodies defensively (review #13)',
  /data = await _safeJson\(res\);/.test(searchLeadsBody) &&
    /async function _safeJson\(res\)/.test(cloud) &&
    /if \(res\.status !== 400 && res\.status !== 404\) return false;[\s\S]{0,1200}?if \(!data\) return 'maybe';/.test(cloud),
  'an unparseable error body still reaches _unknownActionSignal and triggers the legacy fallback'
);

// Review round 3: contact-only is derived once, at the data boundary, so the
// card badge and the tap action can never disagree.
record(
  'searchLeads normalises isContactOnly for every consumer (review #11)',
  /lead\.isContactOnly = \(lead\.id == null\) && !lead\.lookupFailed;/.test(searchLeadsBody) &&
    /var isContactOnly = !!lead\.isContactOnly;/.test(cloud),
  'the render path reads the same normalised flag the selection path branches on'
);

record(
  'createContactAndOpportunity forwards contactId + toolType (AM-A)',
  /if \(contact\.contactId\) body\.contactId = contact\.contactId;/.test(cloud) &&
    /toolType: toolType/.test(cloud),
  'repeat-client contactId is sent in the create_contact_and_opportunity body alongside toolType'
);

record(
  'new-job call site creates the opportunity in the tool-type pipeline (AM-A)',
  /createContactAndOpportunity\(\{\s*contactId: contactId,[\s\S]{0,400}?\}, _toolType, netOpts\)/.test(integration),
  'toolType passed as 2nd arg so the new opp lands in the fencing pipeline'
);

// _startNewJobForContact must NEVER resurrect an old job.
const newJobHelper = (function () {
  const start = integration.indexOf('async function _startNewJobForContact');
  const end = integration.indexOf('\n  // Reset patio tool form', start);
  return start >= 0 && end > start ? integration.slice(start, end) : '';
})();
record(
  'new-job path never loads an existing job/scope',
  newJobHelper.length > 0 &&
    !/loadJob\(/.test(newJobHelper) &&
    !/findJobByOpportunity\(/.test(newJobHelper),
  'no loadJob/findJobByOpportunity inside _startNewJobForContact — the old job stays untouched'
);

record(
  'new-job path confirms + checkpoints a meaningful local draft first (AM-H)',
  /_hasMeaningfulLocalDraft\(\)/.test(newJobHelper) &&
    /Start a new job for/.test(newJobHelper) &&
    /_openFencingTargetSeparately\('repeat_client_new_job'\)/.test(newJobHelper),
  'meaningful local draft is gated by a confirm and checkpointed before reset'
);

record(
  'lead search modal aborts stale requests + guards double-taps (AM-C/AM-F)',
  /new AbortController\(\)/.test(cloud) &&
    /var _seq = 0;/.test(cloud) &&
    /Creating job…/.test(cloud) &&
    /No matches — check spelling or try a phone number\./.test(cloud),
  'showLeadSearch has AbortController + seq guard + in-flight lock + refreshed copy'
);

record(
  'lead cards are keyed by array index, not opp id (AM-D)',
  /data-idx="' \+ idx \+ '"/.test(cloud) &&
    /var lead = leads\[idx\];/.test(cloud) &&
    !/data-oppid/.test(cloud),
  'contact-only rows (null id) are selectable because selection resolves leads[idx]'
);

// Review finding 1: contact-only selections (any mode) use the locked/awaited
// job-creation path so a failed create can't strand the user on a blank scope.
record(
  'contact-only selection always uses the locked create path (review #1)',
  /var createsJob = \(mode === 'new_job'\) \|\| !!lead\.isContactOnly;/.test(cloud) &&
    /if \(createsJob\) \{/.test(cloud),
  'load-mode contact-only rows are locked + awaited, not fire-and-forget'
);

// Review round 3: dismissing the modal mid-create would detach the node the
// error banner mounts into, leaving the user no feedback and no retry.
record(
  'modal dismissal is ignored while a create is in flight (review #12)',
  /function _close\(force\) \{\s*\n\s*if \(_locked && !force\) \{ _flashCreatingStatus\(\); return; \}/.test(cloud) &&
    /_close\(true\);/.test(cloud),
  'backdrop/×/Escape all route through _close, which early-returns while _locked'
);

// Review round 5: a swallowed dismissal must still acknowledge the tap.
record(
  'a dismissal swallowed by the lock flashes the create status (review #18)',
  /function _flashCreatingStatus\(\) \{/.test(cloud) &&
    /_lockedStatusEl = statusEl \|\| null;/.test(cloud),
  'tapping ×/backdrop during a create flashes "Creating job…" instead of no-oping silently'
);

// Review round 5: nothing may leave the modal locked indefinitely — the create
// sequence carries its own abort/timeout so the error banner + retry can render.
record(
  'the new-job create sequence is bounded by a timeout (review #18)',
  /var _NEW_JOB_TIMEOUT_MS = \d+;/.test(integration) &&
    /new AbortController\(\)/.test(newJobHelper) &&
    /_NEW_JOB_TIMEOUT_MS\)/.test(newJobHelper) &&
    /Timed out before we could confirm/.test(newJobHelper) &&
    /clearTimeout\(timer\)/.test(newJobHelper),
  'a stalled create aborts, unlocks the modal and surfaces a timeout error'
);

// Review round 6: an aborted create may have committed the opportunity without
// returning its id, so the timeout path must re-check what exists rather than
// invite a blind retry that mints a second orphan.
record(
  'a timed-out create refreshes the list instead of offering a retry (review #22)',
  /toErr\.code = 'timeout';/.test(newJobHelper) &&
    /err\.code === 'timeout'/.test(cloud) &&
    /_pendingRefreshMsg = /.test(cloud) &&
    /function _takeRefreshNotice\(\)/.test(cloud),
  'the timeout error is tagged and re-runs the search so a committed job surfaces as a loadable row'
);

// The abort signal must actually reach the network layer, or the timeout only
// masks a still-running request.
record(
  'the ghl create calls forward the caller abort signal (review #18)',
  /async getContact\(contactId, opts\)/.test(cloud) &&
    /async createContactAndOpportunity\(contact, toolType, opts\)/.test(cloud) &&
    /async createJobForOpportunity\(opportunityId, toolType, contact, opts\)/.test(cloud) &&
    /function _signalOpts\(opts, base\)/.test(cloud),
  'getContact/createContactAndOpportunity/createJobForOpportunity thread opts.signal into authorizedFetch'
);

// Review round 3: lookupFailed rows are inert, so the failed-create reset must
// not restore them to full opacity and make them look tappable.
record(
  'failed-create reset keeps lookupFailed rows dimmed (review #13)',
  /if \(c\.getAttribute\('data-locked'\) === '1'\) return;\s*\n\s*c\.style\.pointerEvents = '';/.test(cloud),
  'the error-path opacity reset skips data-locked cards'
);

// Review finding 3: the new job row must carry ghl_contact_id (not NULL).
record(
  'new-job create_job payload carries the contactId (review #3)',
  /contactId: newContactId \|\| null,/.test(newJobHelper),
  'contactForJob includes contactId so createJobForOpportunity forwards ghl_contact_id'
);

// Review round 2: every network create must complete BEFORE any state/form
// mutation, so a failed create leaves the scoper's job + draft untouched.
record(
  'new-job path creates before it resets (review #4)',
  newJobHelper.indexOf('createJobForOpportunity(') > 0 &&
    newJobHelper.indexOf('createJobForOpportunity(') < newJobHelper.indexOf("_openFencingTargetSeparately('repeat_client_new_job')") &&
    newJobHelper.indexOf('createContactAndOpportunity(') < newJobHelper.indexOf('cloud.stopAutoSave()') &&
    newJobHelper.indexOf('_ghlOpportunityId = newOppId;') > newJobHelper.indexOf('createJobForOpportunity('),
  'contact fetch + opportunity + job creates all precede the checkpoint/reset and state assignment'
);

record(
  'new-job path clears the previous GHL ids on reset (review #4)',
  /_ghlOpportunityId = null;/.test(newJobHelper) && /_ghlContactId = null;/.test(newJobHelper),
  'stale opportunity/contact ids cannot survive into the new job'
);

record(
  'new-job path reuses a cached opportunity on retry (review #5)',
  /_pendingNewOpps\[contactId\]/.test(newJobHelper) && /if \(!newOppId\) \{/.test(newJobHelper),
  'a retry after a failed create_job reuses the opportunity instead of minting an orphan'
);

// Review round 4: the retry cache must outlive the modal re-render that a
// re-search performs, and must not be reused once the job actually lands.
record(
  'new-job opportunity cache is module-scoped and keyed by contact (review #16)',
  /var _pendingNewOpps = \{\};/.test(integration) &&
    !/row\._createdOppId/.test(integration) &&
    /delete _pendingNewOpps\[contactId\];/.test(newJobHelper),
  'the orphan guard survives a re-search and is cleared once the job is created'
);

// Review round 4: the full contact is fetched before the create, so the
// opportunity create must not send blank names/phones over the top of it.
record(
  'new-job path sends real contact fields to createContactAndOpportunity (review #17)',
  /createContactAndOpportunity\(\{[\s\S]{0,400}?contact && contact\.name[\s\S]{0,400}?\}, _toolType, netOpts\)/.test(newJobHelper),
  'the already-fetched contact details are passed through rather than empty strings'
);

record(
  'new-job path requires a known contactId (review #6)',
  /if \(!contactId\) throw new Error\(/.test(newJobHelper),
  'a contact-less row is rejected before any network call, so no blank GHL contact is created'
);

// Review round 3: the new job is editable and its URL drops the frozen
// revision, so the load-time readonly flag must not survive and mute autosave.
record(
  'new-job path clears the load-time readonly flag (review #14)',
  /_isReadonly = false;/.test(newJobHelper) &&
    /classList\.remove\('readonly-mode'\)/.test(newJobHelper) &&
    newJobHelper.indexOf('_isReadonly = false;') < newJobHelper.indexOf('_shouldAutoSave()'),
  'a new job started from a frozen sent-job viewer still autosaves to the cloud'
);

// Review round 4: clearing the readonly flag is not enough — the frozen
// viewer's banner controls close over the OLD revision/job.
record(
  'new-job path tears down the frozen viewer chrome (review #14b)',
  /_clearFrozenViewerChrome\(\);/.test(newJobHelper) &&
    /function _clearFrozenViewerChrome\(\)/.test(integration) &&
    /'sw-frozen-revision-banner', 'sw-frozen-error-banner'/.test(integration) &&
    /banner\.dataset\.swPadTop = '36';/.test(integration) &&
    /banner\.dataset\.swPadTop = '32';/.test(integration),
  'the sealed-revision banner and its reserved body padding are removed for the new editable job'
);

// Review round 3: a created job must show its ref immediately.
record(
  'new-job path applies the created job number (review #15)',
  /_lastJobNumber = job\.job_number \|\| null;/.test(newJobHelper) &&
    /if \(_lastJobNumber\) _applyJobNumber\(_lastJobNumber\);/.test(newJobHelper) &&
    /if \(!localDraftWins && _lastJobNumber\) _applyJobNumber\(_lastJobNumber\);/.test(integration),
  'both the repeat-client and lead_search create branches populate + apply job_number'
);

record(
  'contact-only selection never falls through to the load path (review #7)',
  /if \(opp\.isContactOnly \|\| opp\.id == null\) \{[\s\S]{0,240}startNewJobForContact\)\s*\{[\s\S]{0,200}return;/.test(index),
  'selectGHLContact early-returns on contact-only rows even when the helper is missing'
);

// Review round 5: the autocomplete exposes the same job-minting action as the
// lead modal, so it must carry the same warning affordances.
record(
  'the autocomplete labels contact-only rows like the lead modal (review #20)',
  /const isContactOnly = opp\.isContactOnly \|\| opp\.id == null;/.test(index) &&
    /isContactOnly[\s\S]{0,200}>Contact</.test(index) &&
    /isContactOnly \? '<div[^']*>Creates a new job for this client/.test(index),
  'a contact-only dropdown row shows the grey Contact badge + "Creates a new job" caption'
);

// A video-retry timer left armed across a reset re-reads _jobId when it fires,
// so it would upload the previous client's walkthrough to the new job.
record(
  'the fencing reset cancels a pending video-retry timer (review #21)',
  /_videoRetryTimer = setTimeout\(/.test(integration) &&
    /if \(_videoRetryTimer\) \{ clearTimeout\(_videoRetryTimer\); _videoRetryTimer = null; \}[\s\S]{0,60}_videoRetryCount = 0;/.test(integration) &&
    /if \(_jobId !== jobId\) return;/.test(integration),
  'the retry timer is tracked, cleared on reset with the retry count, and bails if the job changed'
);

// A 500 or a payload-validation 400 must never latch the session onto the
// legacy search action, which cannot return contact-only rows.
record(
  'only a route-shaped status can confirm an unknown action (review #22)',
  /if \(res\.status !== 400 && res\.status !== 404\) return false;/.test(cloud) &&
    /res\.status === 404 && msg\.indexOf\('action'\) !== -1/.test(cloud) &&
    /if \(signal === 'maybe'\) _leadSearchMisses\+\+; else _leadSearchMisses = 0;/.test(cloud),
  'a 5xx never confirms, 400 prose never confirms (only an explicit code does), and the miss streak resets on any non-maybe outcome'
);

// _rethrow is shared by the modal and the autocomplete, so its message cannot
// promise a list refresh that only one of them performs.
record(
  'the timeout error is surface-neutral and both callers recover (review #23)',
  !/Timed out — refreshing the list/.test(integration) &&
    /Timed out before we could confirm whether the job was created/.test(integration) &&
    /if \(e && e\.code === 'timeout'\)[\s\S]{0,400}_searchGHLContacts\(q\)/.test(index),
  'the autocomplete re-runs its own search on timeout rather than showing the modal-only text'
);

// Dead code that duplicates the live reset silently drifts from it.
record(
  'the unreachable cloud-load reset is gone (review #24)',
  !/_resetFencingForCloudLoad/.test(integration),
  'the fencing reset lives only in _openFencingTargetSeparately'
);

console.log('CP2 Fence launch/save-state harness');
for (const row of passes) {
  console.log(`PASS ${row.id}`);
  console.log(`  evidence: ${row.evidence}`);
}
for (const row of failures) {
  console.log(`FAIL ${row.id}`);
  console.log(`  evidence: ${row.evidence}`);
}
console.log(`\nSummary: ${passes.length} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

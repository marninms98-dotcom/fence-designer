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
  'launcher has the three approved entry points',
  has(index, 'showLaunchModal()') && has(index, '1. Load GHL lead/contact') && has(index, '2. Resume draft / previous scope') && has(index, '3. Start new local draft'),
  'launcher strings and showLaunchModal present'
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
  /_resetFencingForCloudLoad/.test(integration) && /_checkpointLocalDraftBeforeLoad\(source/.test(integration) && /Local draft checkpointed before/.test(integration),
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

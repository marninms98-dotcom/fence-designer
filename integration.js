// ════════════════════════════════════════════════════════════
// SecureWorks — Tool Integration Layer
//
// Drop this into any scoping tool to add cloud features:
//   - Login / auth
//   - Save to cloud / load from cloud
//   - Job picker
//   - Auto-save
//   - Online/offline indicator
//
// Detects tool type from the page title or a data attribute.
// Requires cloud.js to be loaded first.
//
// Usage (add before </body> in any tool):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script>
//     window.SUPABASE_URL = 'https://kevgrhcjxspbxgovpmfl.supabase.co';
//     window.SUPABASE_ANON_KEY = 'eyJ...';
//   </script>
//   <script src="../shared/brand.js"></script>
//   <script src="../shared/cloud.js"></script>
//   <script src="../shared/integration.js"></script>
// ════════════════════════════════════════════════════════════

(function() {
  'use strict';

  console.log('[Integration] Script loaded');

  var cloud = null;
  var _jobId = null;
  var _ghlOpportunityId = null;
  var _ghlContactId = null;
  var _toolType = null;
  var _lastJobNumber = null;
  var _getStateFn = null;
  var _loadStateFn = null;
  var _jobLoaded = false;
  var _isSignOff = false; // Set true only during saveAfterSignOff — gates GHL link + job number
  var _jobStatus = null;  // Tracks loaded job status — gates auto-save for non-draft jobs
  var _baseScopeHash = null; // Latest server scope hash this iPad loaded/saved against
  var _baseScopeUpdatedAt = null;
  var _scopeCursorJobId = null; // Proven owner of the server-issued cursor above
  var _lastReleasePartialFailures = [];
  var _authChangeSubscribers = []; // Tools subscribe via integration.onAuthChange()
  // Background upload tracking: maps photo/video id -> { promise, done: bool, error: Error|null }
  var _bgUploads = {};
  // Site video uploads NON-BLOCKING with bounded auto-retry: create-job never waits on it.
  var _VIDEO_MAX_RETRIES = 3;
  var _videoRetryCount = 0;
  // Pending video-retry timer. It closes over the video object and re-reads
  // _jobId when it fires, so a reset that leaves it armed would upload the
  // previous client's walkthrough to the new job.
  var _videoRetryTimer = null;
  // Bumped by every fencing media reset. A deferred upload compares against it so
  // it can tell a job SWAP (media wiped, must not upload) apart from the same
  // draft being promoted from a local- id to its real cloud id.
  var _mediaEpoch = 0;
  // Opportunities minted by a repeat-client new-job attempt whose job create then
  // failed, keyed by GHL contactId. Survives the modal re-render so a retry reuses
  // the orphan instead of minting another; cleared once the job lands.
  var _pendingNewOpps = {};
  var _scopeRecoveryPromise = null;
  var _scopeRecoveryKey = null;
  // Every supported fencing launch/load door must obtain a short-lived permit
  // from _enterJob before it may resolve or change identity. The permit is kept
  // private to this IIFE; raw create/load helpers cannot manufacture one.
  var _entrySequence = 0;
  var _activeEntryPermit = null;
  var _entryAudit = [];

  // Selecting a real opportunity row for this contact settles the earlier failed
  // attempt: either it committed after all (a timed-out create can land without
  // its id ever reaching us) or the scoper has moved on. Either way the cached
  // opportunity must not be reused by a later, legitimately-new job for the same
  // contact — that would hang a second Supabase job off one opportunity and make
  // findJobByOpportunity ambiguous.
  function _clearPendingNewOpp(contactId) {
    if (contactId) delete _pendingNewOpps[contactId];
  }
  // Ceiling on the repeat-client create sequence (contact fetch + opportunity +
  // job) so the lead-search modal's in-flight lock can never outlive it.
  var _NEW_JOB_TIMEOUT_MS = 45000;
  // Readonly applies when ?mode=readonly OR ?scope_revision_id is supplied
  // (frozen-revision viewer must not write — Scope-Memory-Saving step 8 Option B).
  var _isReadonly = (function() {
    var p = new URLSearchParams(window.location.search);
    return p.get('mode') === 'readonly' || !!p.get('scope_revision_id');
  })();

  // Auto-save only allowed for draft/new jobs — never for quoted/accepted/scheduled/in_progress/completed
  function _shouldAutoSave() {
    if (_isReadonly) return false;
    var blocked = ['quoted', 'accepted', 'scheduled', 'in_progress', 'completed'];
    return blocked.indexOf(_jobStatus) === -1;
  }

  function _isRealJobId(id) {
    return !!(id && String(id).indexOf('local-') !== 0 && String(id).indexOf('local-fence-') !== 0);
  }

  function _hasReleaseAnchor() {
    return _isRealJobId(_jobId) || !!_ghlOpportunityId;
  }

  function _rememberScopeCursor(job) {
    if (!job) return;
    var hash = job.current_scope_hash || job.currentScopeHash || null;
    var updatedAt = job.current_scope_updated_at || job.updated_at || null;
    if (hash) {
      // A hash and its proven owner are written as one unit. Without an owner
      // the hash is unprovenanced, so it must not be retained at all.
      var owner = job.id || job.job_id || (_isRealJobId(_jobId) ? _jobId : null) || null;
      _baseScopeHash = owner ? hash : null;
      _scopeCursorJobId = owner;
    }
    if (updatedAt) _baseScopeUpdatedAt = updatedAt;
    if (_toolType === 'fencing' && window.app && window.app.job && (_baseScopeHash || _baseScopeUpdatedAt)) {
      var fs = window.app.job._fieldSync || (window.app.job._fieldSync = {});
      if (_baseScopeHash) {
        fs.baseScopeHash = _baseScopeHash;
        fs.currentScopeHash = _baseScopeHash;
      }
      if (_baseScopeUpdatedAt) fs.scopeUpdatedAt = _baseScopeUpdatedAt;
      fs.lastCloudCursorAt = new Date().toISOString();
    }
  }

  function _attachScopeSaveCursor(meta) {
    meta = meta || {};
    if (_toolType === 'fencing' && _isRealJobId(_jobId)) {
      // Capability is fence-only and advisory. It permits capability-scoped
      // strictness without changing any server CAS/ref/org guard.
      meta.scopeCursorReconcileV1 = true;
      if (_baseScopeHash && String(_scopeCursorJobId || '') === String(_jobId)) {
        meta.baseScopeHash = _baseScopeHash;
        meta.scopeCursorJobId = _scopeCursorJobId;
        meta.scopeCursorProvenance = 'server_issued';
      }
    }
    return meta;
  }

  function _isScopeHashConflict(e) {
    var code = e && (e.code || (e.details && e.details.code));
    var msg = String((e && (e.message || e.error)) || e || '');
    return ['scope_hash_conflict', 'missing_scope_cursor', 'scope_ref_mismatch'].indexOf(code) !== -1 ||
      /scope_hash_conflict|missing_scope_cursor|scope_ref_mismatch|Scope changed in Supabase/i.test(msg);
  }

  function _hasDirtyFencingDraft() {
    if (_toolType !== 'fencing' || !window.app || !window.app.job) return false;
    if (window.app._hasMeaningfulLocalDraft && !window.app._hasMeaningfulLocalDraft()) return false;
    var fs = window.app.job._fieldSync || {};
    return !!(fs.localDraftId || fs.lastLocalEditAt || fs.syncState || window.app._hasMeaningfulLocalDraft());
  }

  function _checkpointLocalDraftBeforeLoad(source) {
    if (_toolType !== 'fencing' || !window.app || !window.app._checkpointLocalDraftBeforeLoad) return false;
    var checkpointed = !!window.app._checkpointLocalDraftBeforeLoad(source || 'cloud_load');
    if (_hasDirtyFencingDraft() && (!checkpointed || !_verifiedFenceCheckpoint(source || 'cloud_load'))) {
      throw _entryError('checkpoint_failed', 'Could not verify the local checkpoint. The current fence scope was kept open and the target was not switched.');
    }
    return checkpointed;
  }

  function _scopeSaveReason(value) {
    var error = value && value.error ? value.error : value;
    return error && (error.reason || error.code || (error.details && (error.details.reason || error.details.code))) || null;
  }

  function _isRealFenceRef(ref) {
    return /^SWF?-?\d+/i.test(String(ref || '').trim());
  }

  function _scopeIdentityMatchesTarget(scope, serverJob, error) {
    if (!scope || !serverJob || !error) return false;
    var targetId = String(error.targetJobId || error.jobId || '');
    if (!targetId || targetId !== String(_jobId || '') || targetId !== String(serverJob.id || '')) return false;
    if (error.serverJobId && String(error.serverJobId) !== targetId) return false;
    var localJob = scope.job || {};
    var localRef = localJob.ref || scope.job_ref || '';
    var serverRef = serverJob.job_number || serverJob.jobNumber || '';
    if (_isRealFenceRef(localRef) && _isRealFenceRef(serverRef)) {
      return String(localRef).toUpperCase() === String(serverRef).toUpperCase();
    }
    var fs = localJob._fieldSync || scope._fieldSync || {};
    return fs.syncAnchorType === 'job' && String(fs.syncAnchorId || '') === targetId;
  }

  // Empty means exactly an object with no own keys. null, an absent projection,
  // malformed JSON and partial load responses are UNKNOWN, never "empty".
  function _provenEmptyServerScope(serverJob) {
    if (!serverJob || !Object.prototype.hasOwnProperty.call(serverJob, 'scope_json')) return false;
    var scope = serverJob.scope_json;
    return !!scope && Object.prototype.toString.call(scope) === '[object Object]' && Object.keys(scope).length === 0;
  }

  // Only a present, non-empty object scope is safe to hydrate into the form or
  // to compare against. null, an absent projection and partial load responses
  // are UNKNOWN, so divergence recovery must not offer "take server" for them.
  function _usableServerScope(serverJob) {
    if (!serverJob || !Object.prototype.hasOwnProperty.call(serverJob, 'scope_json')) return false;
    var scope = serverJob.scope_json;
    return !!scope && Object.prototype.toString.call(scope) === '[object Object]' && Object.keys(scope).length > 0;
  }

  function _sameScopePayload(a, b) {
    if (!a || !b) return false;
    try {
      var stable = function(value) {
        return JSON.stringify(value, function(key, item) { return key === 'savedAt' ? undefined : item; });
      };
      return stable(a) === stable(b);
    } catch(e) { return false; }
  }

  function _verifiedFenceCheckpoint(source) {
    if (_toolType !== 'fencing' || !window.app || !window.app.job) return false;
    if (window.app._hasMeaningfulLocalDraft && !window.app._hasMeaningfulLocalDraft()) return true;
    var fs = window.app.job._fieldSync || {};
    var localDraftId = fs.localDraftId;
    if (!localDraftId) return false;
    try {
      var snapshot = { job: window.app.job, source: source, savedAt: new Date().toISOString() };
      var raw = JSON.stringify(snapshot);
      var key = 'fenceJob_checkpoint_' + localDraftId;
      localStorage.setItem(key, raw);
      return localStorage.getItem(key) === raw;
    } catch(e) {
      console.warn('[FenceSync] Verified recovery checkpoint failed:', e);
      return false;
    }
  }

  // Only states whose cause may clear on its own (transport/network) get a Retry
  // button. Re-arming autosave on a latched conflict would just re-send the exact
  // payload the server already rejected and loop the divergence modal.
  var _RETRYABLE_RECOVERY_STATES = ['transport_exhausted', 'retry_exhausted', 'server_check_failed', 'recovery_failed'];

  function _showScopeRecoveryState(kind, message) {
    if (cloud && cloud.ui) cloud.ui.showSaveStatus('error', message);
    var banner = document.getElementById('sw-scope-recovery-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sw-scope-recovery-banner';
      banner.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:10120;background:#7F1D1D;color:#fff;padding:12px 16px;border-radius:6px;font:600 13px/1.35 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;justify-content:space-between';
      banner.innerHTML = '<span id="sw-scope-recovery-text" style="flex:1"></span><button id="sw-scope-recovery-retry" style="flex:0 0 auto;padding:8px 14px;border:0;border-radius:4px;background:#fff;color:#7F1D1D;font-weight:700;font-size:13px">Retry sync</button>';
      document.body.appendChild(banner);
      document.getElementById('sw-scope-recovery-retry').onclick = function() {
        _clearScopeRecoveryState();
        if (cloud && cloud.resumeAutoSave) cloud.resumeAutoSave({ immediate: true });
        if (cloud && cloud.ui) cloud.ui.showSaveStatus('saving', 'Retrying sync…');
      };
    }
    banner.dataset.state = kind;
    document.getElementById('sw-scope-recovery-text').textContent = message;
    document.getElementById('sw-scope-recovery-retry').style.display =
      _RETRYABLE_RECOVERY_STATES.indexOf(kind) === -1 ? 'none' : '';
  }

  function _clearScopeRecoveryState() {
    var banner = document.getElementById('sw-scope-recovery-banner');
    if (banner) banner.remove();
  }

  function _askScopeDivergenceOnce(key) {
    if (_scopeRecoveryPromise && _scopeRecoveryKey === key) return _scopeRecoveryPromise;
    _scopeRecoveryKey = key;
    _scopeRecoveryPromise = new Promise(function(resolve) {
      var old = document.getElementById('sw-scope-divergence-modal');
      if (old) old.remove();
      var overlay = document.createElement('div');
      overlay.id = 'sw-scope-divergence-modal';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(41,60,70,.76);z-index:10130;display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif';
      overlay.innerHTML = '<div style="background:#fff;max-width:520px;width:100%;border-radius:6px;overflow:hidden"><div style="background:#293C46;color:#fff;padding:18px 20px"><b style="font-size:18px">Two saved fence scopes differ</b><div style="font-size:12px;margin-top:5px;opacity:.8">Choose one version. Your iPad draft is retained until a choice completes.</div></div><div style="padding:18px;display:grid;gap:10px"><button id="swKeepIpad" style="padding:13px;border:1px solid #F15A29;background:#FFF7ED;color:#9A3412;font-weight:700">Keep iPad</button><button id="swTakeServer" style="padding:13px;border:1px solid #4C6A7C;background:#fff;color:#293C46;font-weight:700">Take server</button><button id="swCancelRecovery" style="padding:11px;border:0;background:#F5F5F5;color:#4B5563">Cancel</button></div></div>';
      document.body.appendChild(overlay);
      var finish = function(choice) {
        if (overlay.parentNode) overlay.remove();
        _scopeRecoveryPromise = null;
        _scopeRecoveryKey = null;
        resolve(choice);
      };
      document.getElementById('swKeepIpad').onclick = function() { finish('keep'); };
      document.getElementById('swTakeServer').onclick = function() { finish('take'); };
      document.getElementById('swCancelRecovery').onclick = function() { finish('cancel'); };
    });
    return _scopeRecoveryPromise;
  }

  async function _retryReconciledScopeOnce(error, attemptedScope, cursorJob, queuedScope) {
    _rememberScopeCursor(cursorJob || { current_scope_hash: error.current_scope_hash });
    var meta = _attachScopeSaveCursor({
      _flushAttempt: true,
      scopeCursorReconcileV1: true,
      reconcileRequestId: error.requestId || null
    });
    var saved = await cloud.ghl.saveScope(_jobId, attemptedScope, meta);
    if (!saved || saved.queued) throw new Error('Reconciled save was not confirmed by the server');
    _rememberScopeCursor(saved);
    if (cloud.discardQueuedScopePayload) {
      cloud.discardQueuedScopePayload(_jobId, attemptedScope);
      if (queuedScope && queuedScope !== attemptedScope) cloud.discardQueuedScopePayload(_jobId, queuedScope);
    }
    _clearScopeRecoveryState();
    if (cloud.resumeAutoSave) cloud.resumeAutoSave({ immediate: false });
    cloud.ui.showSaveStatus('saved');
    return saved;
  }

  async function _handleScopeSaveError(event) {
    event = event || {};
    var error = event.error || event;
    var reason = _scopeSaveReason(error);
    var attemptedScope = event.attemptedScope || null;
    if (['scope_hash_conflict', 'scope_ref_mismatch', 'missing_scope_cursor'].indexOf(reason) === -1) {
      if (event.retryStopped) _showScopeRecoveryState('retry_exhausted', 'Cloud sync stopped after five attempts. Your iPad draft is retained. Edit or retry when connected.');
      return false;
    }
    // The scope-cursor plumbing (and its checkpoint) is fencing-only, so a typed
    // conflict on another tool has no working recovery branch here. Hand it back
    // to the pre-existing error path instead of opening an unresolvable modal.
    if (_toolType !== 'fencing') return false;

    if (reason === 'scope_ref_mismatch') {
      _showScopeRecoveryState('identity_recovery_required', 'Wrong job identity blocked this save. Your iPad draft is retained. Open the correct job or use identity recovery when available.');
      return true;
    }

    if (!attemptedScope || String(error.targetJobId || error.jobId || '') !== String(_jobId || '')) {
      _showScopeRecoveryState('identity_unproven', 'Sync stopped because this draft could not be proven to belong to the target job. Your iPad draft is retained.');
      return true;
    }

    var serverJob;
    try {
      serverJob = error.loadServerScope ? await error.loadServerScope() : await cloud.ghl.loadJob(_jobId);
    } catch(loadError) {
      _showScopeRecoveryState('server_check_failed', 'Could not verify the server scope. Your iPad draft is retained; retry when connected.');
      return true;
    }
    if (!_scopeIdentityMatchesTarget(attemptedScope, serverJob, error)) {
      _showScopeRecoveryState('identity_unproven', 'Sync stopped because payload ownership could not be verified. Your iPad draft is retained.');
      return true;
    }
    var cursor = serverJob.current_scope_hash || error.current_scope_hash || null;
    if (!cursor) {
      _showScopeRecoveryState('cursor_missing', 'The server did not issue a scope cursor. Your iPad draft is retained and no write was attempted.');
      return true;
    }

    if (_provenEmptyServerScope(serverJob) || (reason === 'missing_scope_cursor' && _sameScopePayload(attemptedScope, serverJob.scope_json))) {
      try {
        await _retryReconciledScopeOnce(error, attemptedScope, serverJob);
      } catch(retryError) {
        console.warn('[FenceSync] Empty-scope recovery retry failed:', retryError);
        _showScopeRecoveryState('retry_failed', 'Recovery retry failed. Your iPad draft is retained; no further automatic retry will run.');
      }
      return true;
    }

    if (!_usableServerScope(serverJob)) {
      _showScopeRecoveryState('server_scope_unknown', 'The server did not return a readable scope to compare against. Your iPad draft is retained and nothing was overwritten.');
      return true;
    }

    var recoveryKey = String(_jobId) + ':' + (event.fingerprint || error.requestId || cursor);
    _showScopeRecoveryState('divergence', 'The iPad and server scopes differ. Choose which one to keep.');
    var choice = await _askScopeDivergenceOnce(recoveryKey);
    if (choice === 'cancel') {
      _showScopeRecoveryState('cancelled', 'Recovery cancelled. Your iPad draft is retained and no remote write was made.');
      return true;
    }
    if (choice === 'keep') {
      var currentScope = _getStateFn();
      if (!_scopeIdentityMatchesTarget(currentScope, serverJob, error)) {
        _showScopeRecoveryState('identity_unproven', 'Keep iPad stopped because payload ownership changed. Your local draft is retained.');
        return true;
      }
      if (!_verifiedFenceCheckpoint('scope_conflict_keep')) {
        _showScopeRecoveryState('checkpoint_failed', 'Could not verify the local checkpoint. Nothing was written; your iPad draft remains open.');
        return true;
      }
      try {
        await _retryReconciledScopeOnce(error, currentScope, serverJob, attemptedScope);
      } catch(keepError) {
        _showScopeRecoveryState('keep_failed', 'Keep iPad failed. Your local draft is retained and automatic retries remain stopped.');
      }
      return true;
    }

    if (!_verifiedFenceCheckpoint('scope_conflict_take')) {
      _showScopeRecoveryState('checkpoint_failed', 'Could not verify the local checkpoint. Nothing was overwritten; your iPad draft remains open.');
      return true;
    }
    try {
      var loaded = _loadStateFn(serverJob.scope_json);
      if (loaded === false || !_getStateFn()) throw new Error('Server scope hydration could not be verified');
      _rememberScopeCursor(serverJob);
      _linkFencingAnchor(serverJob.id, serverJob.ghl_opportunity_id, serverJob.ghl_contact_id, 'conflict_take_server');
      _clearScopeRecoveryState();
      if (cloud.resumeAutoSave) cloud.resumeAutoSave({ immediate: false });
      cloud.ui.showSaveStatus('saved', 'Server scope loaded');
    } catch(hydrateError) {
      _showScopeRecoveryState('hydrate_failed', 'Server scope could not be verified after load. Your iPad checkpoint is retained.');
    }
    return true;
  }

  // window.sitePhotos / window.siteVideo are globals that app.init() does not
  // touch, so without this a reset leaves the PREVIOUS job's media in the queue:
  // load paths only mask it by calling _loadCloudMedia straight after, and the
  // repeat-client path creates an empty job and loads nothing. The _bgUploads
  // entries go with them — a surviving '__video__' entry makes _startBgVideoUpload
  // skip the next job's video entirely, and stale keys skew _mediaUploadGate.
  // Tool-agnostic: every reset path (fencing and patio) goes through it, so the
  // cross-client leak protection cannot fall off one branch.
  function _resetToolMediaState() {
    if (typeof window.sitePhotos !== 'undefined') window.sitePhotos = [];
    if (typeof window.siteVideo !== 'undefined') window.siteVideo = null;
    if (_videoRetryTimer) { clearTimeout(_videoRetryTimer); _videoRetryTimer = null; }
    _videoRetryCount = 0;
    _mediaEpoch++;
    _bgUploads = {};
    if (typeof window.renderPhotoGrid === 'function') window.renderPhotoGrid();
    if (typeof window.updatePhotoCount === 'function') window.updatePhotoCount();
  }

  // Dirty local draft checkpoint/reconcile seam: the local iPad draft wins over
  // incoming cloud state, so it is checkpointed before the form is reset.
  function _openFencingTargetSeparately(source) {
    if (_toolType !== 'fencing' || !window.app) return true;
    _checkpointLocalDraftBeforeLoad((source || 'cloud_load') + '_open_separately');
    localStorage.removeItem('fenceJob');
    window.app.job = null;
    window.app.currentRunId = null;
    if (typeof window.app._resetSections === 'function') window.app._resetSections();
    window.app.init();
    _resetToolMediaState();
    localStorage.removeItem('fenceQA_verification');
    if (typeof window.fenceQA !== 'undefined') window.fenceQA._verificationState = {};
    return true;
  }

  function _currentFencingTargetKey() {
    if (_toolType !== 'fencing' || !window.app || !window.app.job) return '';
    var fs = window.app.job._fieldSync || {};
    if (fs.syncAnchorType === 'job' && fs.syncAnchorId) return 'job:' + fs.syncAnchorId;
    if (fs.syncAnchorType === 'ghl_opportunity' && fs.syncAnchorId) return 'opp:' + fs.syncAnchorId;
    if (_isRealJobId(_jobId)) return 'job:' + _jobId;
    if (_ghlOpportunityId) return 'opp:' + _ghlOpportunityId;
    return fs.localDraftId ? 'local:' + fs.localDraftId : '';
  }

  function _targetKey(target) {
    target = target || {};
    if (target.jobId) return 'job:' + target.jobId;
    if (target.opportunityId) return 'opp:' + target.opportunityId;
    if (target.localDraftId) return 'local:' + target.localDraftId;
    if (target.scopeRevisionId) return 'revision:' + target.scopeRevisionId;
    return '';
  }

  function _restoreCurrentFenceUrl() {
    var currentId = _isRealJobId(_jobId) ? _jobId : null;
    if (!currentId && window.app && window.app.job && window.app.job._fieldSync) {
      var fs = window.app.job._fieldSync;
      if (fs.syncAnchorType === 'job' && _isRealJobId(fs.syncAnchorId)) currentId = fs.syncAnchorId;
    }
    var url = window.location.pathname + (currentId ? '?jobId=' + encodeURIComponent(currentId) : '');
    window.history.replaceState({}, '', url);
  }

  function _entryError(code, message, details) {
    var error = new Error(message);
    error.code = code;
    error.reason = code;
    error.details = details || null;
    return error;
  }

  function _recordEntry(intent, target, state) {
    _entryAudit.push({
      sequence: ++_entrySequence,
      intent: intent,
      targetKey: _targetKey(target),
      state: state,
      at: new Date().toISOString()
    });
    if (_entryAudit.length > 40) _entryAudit.shift();
  }

  function _localCheckpointMatches(row) {
    if (_toolType !== 'fencing' || !window.app || !window.app._listLocalDraftCheckpoints) return [];
    var contactId = String(row && row.contactId || '');
    var email = String(row && (row.contactEmail || row.email) || '').trim().toLowerCase();
    var phone = String(row && (row.contactPhone || row.phone) || '').replace(/\D/g, '');
    return window.app._listLocalDraftCheckpoints().filter(function(item) {
      var job = item.job || {};
      var fs = job._fieldSync || {};
      if (contactId && String(fs.ghlContactId || '') === contactId) return true;
      if (email && String(job.email || '').trim().toLowerCase() === email) return true;
      return phone && String(job.phone || '').replace(/\D/g, '') === phone;
    });
  }

  // The guarded fencing entry owner. It deliberately performs identity
  // resolution before granting a permit to a door. Existing GHL APIs cannot
  // atomically prove contact/type uniqueness before minting, so unresolved or
  // ambiguous rows stop here with the exact later server requirement rather
  // than falling through to the legacy browser mint sequence.
  async function _enterJob(intent, target) {
    target = target || {};
    var allowed = ['new_local', 'resume_local', 'ghl_context', 'existing_job', 'editable_scope', 'frozen_revision', 'amendment'];
    if (allowed.indexOf(intent) === -1) throw _entryError('unsupported_entry_intent', 'Unsupported fence entry intent: ' + intent);
    _recordEntry(intent, target, 'requested');

    if (_toolType !== 'fencing') {
      var nonFencePermit = { id: ++_entrySequence, intent: intent, target: target };
      _activeEntryPermit = nonFencePermit;
      return nonFencePermit;
    }

    if (intent === 'ghl_context') {
      var row = target.row || {};
      if (row.lookupFailed || row.mappingAmbiguous || row.ambiguous || row.duplicateMapping) {
        _recordEntry(intent, target, 'ambiguous_stopped');
        throw _entryError('ambiguous_identity', 'This GHL mapping could not be resolved safely. Choose a specific existing job; no new job was created.');
      }

      var localMatches = _localCheckpointMatches(row);
      if (localMatches.length > 1) {
        _recordEntry(intent, target, 'ambiguous_checkpoints_stopped');
        throw _entryError('ambiguous_local_checkpoints', 'More than one local checkpoint matches this client. Resume a specific checkpoint before linking; no new job was created.', { count: localMatches.length });
      }
      target.localCheckpoint = localMatches[0] || null;

      var resolvedJob = null;
      if (row.supabaseJobId) {
        resolvedJob = { id: row.supabaseJobId };
      } else if (row._supabaseJobId) {
        resolvedJob = { id: row._supabaseJobId };
      } else if (row.id) {
        try {
          resolvedJob = await cloud.ghl.findJobByOpportunity(row.id, _toolType);
        } catch (lookupError) {
          _recordEntry(intent, target, 'mapping_lookup_failed');
          throw _entryError('identity_lookup_failed', 'Could not verify Supabase scope history for this opportunity. Retry the search; no new job was created.');
        }
      }
      if (Array.isArray(resolvedJob) || (resolvedJob && resolvedJob.ambiguous)) {
        _recordEntry(intent, target, 'duplicate_jobs_stopped');
        throw _entryError('ambiguous_identity', 'Multiple Supabase jobs map to this GHL context. Choose a specific job; no new job was created.');
      }
      if (!resolvedJob || !resolvedJob.id) {
        _recordEntry(intent, target, 'server_mint_required');
        throw _entryError(
          'server_mint_required',
          'No safely resolved fence job exists for this GHL context. A later server mint command must atomically search scope history, serialize contact/type deduplication, and return one idempotent job. Nothing was created.'
        );
      }
      row.supabaseJobId = resolvedJob.id;
      row._supabaseJobId = resolvedJob.id;
      target.jobId = resolvedJob.id;
      if (target.requestNew) {
        _recordEntry(intent, target, 'server_repeat_mint_required');
        throw _entryError(
          'server_mint_required',
          'A new fence job for this client requires the later server mint command to serialize contact/type deduplication and return an idempotent child. The existing job was left unchanged.'
        );
      }
    }

    var permit = { id: ++_entrySequence, intent: intent, target: target };
    _activeEntryPermit = permit;
    _recordEntry(intent, target, 'permitted');
    return permit;
  }

  function _requireEntryPermit(permit, intents) {
    if (!permit || permit !== _activeEntryPermit || intents.indexOf(permit.intent) === -1) {
      throw _entryError('entry_funnel_required', 'This job action must start through the guarded fence entry funnel.');
    }
    return permit;
  }

  function _scrubCrossJobIdentity(jobId, opportunityId, contactId, launchMode) {
    if (_toolType !== 'fencing' || !window.app || !window.app.job) return;
    var fs = window.app.job._fieldSync || (window.app.job._fieldSync = {});
    var oldKey = fs.syncAnchorType && fs.syncAnchorId ? fs.syncAnchorType + ':' + fs.syncAnchorId : '';
    var nextKey = jobId ? 'job:' + jobId : (opportunityId ? 'ghl_opportunity:' + opportunityId : 'local_only:');
    if (oldKey && oldKey === nextKey) return;

    ['baseScopeHash', 'currentScopeHash', 'scopeUpdatedAt', 'lastCloudCursorAt', 'scopeCursorJobId',
      'scopeCursorProvenance', 'syncAnchorRevisionId', 'keep_link_job_id'].forEach(function(key) { delete fs[key]; });
    // Pending operations describe the identity being left. They remain in that
    // job's checkpoint/offline journal and must never be replayed as ownership
    // evidence for the target.
    fs.pendingOps = [];
    fs.syncAnchorType = jobId ? 'job' : (opportunityId ? 'ghl_opportunity' : 'local_only');
    fs.syncAnchorId = jobId || opportunityId || null;
    fs.ghlContactId = contactId || null;
    fs.identityVersion = 1;
    fs.identityReboundAt = new Date().toISOString();
    fs.launchMode = launchMode || 'guarded_entry';
    fs.requiresLinkBeforeRelease = !(jobId || opportunityId);
    fs.syncState = jobId ? 'linked_job_local_dirty' : (opportunityId ? 'linked_ghl_local_dirty' : 'local_dirty');
    window.app.job.ref = jobId && _lastJobNumber ? _lastJobNumber : '';

    if (!jobId || String(_scopeCursorJobId || '') !== String(jobId)) {
      _baseScopeHash = null;
      _baseScopeUpdatedAt = null;
      _scopeCursorJobId = null;
    }
    // Read-back is the boundary: save must never arm until these values agree.
    if (String(fs.syncAnchorId || '') !== String(jobId || opportunityId || '') ||
        (_isRealFenceRef(window.app.job.ref) && String(window.app.job.ref).toUpperCase() !== String(_lastJobNumber || '').toUpperCase())) {
      throw _entryError('identity_rebind_failed', 'Could not verify the new fence identity. The target was not armed for saving.');
    }
  }

  function _resolveFencingTargetSwitch(source, target) {
    if (_toolType !== 'fencing' || !window.app || !window.app.job || !window.app._hasMeaningfulLocalDraft || !window.app._hasMeaningfulLocalDraft()) {
      return Promise.resolve('open_separately');
    }
    var currentKey = _currentFencingTargetKey();
    var nextKey = _targetKey(target);
    if (currentKey && nextKey && currentKey === nextKey) return Promise.resolve('keep_link');

    return new Promise(function(resolve) {
      var existing = document.getElementById('fenceTargetSwitchModal');
      if (existing) existing.remove();
      var label = (target && target.label) || 'the selected target';
      var overlay = document.createElement('div');
      overlay.id = 'fenceTargetSwitchModal';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(41,60,70,0.74);z-index:10070;display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;';
      overlay.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;box-shadow:0 20px 70px rgba(0,0,0,0.35);overflow:hidden;">' +
        '<div style="background:#293C46;color:#fff;padding:18px 22px;"><div style="font-size:19px;font-weight:800;">This iPad has unsynced fence work</div><div style="font-size:13px;color:rgba(255,255,255,0.72);margin-top:4px;">Choose what to do before opening ' + label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '.</div></div>' +
        '<div style="padding:18px 22px;display:grid;gap:10px;">' +
          '<button id="targetKeepLinkBtn" style="text-align:left;border:1px solid #F15A29;background:#FFF7ED;border-radius:10px;padding:14px;cursor:pointer;"><b style="display:block;color:#F15A29;font-size:15px;">Keep this draft and link it</b><span style="display:block;color:#92400E;font-size:12px;margin-top:4px;">Use the selected target for sync, but keep the local scope as the source of truth.</span></button>' +
          '<button id="targetOpenSeparateBtn" style="text-align:left;border:1px solid #D4DEE4;background:#fff;border-radius:10px;padding:14px;cursor:pointer;"><b style="display:block;color:#293C46;font-size:15px;">Open selected target separately</b><span style="display:block;color:#4C6A7C;font-size:12px;margin-top:4px;">Checkpoint this draft first, then load the selected cloud/GHL scope.</span></button>' +
          '<button id="targetCancelBtn" style="text-align:left;border:1px solid #D1D5DB;background:#fff;border-radius:10px;padding:14px;cursor:pointer;"><b style="display:block;color:#374151;font-size:15px;">Cancel</b><span style="display:block;color:#6B7280;font-size:12px;margin-top:4px;">Do not link or load anything.</span></button>' +
        '</div>' +
      '</div>';
      document.body.appendChild(overlay);
      var done = function(choice) {
        var el = document.getElementById('fenceTargetSwitchModal');
        if (el) el.remove();
        resolve(choice);
      };
      document.getElementById('targetKeepLinkBtn').onclick = function() { done('keep_link'); };
      document.getElementById('targetOpenSeparateBtn').onclick = function() { done('open_separately'); };
      document.getElementById('targetCancelBtn').onclick = function() { done('cancel'); };
    });
  }

  function _loadFencingStateLocalWins(scopeJson, source) {
    if (_toolType === 'fencing' && _hasDirtyFencingDraft()) {
      console.log('[FenceSync] Local draft wins; skipping remote scope_json load for ' + (source || 'cloud load'));
      return false;
    }
    return _loadStateFn(scopeJson);
  }

  function _linkFencingAnchor(jobId, opportunityId, contactId, launchMode) {
    if (_toolType === 'fencing' && window.app && window.app._linkCloudAnchor) {
      // keep_link and every other cross-job transition pass the same scrub/read-
      // back boundary before app.save() inside _linkCloudAnchor can run.
      _scrubCrossJobIdentity(jobId, opportunityId, contactId, launchMode);
      window.app._linkCloudAnchor({ jobId: jobId || null, opportunityId: opportunityId || null, contactId: contactId || null, launchMode: launchMode || 'cloud_load' });
      // Re-attach only a cursor proven to belong to the target. A stale cursor
      // was cleared above and cannot be resurrected from persisted _fieldSync.
      if (_baseScopeHash && String(_scopeCursorJobId || '') === String(jobId || '')) {
        var fs = window.app.job && window.app.job._fieldSync;
        if (fs) {
          fs.baseScopeHash = _baseScopeHash;
          fs.currentScopeHash = _baseScopeHash;
          fs.scopeCursorJobId = _scopeCursorJobId;
          fs.scopeCursorProvenance = 'server_issued';
        }
      }
    }
  }

  function _isDuplicateJobNumberError(e) {
    var msg = String((e && (e.message || e.error || e.code)) || e || '');
    return /idx_jobs_job_number|duplicate key value|23505|job_number.*duplicate|duplicate.*job_number/i.test(msg);
  }

  function _requireAuthorizedFetch(cloudRef) {
    if (!cloudRef || typeof cloudRef.authorizedFetch !== 'function') {
      throw new Error('authenticated_request_unavailable: cloud.authorizedFetch is required');
    }
    return cloudRef.authorizedFetch.bind(cloudRef);
  }

  async function _readErrorBody(res) {
    try {
      var json = await res.clone().json();
      return json && (json.error || json.message || JSON.stringify(json));
    } catch(_e) {
      try { return await res.text(); } catch(_e2) { return ''; }
    }
  }

  async function _expectOk(res, label) {
    if (res && res.ok) return res;
    var status = res ? res.status : 'network';
    var body = res ? await _readErrorBody(res) : '';
    throw new Error(label + ' failed (' + status + ')' + (body ? ': ' + body : ''));
  }

  // Upload a document blob to Supabase storage + register in job_documents
  async function _uploadDocBlob(cloudRef, jobId, jobNumber, blob, fileName, docType) {
    if (!cloudRef || !jobId || !blob) return;
    var authorizedFetch = _requireAuthorizedFetch(cloudRef);
    // Step 1: Get signed upload URL
    var uploadRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ops-api?action=upload_document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, file_name: fileName, content_type: blob.type || 'application/pdf' })
    });
    await _expectOk(uploadRes, 'Quote document upload URL');
    var uploadData = await uploadRes.json();
    // ops-api upload_document returns `uploadUrl`; some endpoints return `signedUrl` — accept either.
    var signedUploadUrl = uploadData.uploadUrl || uploadData.signedUrl;
    if (!signedUploadUrl) throw new Error('No upload URL returned (neither uploadUrl nor signedUrl present)');
    // Step 2: PUT the blob
    await fetch(signedUploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/pdf' },
      body: blob
    }).then(function(res) { return _expectOk(res, 'Quote document storage upload'); });
    // Step 3: Confirm upload (insert into job_documents)
    var confirmRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ops-api?action=confirm_document_upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        file_name: fileName,
        public_url: uploadData.publicUrl || '',
        document_type: docType,
        reference: jobNumber
      })
    });
    await _expectOk(confirmRes, 'Quote document registration');
  }

  // ── Background media upload helpers ──────────────────────────────────────────
  //
  // Called immediately after a photo/video is selected (on-device compression
  // has already run). If a jobId is available the upload starts straight away
  // in the background while the scoper continues filling the form.
  //
  // Tracking: _bgUploads[id] is a plain object:
  //   { promise, done: bool, error: Error|null }
  // The save loop awaits any not-yet-done entries; the sign-off gate blocks
  // until all are settled, showing a retry dialog on any failures.
  //
  // Each helper is idempotent: if cloudUrl is already set it is a no-op.

  function _dataUrlToBlob(dataUrl) {
    var mimeMatch = dataUrl.match(/data:([^;]+);/);
    var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    var b64 = dataUrl.split(',')[1];
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function _doUploadPhoto(photo, jobId, cloudRef) {
    var authorizedFetch = _requireAuthorizedFetch(cloudRef);
    var blob = _dataUrlToBlob(photo.dataUrl);
    var mime = blob.type;
    var ext = mime.includes('png') ? 'png' : 'jpg';

    photo.clientMediaId = photo.clientMediaId || photo.id || photo._checklistId || ('photo-' + Date.now());
    var urlRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobId, fileName: (photo.label || 'photo') + '.' + ext, contentType: mime, clientMediaId: photo.clientMediaId })
    });
    await _expectOk(urlRes, 'Photo upload URL');
    var urlData = await urlRes.json();

    var uploadRes = await fetch(urlData.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: blob
    });
    if (!uploadRes.ok) throw new Error('Photo upload failed: ' + uploadRes.status);

    var regRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobId, storageUrl: urlData.publicUrl, type: 'photo', label: photo.label || 'Photo' })
    });
    await _expectOk(regRes, 'Photo registration');

    photo.cloudUrl = urlData.publicUrl;
    if (photo._checklistId && window.app && window.app.job && window.app.job.checklist && window.app.job.checklist.photos) {
      var cpMatch = window.app.job.checklist.photos.find(function(cp) { return cp.id === photo._checklistId; });
      if (cpMatch) cpMatch.cloudUrl = urlData.publicUrl;
    }
    console.log('[Integration] Photo uploaded:', photo.label, (blob.size / 1024).toFixed(0) + 'KB');
  }

  async function _doUploadVideo(video, jobId, cloudRef) {
    var authorizedFetch = _requireAuthorizedFetch(cloudRef);
    var videoBody = video.file || null;
    var videoMime = 'video/mp4';
    var videoName = video.label || 'walkthrough.mp4';

    if (videoBody) {
      if (videoBody.type) videoMime = videoBody.type;
      if (videoBody.name) videoName = videoBody.name;
    } else if (video.dataUrl) {
      var vMimeMatch = video.dataUrl.match(/data:([^;]+);/);
      videoMime = vMimeMatch ? vMimeMatch[1] : 'video/mp4';
      videoBody = _dataUrlToBlob(video.dataUrl);
    }
    if (!videoBody) throw new Error('No video body available for upload');

    console.log('[Integration] Uploading video...', videoName, ((videoBody.size || 0) / 1048576).toFixed(1) + 'MB');

    video.clientMediaId = video.clientMediaId || [
      'video', videoName, videoBody.size || 0, videoBody.lastModified || 0
    ].join('-');
    var urlRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobId, fileName: videoName, contentType: videoMime, clientMediaId: video.clientMediaId })
    });
    await _expectOk(urlRes, 'Video upload URL');
    var urlData = await urlRes.json();

    var uploadRes = await fetch(urlData.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': videoMime },
      body: videoBody
    });
    if (!uploadRes.ok) throw new Error('Video upload failed: ' + uploadRes.status);

    var regRes = await authorizedFetch(cloudRef.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobId, storageUrl: urlData.publicUrl, type: 'video', label: video.label || 'Site Walkthrough' })
    });
    await _expectOk(regRes, 'Video registration');

    video.cloudUrl = urlData.publicUrl;
    console.log('[Integration] Video uploaded:', urlData.publicUrl);
  }

  function _startBgPhotoUpload(photo) {
    if (photo.cloudUrl) return;
    if (_bgUploads[photo.id] && !_bgUploads[photo.id].error) return;
    var jobId = _jobId;
    var cloudRef = cloud;
    if (!jobId || !cloudRef || !cloudRef.supabaseUrl) return;

    photo._uploading = true;
    photo._uploadError = null;
    if (window._swUploadStatusChanged) window._swUploadStatusChanged(photo.id, 'uploading');

    var entry = { done: false, error: null };
    entry.promise = _doUploadPhoto(photo, jobId, cloudRef).then(function() {
      photo._uploading = false;
      entry.done = true;
      if (window._swUploadStatusChanged) window._swUploadStatusChanged(photo.id, 'done');
    }).catch(function(err) {
      photo._uploading = false;
      photo._uploadError = err;
      entry.done = true;
      entry.error = err;
      console.warn('[Integration] Background photo upload failed:', photo.label, err);
      if (window._swUploadStatusChanged) window._swUploadStatusChanged(photo.id, 'error', err);
    });
    _bgUploads[photo.id] = entry;
  }

  function _startBgVideoUpload(video) {
    if (video.cloudUrl) return;
    if (_bgUploads['__video__'] && !_bgUploads['__video__'].error) return;
    var jobId = _jobId;
    // Read at upload START, not in the rejection callback: a reset that lands
    // while this upload is in flight must be visible to the retry guard below.
    var epoch = _mediaEpoch;
    var cloudRef = cloud;
    if (!jobId || !cloudRef || !cloudRef.supabaseUrl) return;

    video._uploading = true;
    video._uploadError = null;
    if (window._swUploadStatusChanged) window._swUploadStatusChanged('__video__', 'uploading');

    var entry = { done: false, error: null };
    entry.promise = _doUploadVideo(video, jobId, cloudRef).then(function() {
      video._uploading = false;
      video._uploadError = null;
      entry.done = true;
      // A reset while this was in flight handed _videoRetryCount and the status
      // channel to a DIFFERENT job's video; reporting this one's outcome there
      // would show the new job's pending video as already uploaded.
      if (_mediaEpoch !== epoch) return;
      _videoRetryCount = 0;
      if (window._swUploadStatusChanged) window._swUploadStatusChanged('__video__', 'done');
    }).catch(function(err) {
      video._uploading = false;
      entry.done = true;
      entry.error = err;
      console.warn('[Integration] Background video upload failed:', err);
      // Same ownership rule as the success path: this failure must not spend the
      // new job's retry budget, nor overwrite _videoRetryTimer and orphan the
      // live retry handle that _resetToolMediaState needs in order to cancel it.
      if (_mediaEpoch !== epoch) return;
      if (_videoRetryCount < _VIDEO_MAX_RETRIES) {
        // Auto-retry with backoff before surfacing a hard failure. Keep the visible
        // status as "uploading" so the scoper still sees the video is being handled.
        _videoRetryCount++;
        var attempt = _videoRetryCount;
        console.log('[Integration] Retrying video upload (attempt ' + attempt + '/' + _VIDEO_MAX_RETRIES + ')');
        if (window._swUploadStatusChanged) window._swUploadStatusChanged('__video__', 'uploading');
        _videoRetryTimer = setTimeout(function() {
          _videoRetryTimer = null;
          if (video.cloudUrl) return;
          // The job this video belongs to may have been swapped out from under
          // the timer (repeat-client new job); never upload it to a new client.
          // A local- id walking up to its real cloud id is the SAME draft, so
          // only an intervening media reset invalidates the retry.
          if (_mediaEpoch !== epoch) return;
          if (_isRealJobId(jobId) && _jobId !== jobId) return;
          var cur = _bgUploads['__video__'];
          if (cur && !cur.error) return; // a healthy upload is already in flight — don't double-start
          delete _bgUploads['__video__'];
          _startBgVideoUpload(video);
        }, 4000 * attempt);
      } else {
        video._uploadError = err;
        if (window._swUploadStatusChanged) window._swUploadStatusChanged('__video__', 'error', err);
      }
    });
    _bgUploads['__video__'] = entry;
  }

  // Await only the PHOTO background uploads. The site video is intentionally NON-BLOCKING
  // (it keeps uploading after "Job Created"), so it is never awaited here.
  async function _awaitPhotoBgUploads() {
    var promises = Object.keys(_bgUploads)
      .filter(function(k) { return k !== '__video__'; })
      .map(function(k) { return _bgUploads[k].promise; });
    await Promise.allSettled(promises);
  }

  async function _retryFailedBgUploads() {
    var sitePhotos = window.sitePhotos || [];
    sitePhotos.forEach(function(p) {
      if (p._uploadError && !p.cloudUrl) {
        delete _bgUploads[p.id];
        _startBgPhotoUpload(p);
      }
    });
    // Video is non-blocking and self-retries; the gate concerns photos only.
    await _awaitPhotoBgUploads();
    var stillFailed = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl; });
    return stillFailed.length === 0;
  }

  async function _mediaUploadGate() {
    // Video is NON-BLOCKING: make sure its background upload is running (no-op if already
    // in flight) so it continues after "Job Created", but never wait on it in this gate.
    var siteVideo = window.siteVideo;
    if (siteVideo && !siteVideo.cloudUrl && (siteVideo.file || siteVideo.dataUrl)) {
      _startBgVideoUpload(siteVideo);
    }

    var sitePhotos = window.sitePhotos || [];
    var photosDone = Object.keys(_bgUploads)
      .filter(function(k) { return k !== '__video__'; })
      .every(function(k) { var e = _bgUploads[k]; return e.done && !e.error; });
    var pendingPhotos = sitePhotos.filter(function(p) { return !p.cloudUrl; });
    if (photosDone && !pendingPhotos.length) return true;

    if (window._swShowMediaGate) window._swShowMediaGate('waiting');
    await _awaitPhotoBgUploads();

    var failedPhotos = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl; });
    if (!failedPhotos.length) {
      if (window._swShowMediaGate) window._swShowMediaGate('done');
      return true;
    }

    return new Promise(function(resolve) {
      if (window._swShowMediaGate) {
        window._swShowMediaGate('failed', failedPhotos.length, false, function onRetry() {
          _retryFailedBgUploads().then(function(ok) {
            if (ok) {
              if (window._swShowMediaGate) window._swShowMediaGate('done');
              resolve(true);
            } else {
              var fp2 = (window.sitePhotos || []).filter(function(p) { return !p.cloudUrl && p.dataUrl; });
              if (window._swShowMediaGate) window._swShowMediaGate('failed', fp2.length, false, onRetry, function() { resolve(true); });
            }
          });
        }, function onSkip() {
          resolve(true);
        });
      } else {
        var msg = 'Some photos have not finished uploading:\n';
        msg += '- ' + failedPhotos.length + ' photo(s)\n';
        msg += '\nProceed anyway? (Uploads will retry on next save)';
        resolve(confirm(msg));
      }
    });
  }

  // ── End background media upload helpers ──────────────────────────────────────

  // Pre-fill all contact fields in the tool from a GHL contact object
  function _prefillContact(contact) {
    if (!contact) return;
    console.log('[Integration] Pre-filling contact:', contact);

    // Resolve name — use firstName/lastName if GHL provides them, else use full name
    var displayName = contact.name || '';
    if (contact.firstName) {
      displayName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    }

    // Preserve structured address — use street address only for address field
    var streetAddress = contact.address || '';
    // Only use suburb separately — don't concatenate everything
    var suburb = contact.suburb || '';

    var firstName = contact.firstName || '';
    var lastName = contact.lastName || '';
    if (!firstName && displayName) {
      var parts = displayName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // Fill-empty only: GHL/cloud data must not overwrite local iPad edits.
    var mapping = [
      { val: displayName, selectors: '#customerName, #clientName, [name="clientName"]' },
      { val: firstName, selectors: '#clientFirstNameInput, [name="clientFirstName"]' },
      { val: lastName, selectors: '#clientLastNameInput, [name="clientLastName"]' },
      { val: contact.email, selectors: '#clientEmail, #customerEmail, [name="clientEmail"], [name="email"]' },
      { val: contact.phone, selectors: '#customerPhone, #clientPhone, [name="clientPhone"], [name="phone"]' },
      { val: streetAddress, selectors: '#customerAddress, #clientAddress, #siteAddress, #addressInput, [name="siteAddress"], [name="address"]' },
      { val: suburb, selectors: '#customerSuburb, #clientSuburb' }
    ];

    mapping.forEach(function(m) {
      if (!m.val) return;
      document.querySelectorAll(m.selectors).forEach(function(el) {
        var current = (el.value || '').trim();
        if (current) return;
        el.value = m.val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    // Also set window globals if the tool uses them, preserving non-empty local values.
    if (typeof window.customer === 'object' && window.customer) {
      if (displayName && !window.customer.name) window.customer.name = displayName;
      if (contact.phone && !window.customer.phone) window.customer.phone = contact.phone;
      if (contact.email && !window.customer.email) window.customer.email = contact.email;
      if (streetAddress && !window.customer.address) window.customer.address = streetAddress;
    }
  }

  // Identity-only read of a job this session just minted but lost the id for
  // (timed-out create that committed). Deliberately projects id/job_number/status
  // and DROPS scope_json: an adopt must never be able to pull a scope into the
  // form, so the capability simply is not returned. Best-effort — a failed fetch
  // just leaves the header numberless; the job itself is already ours. Takes the
  // caller's abort opts so it stays inside the create sequence's timeout — the
  // lead-search modal is locked while this runs and must never wait on it longer
  // than the bound.
  async function _fetchAdoptedJobMeta(jobId, opts) {
    if (!jobId || !cloud || !cloud.ghl || !cloud.ghl.loadJob) return null;
    try {
      var full = await cloud.ghl.loadJob(jobId, opts);
      if (!full || !full.id) return null;
      return { id: full.id, job_number: full.job_number || null, status: full.status || null };
    } catch(e) {
      console.warn('[Integration] Adopted job meta fetch failed; continuing without job number:', e);
      return null;
    }
  }

  // Repeat-client / contact-only path: start a BRAND-NEW job for an existing
  // contact without ever loading their old scope/job (C3, AM-A, AM-H).
  // Returns a promise so the lead-search modal can lock while it runs (AM-C).
  async function _startNewJobForContact(row, permit) {
    _requireEntryPermit(permit, ['ghl_context']);
    if (!row) throw new Error('No client selected');
    var displayName = row.contactName || row.name || row.contactPhone || 'this client';

    // This path is premised on an already-known contact. Without a contactId the
    // backend has nothing to dedup on and would mint a blank contact.
    var contactId = row.contactId || null;
    if (!contactId) throw new Error('This client has no GHL contact on file — search again or start a new local draft');

    // AM-H: a meaningful local draft is checkpointed and cleared below, so get
    // the explicit confirm BEFORE any network create — cancelling must not leave
    // a stray opportunity behind.
    var hadMeaningfulDraft = !!(window.app && window.app._hasMeaningfulLocalDraft && window.app._hasMeaningfulLocalDraft());
    if (hadMeaningfulDraft) {
      var ok = window.confirm('Start a new job for ' + displayName + '? Your current work will be checkpointed on this iPad first.');
      if (!ok) { var cancelErr = new Error('cancelled'); cancelErr.code = 'cancelled'; throw cancelErr; }
    }

    // Every network create runs FIRST. Until they all succeed, _jobId /
    // _ghlOpportunityId / _ghlContactId and the form stay exactly as they were,
    // so a failure can neither strand the scoper on a blank scope nor leave the
    // next save pointing at the previous client's opportunity.

    // The lead-search modal makes itself undismissable while this runs (AM-C),
    // so the whole create sequence is bounded — a stalled connection must fail
    // loudly and hand the scoper back a retry rather than hang the modal until
    // the browser's own multi-minute fetch timeout fires.
    var abortCtl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function() {
      timedOut = true;
      try { abortCtl.abort(); } catch(e) {}
    }, _NEW_JOB_TIMEOUT_MS);
    var netOpts = { signal: abortCtl.signal };
    var _rethrow = function(e) {
      if (timedOut) {
        // An abort can land AFTER the backend committed the opportunity, in which
        // case we never got its id to cache — so the caller must re-check what
        // actually exists rather than blindly minting another one on retry. The
        // message stays surface-neutral: each caller phrases its own recovery.
        var toErr = new Error('Timed out before we could confirm whether the job was created');
        toErr.code = 'timeout';
        throw toErr;
      }
      throw e;
    };

    try {
      // Full contact fetch first (AM-H) so client + site fields aren't empty.
      var contact = null;
      try {
        contact = await cloud.ghl.getContact(contactId, netOpts);
      } catch(e) {
        if (timedOut) _rethrow(e);
        console.warn('[Integration] Contact fetch failed, using row data:', e);
        contact = { name: row.contactName, email: row.contactEmail, phone: row.contactPhone };
      }

      // Create a NEW opportunity for this contact in the fencing pipeline (AM-A:
      // toolType is the 2nd arg). Backend skips dedup because contactId is set.
      // Reuse an opportunity minted by an earlier failed attempt for this same
      // contact so retries can't accumulate orphans in the pipeline. The cache is
      // keyed by contactId in module scope, not on the row, so it survives the
      // re-search / re-render that rebuilds the lead objects.
      var pending = _pendingNewOpps[contactId] || null;
      var newOppId = pending && pending.opportunityId;
      var newContactId = (pending && pending.contactId) || contactId;
      // The earlier attempt timed out; if the re-run search now shows THAT very
      // opportunity already carrying a Supabase job, the attempt COMMITTED. Take
      // the job it made rather than hanging a second one off the same
      // opportunity, which would leave findJobByOpportunity ambiguous forever.
      // Read straight off the fresh row — no lookup, so the "never load an
      // existing job" invariant of this path holds. hasScope means the row is
      // some OLDER job, not the empty one we just minted: never adopt that.
      var adopted = (newOppId && row.id === newOppId && row.supabaseJobId && !row.hasScope)
        ? { id: row.supabaseJobId }
        : null;
      if (!newOppId) {
        var created = await cloud.ghl.createContactAndOpportunity({
          contactId: contactId,
          name: (contact && contact.name) || row.contactName || '',
          phone: (contact && contact.phone) || row.contactPhone || '',
          email: (contact && contact.email) || row.contactEmail || '',
          address: (contact && contact.address) || '',
          suburb: (contact && contact.suburb) || ''
        }, _toolType, netOpts).catch(_rethrow);
        newOppId = created && created.opportunityId;
        if (!newOppId) throw new Error('Could not create a new opportunity for this client');
        newContactId = (created && created.contactId) || contactId;
        _pendingNewOpps[contactId] = { opportunityId: newOppId, contactId: newContactId };
      }

      // Create the job with contact details so site fields populate (AM-H).
      // Include contactId so the new job row gets ghl_contact_id set (not NULL);
      // createJobForOpportunity forwards body.contactId when present.
      var contactForJob = {
        contactId: newContactId || null,
        name: (contact && contact.name) || row.contactName || '',
        phone: (contact && contact.phone) || row.contactPhone || '',
        email: (contact && contact.email) || row.contactEmail || '',
        address: (contact && contact.address) || '',
        suburb: (contact && contact.suburb) || ''
      };
      var job = (adopted && adopted.id)
        ? adopted
        : await cloud.ghl.createJobForOpportunity(newOppId, _toolType, contactForJob, netOpts).catch(_rethrow);
      if (!job || !job.id) throw new Error('Could not create a new job for this client');
      // The adopt row carries only an id, so job_number/status would read back
      // empty and the header would sit numberless for the rest of the session.
      // _fetchAdoptedJobMeta returns identity fields ONLY — it cannot carry a
      // scope back into the form, so the never-resurrect-an-old-job invariant
      // of this path holds.
      if (adopted && adopted.id) {
        var meta = await _fetchAdoptedJobMeta(job.id, netOpts);
        if (meta) job = meta;
      }
    } finally {
      clearTimeout(timer);
    }

    // The opportunity is consumed — a later new job for this same contact must
    // mint its own rather than reuse this one.
    delete _pendingNewOpps[contactId];

    // Creates all landed — now it is safe to checkpoint, reset and re-point state.
    if (cloud) cloud.stopAutoSave();
    _jobId = null;
    _lastJobNumber = null;
    _jobLoaded = false;
    _ghlOpportunityId = null;
    _ghlContactId = null;
    // The scope-save cursor belongs to the job we are leaving. Carried into a
    // brand-new job (whose server-side scope hash is NULL) it would be attached
    // to every saveScope by _attachScopeSaveCursor, and since it only refreshes
    // on a SUCCESSFUL save, a strict backend would reject the new job forever.
    _baseScopeHash = null;
    _baseScopeUpdatedAt = null;
    _scopeCursorJobId = null;

    // Same checkpoint+reset sequence as opening a target separately — never
    // loadJob/findJobByOpportunity here; the old job must stay untouched.
    if (_toolType === 'fencing' && window.app) {
      _openFencingTargetSeparately('repeat_client_new_job');
    } else {
      _resetPatioForm();
    }

    _ghlOpportunityId = newOppId;
    _ghlContactId = newContactId || null;
    _jobId = job.id;
    _jobStatus = job.status || 'draft';
    _lastJobNumber = job.job_number || null;

    // This is a brand-new editable job and the URL below drops any frozen
    // ?scope_revision_id / ?mode=readonly, so the load-time readonly flag must
    // not leak in and silently disable autosave. The frozen scope has already
    // been reset out of the form, so the M4 viewer lock is unaffected.
    _isReadonly = false;
    document.documentElement.classList.remove('readonly-mode');

    // The frozen viewer's banner outlives its URL: its "Make a revision" button
    // and revision switcher close over the OLD scope revision and job, so left
    // mounted they would clone the previous client's sealed scope from what is
    // now a different client's editable job.
    _clearFrozenViewerChrome();

    // Link anchor (ensures field sync), prefill client fields, wire the URL.
    _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'repeat_client_new_job');
    if (contact) _prefillContact(contact);
    if (_lastJobNumber) _applyJobNumber(_lastJobNumber);
    if (_jobId) {
      var newUrl = window.location.pathname + '?jobId=' + _jobId;
      window.history.replaceState({}, '', newUrl);
    }
    updateUI();
    if (_shouldAutoSave()) {
      cloud.startAutoSave(_jobId, _getStateFn, 30000);
    }
    return { jobId: _jobId, opportunityId: _ghlOpportunityId };
  }

  // Reset patio tool form to clean state before loading a new opportunity
  function _resetPatioForm() {
    // Clear all form inputs in the left panel
    document.querySelectorAll('#leftPanel input, #leftPanel select, #leftPanel textarea').forEach(function(el) {
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = el.defaultChecked;
      } else if (el.tagName === 'SELECT') {
        el.selectedIndex = 0;
      } else {
        el.value = el.defaultValue || '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Reset global objects
    if (typeof window.customer === 'object') {
      window.customer = { name: '', address: '', phone: '' };
    }
    if (typeof window.siteDetails === 'object') {
      window.siteDetails = { existingSite: 'clear', demoScope: 'na', electrical: 'none', siteAccess: 'easy', groundSurface: 'grass', fasciaMaterial: 'timber', wallType: 'doublebrick', existingRoof: 'tiles' };
    }
    _resetToolMediaState();

    // Reset arrays/objects
    if (typeof window.flashingProfiles !== 'undefined') window.flashingProfiles = [];
    if (typeof window.dpSelection !== 'undefined') window.dpSelection = [];
    if (typeof window.matQtyOverrides !== 'undefined') window.matQtyOverrides = {};
    if (typeof window.extrasRows !== 'undefined') window.extrasRows = [];
    if (typeof window.additionalMaterials !== 'undefined') window.additionalMaterials = [];
    if (typeof window.customPostPositions !== 'undefined') window.customPostPositions = {};

    // Clear QA verification state
    var jobRef = document.getElementById('jobRef');
    if (jobRef && jobRef.value) {
      localStorage.removeItem('patio-verification-' + jobRef.value);
    }
    if (typeof window.patioQA !== 'undefined' && window.patioQA._verificationState) {
      window.patioQA._verificationState = {};
    }

    // Reset toggle buttons to defaults
    document.querySelectorAll('.toggle-btn.active').forEach(function(btn) {
      btn.classList.remove('active');
    });
    // Re-activate default toggle values
    ['siteAccess', 'groundSurface', 'fasciaMaterial', 'wallType', 'existingRoof'].forEach(function(fieldId) {
      var group = document.getElementById(fieldId + 'Group');
      if (group) {
        var defaultBtn = group.querySelector('.toggle-btn[data-value="' + (window.siteDetails ? window.siteDetails[fieldId] : '') + '"]');
        if (defaultBtn) defaultBtn.classList.add('active');
      }
    });

    // Recalculate
    if (typeof window.recalcAll === 'function') window.recalcAll();
  }

  // Load photos/videos from Supabase Storage into the tool's sitePhotos/siteVideo arrays
  async function _loadCloudMedia(jobId) {
    if (!cloud) return;
    var media = await cloud.ghl.listMedia(jobId);
    if (!media || media.length === 0) {
      console.log('[Integration] No cloud media for this job');
      return;
    }

    console.log('[Integration] Loading', media.length, 'media items from cloud');

    var photos = media.filter(function(m) { return m.type === 'photo'; });
    var videos = media.filter(function(m) { return m.type === 'video'; });

    // Inject photos into the tool's sitePhotos array. Idempotent: reloads/reconnects
    // must not append duplicate cloud media when the same job is opened repeatedly.
    if (photos.length > 0 && typeof window.sitePhotos !== 'undefined') {
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        var alreadyLoaded = window.sitePhotos.some(function(existing) {
          return (p.id && existing.cloudId === p.id) ||
            (p.storage_url && (existing.cloudUrl === p.storage_url || existing.dataUrl === p.storage_url));
        });
        if (alreadyLoaded) continue;
        // Use numeric IDs (tool's deletePhoto/updatePhotoLabel expect numbers in onclick)
        var numericId = Date.now() + i;
        window.sitePhotos.push({
          id: numericId,
          cloudId: p.id,             // Keep the database UUID separately
          dataUrl: p.storage_url,    // Use cloud URL instead of base64
          cloudUrl: p.storage_url,   // Mark as already uploaded
          label: p.label || 'Photo',
          caption: p.notes || '',
          originalSize: 0,
          compressedSize: 0
        });
      }
      // Re-render the photo grid if the function exists
      if (typeof window.renderPhotoGrid === 'function') window.renderPhotoGrid();
      if (typeof window.updatePhotoCount === 'function') window.updatePhotoCount();

      // Also populate checklist photos (fencing tool uses job.checklist.photos for UI badges)
      if (window.app && window.app.job) {
        if (!window.app.job.checklist) window.app.job.checklist = {};
        if (!window.app.job.checklist.photos) window.app.job.checklist.photos = [];
        for (var ci = 0; ci < photos.length; ci++) {
          var cp = photos[ci];
          var existsAlready = window.app.job.checklist.photos.some(function(existing) {
            return existing.cloudUrl && existing.cloudUrl === cp.storage_url;
          });
          if (!existsAlready) {
            window.app.job.checklist.photos.push({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              name: cp.label || 'Photo',
              label: cp.label || 'Photo',
              dataUrl: cp.storage_url,
              cloudUrl: cp.storage_url,
              timestamp: new Date().toISOString()
            });
          }
        }
        window.app.job.checklist.photosTaken = window.app.job.checklist.photos.length;
        if (typeof window.app._persistMediaManifest === 'function') window.app._persistMediaManifest();
        if (typeof window.app.renderChecklist === 'function') window.app.renderChecklist();
      }

      console.log('[Integration] Loaded', photos.length, 'photos from cloud');
    }

    // Inject video if present
    if (videos.length > 0 && videos[0].storage_url) {
      var v = videos[0];
      window.siteVideo = {
        objectUrl: v.storage_url,
        cloudUrl: v.storage_url,
        label: v.label || 'Site Walkthrough',
        originalSize: 0,
        file: null  // No file object for cloud videos
      };
      if (window.app && window.app.job && window.app.job.checklist) {
        window.app.job.checklist.videoCloudUrl = v.storage_url;
        window.app.job.checklist.videoNeedsReattach = false;
        if (typeof window.app._persistMediaManifest === 'function') window.app._persistMediaManifest();
      }
      if (typeof window.renderVideoPreview === 'function') window.renderVideoPreview();
      if (typeof window.updateVideoBadge === 'function') window.updateVideoBadge();
      console.log('[Integration] Loaded video from cloud');
    }
  }

  // ── Detect tool type ──
  function detectToolType() {
    var attr = document.body.dataset.toolType || document.documentElement.dataset.toolType;
    if (attr) return attr;
    var title = (document.title || '').toLowerCase();
    if (title.includes('fence') || title.includes('fencing')) return 'fencing';
    if (title.includes('deck')) return 'decking';
    if (title.includes('patio')) return 'patio';
    return 'patio';
  }

  // ── Check URL for jobId parameter ──
  function getJobIdFromURL() {
    var params = new URLSearchParams(window.location.search);
    return params.get('jobId') || params.get('job') || null;
  }

  // ── Inject cloud bar below the header ──
  function injectToolbar() {
    if (detectToolType() === 'fencing') {
      console.log('[Integration] Fencing uses the built-in field launcher; skipping duplicate cloud Save/Load/Dashboard bar');
      return;
    }
    var header = document.querySelector('.header') ||
                 document.querySelector('header') ||
                 document.querySelector('[class*="header"]');

    console.log('[Integration] Header found:', !!header);
    if (!header) return;

    // Inject a <style> block for cloud bar + hover states
    if (!document.getElementById('sw-cloud-styles')) {
      var style = document.createElement('style');
      style.id = 'sw-cloud-styles';
      style.textContent =
        '#sw-cloud-bar{display:flex;gap:6px;align-items:center;justify-content:flex-end;' +
          'padding:4px 24px;background:#293C46;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;' +
          'border-bottom:2px solid #F15A29;}' +
        '#sw-cloud-bar .sw-status{font-size:11px;color:rgba(255,255,255,0.6);margin-right:auto;letter-spacing:0.3px;}' +
        '#sw-cloud-bar .sw-btn{padding:3px 12px;border:1px solid rgba(255,255,255,0.25);color:#fff;' +
          'background:transparent;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer;' +
          'letter-spacing:0.3px;transition:all 0.15s ease;text-transform:uppercase;}' +
        '#sw-cloud-bar .sw-btn:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.4);}' +
        '#sw-cloud-bar .sw-btn-primary{background:#F15A29;border-color:#F15A29;}' +
        '#sw-cloud-bar .sw-btn-primary:hover{background:#d94d20;border-color:#d94d20;}' +
        '#sw-cloud-bar .sw-btn-save{background:#34C759;border-color:#34C759;}' +
        '#sw-cloud-bar .sw-btn-save:hover{background:#2ab348;}';
      document.head.appendChild(style);
    }

    // Create a dedicated cloud bar that sits below the header
    var cloudBar = document.createElement('div');
    cloudBar.id = 'sw-cloud-bar';

    cloudBar.innerHTML =
      '<span class="sw-status" id="sw-cloud-status"></span>' +
      '<button id="sw-btn-login" class="sw-btn sw-btn-primary" onclick="window._swIntegration.login()" style="display:none;">Sign In</button>' +
      '<button id="sw-btn-save" class="sw-btn sw-btn-save" onclick="window._swIntegration.save()" style="display:none;">Save</button>' +
      '<button id="sw-btn-load" class="sw-btn" onclick="window._swIntegration.loadPicker()" style="display:none;">Load Job</button>' +
      '<button id="sw-btn-dashboard" class="sw-btn" onclick="window._swIntegration.openDashboard()" style="display:none;">Dashboard</button>';

    // Insert right after the header
    if (header.nextSibling) {
      header.parentNode.insertBefore(cloudBar, header.nextSibling);
    } else {
      header.parentNode.appendChild(cloudBar);
    }

    console.log('[Integration] Cloud bar injected');

    // Hide cloud bar when bottom toolbar is present (patio tool)
    if (document.getElementById('bottomToolbar')) {
      cloudBar.style.display = 'none';
    }
  }

  // ── Notify tools that subscribed via integration.onAuthChange() ──
  function _notifyAuthChange() {
    var loggedIn = !!(cloud && cloud.auth && cloud.auth.isLoggedIn());
    var user = (cloud && cloud.auth && cloud.auth.getUser) ? cloud.auth.getUser() : null;
    for (var i = 0; i < _authChangeSubscribers.length; i++) {
      try { _authChangeSubscribers[i](loggedIn, user); }
      catch (e) { console.warn('[Integration] auth-change subscriber error:', e); }
    }
  }

  // ── Update UI based on auth state ──
  function updateUI() {
    // Always keep tool-side sign-in buttons in sync, even if the built-in
    // cloud-bar buttons aren't present (tool may render its own).
    _notifyAuthChange();

    var loginBtn = document.getElementById('sw-btn-login');
    var saveBtn = document.getElementById('sw-btn-save');
    var loadBtn = document.getElementById('sw-btn-load');
    var dashBtn = document.getElementById('sw-btn-dashboard');
    var status = document.getElementById('sw-cloud-status');

    if (!loginBtn) {
      console.warn('[Integration] updateUI: cloud-bar buttons not found in DOM (tool may render its own)');
      return;
    }

    if (cloud && cloud.auth.isLoggedIn()) {
      var user = cloud.auth.getUser();
      var userName = (user && user.name) || (user && user.email) || '';
      loginBtn.style.display = 'none';
      saveBtn.style.display = '';
      loadBtn.style.display = '';
      dashBtn.style.display = '';
      if (_lastJobNumber) {
        status.innerHTML = '<strong style="color:#fff;font-size:13px;letter-spacing:0.5px;">' + _lastJobNumber + '</strong> <span style="opacity:0.5;margin:0 4px;">|</span> ' + userName;
      } else if (_jobId && _jobId.indexOf('local-') === 0) {
        status.textContent = userName + ' | Local draft — save to push to cloud';
      } else if (_jobId) {
        status.textContent = userName + ' | Draft (no job number yet)';
      } else {
        status.textContent = userName;
      }
      console.log('[Integration] UI updated: logged in as', userName, 'job:', _lastJobNumber || _jobId || 'none');
    } else if (cloud) {
      loginBtn.style.display = '';
      saveBtn.style.display = 'none';
      loadBtn.style.display = 'none';
      dashBtn.style.display = 'none';
      status.textContent = 'Not signed in';
      console.log('[Integration] UI updated: not signed in, showing Sign In button');
    } else {
      loginBtn.style.display = 'none';
      saveBtn.style.display = 'none';
      loadBtn.style.display = 'none';
      dashBtn.style.display = 'none';
      status.textContent = '';
      console.log('[Integration] UI updated: no cloud module');
    }
  }

  // ════════════════════════════════════════════════════════════
  // JOB NUMBER — set the Job Ref field + header badge to the
  // Supabase job number so it's the single source of truth
  // across the tool, PDFs, and all downstream systems.
  // ════════════════════════════════════════════════════════════

  function _applyJobNumber(jobNumber) {
    if (!jobNumber) return;
    // Set the Job Ref input field (used by PDFs, exports, QA)
    var refEl = document.getElementById('jobRef');
    if (refEl) {
      // Migrate verification localStorage from old key to new key
      // jobRef may be an <input> (patio) or a <span> (fencing) — read accordingly
      var oldRef = (refEl.tagName === 'INPUT' || refEl.tagName === 'TEXTAREA' || refEl.tagName === 'SELECT')
        ? (refEl.value || '').trim()
        : (refEl.textContent || '').trim();
      if (oldRef && oldRef !== jobNumber) {
        var verKey = 'patio-verification-' + oldRef;
        var saved = localStorage.getItem(verKey);
        if (saved) {
          localStorage.setItem('patio-verification-' + jobNumber, saved);
          localStorage.removeItem(verKey);
          console.log('[Integration] Verification state migrated:', oldRef, '→', jobNumber);
        }
      }
      if (refEl.tagName === 'INPUT' || refEl.tagName === 'TEXTAREA' || refEl.tagName === 'SELECT') {
        refEl.value = jobNumber;
      } else {
        refEl.textContent = jobNumber;
      }
    }
    // Update header badge if the tool has one
    if (typeof window.updateHeaderBadge === 'function') {
      window.updateHeaderBadge();
    } else {
      // Fencing tool or tools without updateHeaderBadge
      var badge = document.getElementById('headerBadge');
      var name = (document.getElementById('customerName') || document.getElementById('clientName') || {}).value || '';
      if (badge) badge.innerHTML = '<strong>' + jobNumber + '</strong>' + (name ? ' &nbsp;' + name : '');
    }
    console.log('[Integration] Job number applied to UI:', jobNumber);
  }

  // ════════════════════════════════════════════════════════════
  // STATE GETTERS / SETTERS  (tool-specific)
  // ════════════════════════════════════════════════════════════

  function getFencingState() {
    if (window.app && window.app.job) {
      // Always build fresh pricing_json so auto-save sends current pricing to jobs table
      if (typeof window.app.buildPricingJson === 'function') {
        try { window.app.job._pricing_json = window.app.buildPricingJson(); } catch(e) { console.warn('[Integration] fencing buildPricingJson failed:', e); }
      }
      return {
        tool: 'fencing',
        version: '1.0',
        job: window.app.job,
        scopeMedia: window.scopeMedia ? {
          photos: (window.scopeMedia.photos || []).map(function(p) {
            return { label: p.label, dataUrl: p.dataUrl };
          }),
          video: window.scopeMedia.video || null
        } : null,
        verification: (window.fenceQA && window.fenceQA._verificationState) || null,
        savedAt: new Date().toISOString()
      };
    }
    return null;
  }

  function loadFencingState(scopeJson) {
    if (!scopeJson || !scopeJson.job || !window.app) return false;
    try {
      window.app.job = scopeJson.job;
      if (scopeJson.verification && window.fenceQA) { try { window.fenceQA._verificationState = scopeJson.verification; if (typeof window.fenceQA._saveState === 'function') window.fenceQA._saveState(); } catch(e) {} }
      if (window.app.currentRunId && window.app.job.runs.length > 0) {
        window.app.currentRunId = window.app.job.runs[0].id;
      }
      if (typeof window.app.renderAll === 'function') window.app.renderAll();
      else if (typeof window.app.render === 'function') window.app.render();
      return true;
    } catch(e) {
      console.error('[Integration] Failed to load fencing state:', e);
      return false;
    }
  }

  function getPatioState() {
    if (typeof window.gatherJobData === 'function') {
      try {
        var base = window.gatherJobData();
        // Build enhanced pricing_json if the tool exposes buildPricingJson()
        var pricingJson = null;
        if (typeof window.buildPricingJson === 'function') {
          try { pricingJson = window.buildPricingJson(); } catch(e) { console.warn('[Integration] buildPricingJson failed:', e); }
        }
        // Include verification state if available (QA sign-off records)
        var verification = null;
        if (window.patioQA && window.patioQA._verificationState) {
          verification = window.patioQA._verificationState;
        } else {
          // Fallback: read from localStorage
          var jobRef = (document.getElementById('jobRef') || {}).value || '';
          if (jobRef) {
            try { verification = JSON.parse(localStorage.getItem('patio-verification-' + jobRef)); } catch(e) {}
          }
        }
        // Multi-patio mode: save all patios with current option updated
        if (window._multiPatioMode && window._allPatios && window._allPatios.length > 0) {
          if (typeof window._saveActiveToMemory === 'function') window._saveActiveToMemory();
          return {
            tool: 'patio',
            version: '2.0',
            client: base.client,
            patios: window._allPatios,
            job_costs: window._jobCosts || {},
            customer: window.customer || {},
            siteDetails: window.siteDetails || {},
            verification: verification,
            savedAt: new Date().toISOString()
          };
        }

        // Single patio (standard mode)
        return {
          tool: 'patio',
          version: '1.0',
          client: base.client,
          config: base.config,
          pricing: base.pricing,
          complexity: base.complexity,
          notes: base.notes,
          customer: window.customer || {},
          siteDetails: window.siteDetails || {},
          _pricing_json: pricingJson,
          verification: verification,
          savedAt: new Date().toISOString()
        };
      } catch(e) {
        console.warn('[Integration] gatherJobData failed:', e);
      }
    }
    if (typeof window.saveJobData === 'function') {
      return { tool: 'patio', version: '1.0', savedAt: new Date().toISOString() };
    }
    return null;
  }

  function loadPatioState(scopeJson) {
    if (!scopeJson) return false;
    try {
      // Initialize multi-patio state if v2.0 format
      if (typeof window._initMultiPatioFromScope === 'function') {
        window._initMultiPatioFromScope(scopeJson);
      }

      // For v2.0 multi-patio: load the first option of the first patio
      var stateToLoad = scopeJson;
      if (scopeJson.patios && scopeJson.patios.length > 0) {
        var firstOpt = scopeJson.patios[0].options[0];
        stateToLoad = {
          client: scopeJson.client,
          config: firstOpt.config || {},
          existingSite: firstOpt.existingSite || {},
          complexity: firstOpt.complexity || {},
          pricing: firstOpt.pricing || {},
          flashings: firstOpt.flashings || [],
          scope: firstOpt.scope || {},
          notes: firstOpt.notes || {},
          customer: scopeJson.customer || {},
          siteDetails: scopeJson.siteDetails || {},
          _pricing_json: firstOpt._pricing_json || null,
        };
      }

      var textarea = document.getElementById('loadJobTextarea');
      if (textarea && typeof window.loadJobData === 'function') {
        textarea.value = JSON.stringify(stateToLoad);
        window.loadJobData();
        var modal = document.getElementById('loadJobModal');
        if (modal) modal.style.display = 'none';
        return true;
      }
      return false;
    } catch(e) {
      console.error('[Integration] Failed to load patio state:', e);
      return false;
    }
  }

  // ── Decking tool state ──
  function getDeckingState() {
    var data = typeof window.exportJobDataObject === 'function' ? window.exportJobDataObject() : null;
    if (!data) return null;
    var verification = null;
    if (window.deckingQA && window.deckingQA._verificationState) {
      verification = window.deckingQA._verificationState;
    }
    return {
      tool: 'decking',
      version: '1.0',
      client: data.client,
      config: data.config,
      extras: data.extras,
      accessories: data.accessories,
      notes: data.notes,
      pricing: data.pricing || null,
      verification: verification,
      savedAt: new Date().toISOString()
    };
  }

  function loadDeckingState(scopeJson) {
    if (!scopeJson) return false;
    try {
      if (typeof window.loadDeckingFromCloud === 'function') {
        window.loadDeckingFromCloud(scopeJson);
        return true;
      }
      return false;
    } catch(e) {
      console.error('[Integration] Failed to load decking state:', e);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // VALIDATION GATE  (blocks save if required fields are missing)
  // ════════════════════════════════════════════════════════════

  // Parse "$1,234.56" formatted strings to numbers. Returns 0 for invalid/empty.
  function parseDollar(str) {
    if (typeof str === 'number') return str;
    if (!str) return 0;
    var cleaned = String(str).replace(/[^0-9.\-]/g, '');
    var num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  // Collect and normalize form data from either tool type into a standard object
  function _collectValidationData() {
    var data = { name: '', phone: '', email: '', address: '', suburb: '', hasItems: false, sellPrice: 0, costPrice: 0 };

    if (_toolType === 'fencing' && window.app && window.app.job) {
      // ── Fencing tool ──
      var j = window.app.job;
      data.name = ((j.clientFirstName || '') + ' ' + (j.clientLastName || '')).trim() || j.client || '';
      data.phone = j.phone || '';
      data.email = j.email || '';
      data.address = j.address || '';
      data.suburb = j.suburb || '';
      data.hasItems = Array.isArray(j.runs) && j.runs.length > 0;

      // Get pricing from _collectOutputData if available
      if (typeof window.app._collectOutputData === 'function') {
        try {
          var od = window.app._collectOutputData();
          data.sellPrice = od.grandTotal || 0;
          data.costPrice = (od.internalCost || 0) + (od.internalLabour || 0);
        } catch(e) { /* pricing calc may fail if no runs */ }
      }
    } else {
      // ── Patio / Decking tools ──
      // Try gatherJobData() first (patio), then exportJobDataObject() (decking), fall back to DOM
      if (typeof window.gatherJobData === 'function') {
        try {
          var gd = window.gatherJobData();
          if (gd && gd.client) {
            data.name = gd.client.name || '';
            data.phone = gd.client.phone || '';
            data.email = gd.client.email || '';
            data.address = gd.client.address || '';
            data.suburb = gd.client.suburb || '';
          }
        } catch(e) { /* fall through to DOM */ }
      } else if (typeof window.exportJobDataObject === 'function') {
        try {
          var dd = window.exportJobDataObject();
          if (dd && dd.client) {
            data.name = dd.client.name || '';
            data.phone = dd.client.phone || '';
            data.email = dd.client.email || '';
            data.address = dd.client.address || '';
            data.suburb = dd.client.suburb || '';
          }
        } catch(e) { /* fall through to DOM */ }
      }

      // DOM fallbacks
      if (!data.name) data.name = (document.getElementById('customerName') || {}).value || '';
      if (!data.phone) data.phone = (document.getElementById('customerPhone') || {}).value || '';
      if (!data.email) data.email = (document.getElementById('clientEmail') || {}).value || '';
      if (!data.address) data.address = (document.getElementById('customerAddress') || {}).value || '';
      if (!data.suburb) data.suburb = (document.getElementById('customerSuburb') || {}).value || '';

      // hasItems check — decking uses calc.L, patio uses roof style
      if (_toolType === 'decking') {
        var deckCalc = window.calc || {};
        data.hasItems = (deckCalc.L || 0) > 0;
      } else {
        var roofStyle = (document.getElementById('inRoofStyle') || {}).value || '';
        data.hasItems = roofStyle !== '' && roofStyle !== 'none';
      }

      // Pricing from DOM
      data.sellPrice = parseDollar((document.getElementById('ttSubSell') || {}).textContent);
      data.costPrice = parseDollar((document.getElementById('ttSubCost') || {}).textContent);
    }

    // Trim all strings
    data.name = data.name.trim();
    data.phone = data.phone.trim();
    data.email = data.email.trim();
    data.address = data.address.trim();
    data.suburb = data.suburb.trim();

    return data;
  }

  // Run save validation checks. Email is intentionally not required here:
  // phone-only leads can be drafted/saved, while quote email sending validates
  // recipients in the send flow.
  function _validateForSave() {
    var d = _collectValidationData();
    var errors = [];

    if (!d.phone)      errors.push('Phone number is required');
    if (!d.address)    errors.push('Site address is required');
    if (!d.suburb)     errors.push('Suburb is required');
    if (!d.hasItems)   errors.push('At least one scope item is required');
    if (d.sellPrice <= 0) errors.push('Total sell price must be greater than $0');
    if (d.sellPrice > 0 && d.costPrice > 0 && d.sellPrice <= d.costPrice)
      errors.push('Sell price must be greater than cost price (negative margin)');

    return { valid: errors.length === 0, errors: errors };
  }

  // Show a hard-block modal with validation errors — no bypass option
  function _showValidationModal(errors) {
    // Remove any existing modal
    var existing = document.getElementById('sw-validation-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'sw-validation-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;';

    var listItems = errors.map(function(e) {
      return '<li style="margin-bottom:8px;font-size:15px;color:#333;">' + e + '</li>';
    }).join('');

    overlay.innerHTML =
      '<div style="background:#fff;border-radius:12px;width:90%;max-width:480px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
        '<div style="background:#D32F2F;padding:16px 24px;">' +
          '<h3 style="margin:0;color:#fff;font-size:18px;font-weight:700;">Cannot Save — Missing Required Info</h3>' +
        '</div>' +
        '<div style="padding:24px;">' +
          '<ul style="margin:0 0 20px 0;padding-left:20px;">' + listItems + '</ul>' +
          '<button onclick="document.getElementById(\'sw-validation-modal\').remove()" ' +
            'style="width:100%;padding:12px;background:#D32F2F;color:#fff;border:none;border-radius:8px;' +
            'font-size:16px;font-weight:700;cursor:pointer;">Fix Issues</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API  (exposed on window for button clicks)
  // ════════════════════════════════════════════════════════════

  var integration = {
    startBackgroundPhotoUpload: function(photo) {
      _startBgPhotoUpload(photo);
    },

    startBackgroundVideoUpload: function(video) {
      _startBgVideoUpload(video);
    },

    hasJobId: function() { return !!_jobId; },

    login: function() {
      if (cloud) cloud.ui.showLoginModal();
    },

    // Sign out the current user (clears auth + stops auto-save via auth:logout).
    logout: function() {
      if (cloud && cloud.auth && cloud.auth.signOut) cloud.auth.signOut();
    },

    // Auth-state helpers so a tool can render its own prominent sign-in button.
    isLoggedIn: function() {
      return !!(cloud && cloud.auth && cloud.auth.isLoggedIn());
    },
    getUser: function() {
      return (cloud && cloud.auth && cloud.auth.getUser) ? cloud.auth.getUser() : null;
    },
    // Convenience: a human label for the signed-in user (name, else email).
    getUserLabel: function() {
      var u = this.getUser();
      if (!u) return '';
      return u.name || u.full_name || u.email || '';
    },

    // Subscribe to auth changes (login/logout). The callback is invoked
    // immediately with the current state and on every subsequent change, so a
    // tool's own sign-in button stays in sync with the integration layer.
    // Returns an unsubscribe function.
    onAuthChange: function(cb) {
      if (typeof cb !== 'function') return function() {};
      _authChangeSubscribers.push(cb);
      try { cb(this.isLoggedIn(), this.getUser()); } catch (e) { console.warn('[Integration] onAuthChange cb error:', e); }
      return function() {
        var i = _authChangeSubscribers.indexOf(cb);
        if (i !== -1) _authChangeSubscribers.splice(i, 1);
      };
    },

    save: async function() {
      if (_isReadonly) {
        console.warn('[Integration] Save blocked — readonly mode');
        return;
      }
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      // ── Validation gate — hard block if required fields missing ──
      var validation = _validateForSave();
      if (!validation.valid) {
        _showValidationModal(validation.errors);
        return;
      }

      var state = _getStateFn();
      if (!state) {
        alert('Nothing to save — no job data found.');
        return;
      }

      var meta = {};
      if (state.job) {
        meta.client_name = state.job.clientName || state.job.client || '';
        meta.site_suburb = state.job.suburb || '';
        meta.client_phone = state.job.phone || '';
        meta.client_email = state.job.email || '';
        meta.site_address = state.job.address || '';
      } else if (state.customer || state.client) {
        var c = state.customer || {};
        var cl = state.client || {};
        meta.client_name = c.name || cl.name || '';
        meta.site_suburb = cl.suburb || '';
        meta.client_phone = c.phone || cl.phone || '';
        meta.client_email = c.email || cl.email || '';
        meta.site_address = c.address || cl.address || '';
      }
      // Fallback: read directly from DOM if meta is empty
      if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || {}).value || '';
      if (!meta.client_phone) meta.client_phone = (document.getElementById('customerPhone') || {}).value || '';
      if (!meta.client_email) meta.client_email = (document.getElementById('clientEmail') || {}).value || '';
      if (!meta.site_address) meta.site_address = (document.getElementById('customerAddress') || {}).value || '';
      if (!meta.site_suburb) meta.site_suburb = (document.getElementById('customerSuburb') || {}).value || '';

      // Include pricing_json if the tool attached it to job state or root state
      if (state.job && state.job._pricing_json) {
        meta.pricing_json = state.job._pricing_json;
      } else if (state._pricing_json) {
        meta.pricing_json = state._pricing_json;
      }

      try {
        cloud.ui.showSaveStatus('saving');

        if (!_jobId || (_jobId && _jobId.indexOf('local-') === 0)) {
          if (_toolType === 'fencing') {
            // Local scoping remains available, but identity creation is a
            // destructive transition. The existing two browser calls cannot
            // atomically search historical NULL mappings or serialize contact /
            // type deduplication, so this unit stops instead of minting around
            // the guarded entry owner.
            throw _entryError(
              'server_mint_required',
              'This local fence draft is safe on the iPad but cannot be promoted yet. The later server mint command must resolve scope history and return one idempotent job before cloud save.'
            );
          }
          // Use DOM fields first, then prompt as last resort
          if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || {}).value || '';

          // Walk-up: auto-create GHL contact + opportunity if not linked yet
          var contact = { name: meta.client_name, phone: meta.client_phone, email: meta.client_email, address: meta.site_address, suburb: meta.site_suburb };
          // Extract first/last name from fencing tool if available
          if (state.job && state.job.clientFirstName) {
            contact.firstName = state.job.clientFirstName;
            contact.lastName = state.job.clientLastName || '';
          }
          if (!_ghlOpportunityId) {
            // Phone is required — every contact must be reachable via SMS
            if (!meta.client_phone) {
              alert('Phone number is required to save this job. Please enter the client\'s phone number.');
              cloud.ui.showSaveStatus('error');
              return;
            }
            try {
              var ghlResult = await cloud.ghl.createContactAndOpportunity(contact, _toolType);
              if (ghlResult.opportunityId) _ghlOpportunityId = ghlResult.opportunityId;
              if (ghlResult.contactId) _ghlContactId = ghlResult.contactId;
              contact.contactId = _ghlContactId;
              console.log('[Integration] Walk-up GHL creation:', ghlResult.contactExisted ? 'existing contact' : 'new contact', 'opp:', _ghlOpportunityId);
            } catch (ghlErr) {
              console.error('[Integration] GHL contact creation FAILED:', ghlErr);
              alert('Could not create contact in GHL. Check your internet connection and try again.\n\n' + (ghlErr.message || 'Unknown error'));
              cloud.ui.showSaveStatus('error');
              return; // DO NOT create a Supabase-only orphan job
            }
          }

          // Create job via edge function (bypasses RLS)
          var job = await cloud.ghl.createJobForOpportunity(_ghlOpportunityId || null, _toolType, contact);
          _jobId = job.id;

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
        }

        // Save via edge function (bypasses RLS)
        console.log('[Integration] Saving scope for job:', _jobId);
        var savedJob = await cloud.ghl.saveScope(_jobId, state, _attachScopeSaveCursor(meta));
        var scopeQueuedLocally = !!(savedJob && savedJob.queued);
        var scopeQueuedByServerError = scopeQueuedLocally && savedJob.queuedReason === 'server_error';
        if (!scopeQueuedLocally) _rememberScopeCursor(savedJob);
        if (scopeQueuedLocally) {
          console.log('[Integration] Scope saved locally and queued for sync');
          if (_isSignOff) throw new Error('sync_required: reconnect to Wi-Fi before creating the job or sending the quote');
        } else {
          console.log('[Integration] Scope saved successfully');
        }

        // Sync fencing neighbours to job_contacts (if neighbours exist)
        if (_toolType === 'fencing' && state.job && state.job.neighboursRequired && state.job.neighbours && state.job.neighbours.length > 0 && state.job.neighbours[0].firstName) {
          var neighbourFetch = _requireAuthorizedFetch(cloud);
          neighbourFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=sync_fencing_neighbours', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: _jobId })
          }).then(function(r) { return _expectOk(r, 'Neighbour sync'); }).then(function(r) { return r.json(); }).then(function(res) {
            if (res.synced_count > 0) console.log('[Integration] Neighbours synced:', res.synced_count, 'contacts');
          }).catch(function(e) { console.warn('[Integration] Neighbour sync failed (non-blocking):', e); });
        }

        // Bridge checklist photos into sitePhotos so they get uploaded.
        // Background uploads kicked off at select time use sitePhotos entries;
        // here we ensure late-bridged items (loaded from cloud on job open) are included.
        if (window.app && window.app.job && window.app.job.checklist && window.app.job.checklist.photos) {
          if (!window.sitePhotos) window.sitePhotos = [];
          var cpPhotos = window.app.job.checklist.photos;
          for (var ci = 0; ci < cpPhotos.length; ci++) {
            var cp = cpPhotos[ci];
            if (cp.cloudUrl) continue;
            var alreadyBridged = window.sitePhotos.some(function(sp) { return sp._checklistId === cp.id; });
            if (alreadyBridged) continue;
            var uploadDataUrl = (window._photoFiles && window._photoFiles[cp.id]) || cp.uploadDataUrl || cp.dataUrl;
            if (!uploadDataUrl) continue;
            var bridgedPhoto = {
              id: cp.id + '_bridged',
              _checklistId: cp.id,
              dataUrl: uploadDataUrl,
              label: cp.name || cp.label || 'Photo',
              caption: '',
              originalSize: 0,
              compressedSize: 0
            };
            window.sitePhotos.push(bridgedPhoto);
            // Kick off background upload for newly bridged photos if jobId available
            _startBgPhotoUpload(bridgedPhoto);
          }
        }

        // ── Media upload: background-first, save-loop fallback ───────────────────
        if (_isSignOff) _lastReleasePartialFailures = [];
        var sitePhotos = window.sitePhotos || [];
        var photosNeedingUpload = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl; });
        var _failedUploads = 0;

        if (photosNeedingUpload.length > 0) {
          cloud.ui.showSaveStatus('saving', 'Uploading photos...');
          console.log('[Integration] Save loop: photos to handle:', photosNeedingUpload.length);
          for (var i = 0; i < photosNeedingUpload.length; i++) {
            var photo = photosNeedingUpload[i];
            try {
              var bgEntry = _bgUploads[photo.id];
              if (bgEntry && !bgEntry.error) {
                cloud.ui.showSaveStatus('saving', 'Waiting for photo ' + (i + 1) + '/' + photosNeedingUpload.length);
                await bgEntry.promise;
                if (!photo.cloudUrl) throw new Error('Background upload did not set cloudUrl');
              } else {
                cloud.ui.showSaveStatus('saving', 'Uploading photo ' + (i + 1) + '/' + photosNeedingUpload.length);
                delete _bgUploads[photo.id];
                await _doUploadPhoto(photo, _jobId, cloud);
              }
            } catch(photoErr) {
              _failedUploads++;
              console.warn('[Integration] Photo upload failed:', photo.label, photoErr);
            }
          }
        }

        // Re-render checklist badges after photo uploads
        if (photosNeedingUpload.length > 0 && window.app && typeof window.app.renderChecklist === 'function') {
          window.app.renderChecklist();
        }

        // Site video — NON-BLOCKING. Job creation must never wait on the walkthrough
        // video (it can be large and slow on site cellular). If a background upload is
        // already in flight we leave it running; if none ever started (fallback) we start
        // one now. Either way we do NOT await it here: its completion registers the media
        // against the job on its own (see _doUploadVideo), it self-retries on failure, and
        // its progress/failed status surfaces via _swUploadStatusChanged('__video__', …).
        var siteVideo = window.siteVideo || null;
        if (siteVideo && !siteVideo.cloudUrl && (siteVideo.file || siteVideo.dataUrl)) {
          var bgVideoEntry = _bgUploads['__video__'];
          if (!bgVideoEntry || bgVideoEntry.error) {
            delete _bgUploads['__video__'];
            _startBgVideoUpload(siteVideo);
          }
        }

        if (_failedUploads > 0) {
          if (_isSignOff) _lastReleasePartialFailures.push({ step: 'media', message: _failedUploads + ' photo upload(s) failed and will retry on next save' });
          if (window.showToast) window.showToast(_failedUploads + ' upload(s) failed — they\'ll retry on next save', 'warning');
        }
        // ── End media upload ──────────────────────────────────────────────────────

        // Re-save scope so cloudUrls from uploads are persisted (prevents duplicate photos on reload)
        if (photosNeedingUpload.length > 0) {
          try {
            var updatedState = _getStateFn();
            if (updatedState) {
              var resavedJob = await cloud.ghl.saveScope(_jobId, updatedState, _attachScopeSaveCursor(meta));
              if (resavedJob && resavedJob.queued) {
                console.warn('[Integration] Scope re-save with cloudUrls queued locally; reason:', resavedJob.queuedReason || 'offline');
                if (window.showToast) window.showToast(resavedJob.queuedReason === 'server_error'
                  ? 'Server error saving media state. Saved on this iPad only.'
                  : 'Media state saved on iPad — pending sync', 'warning');
              } else {
                _rememberScopeCursor(resavedJob);
                console.log('[Integration] Scope re-saved with cloudUrls');
              }
            }
          } catch(e) {
            if (_isScopeHashConflict(e)) throw e;
            console.warn('[Integration] Re-save after uploads failed (non-blocking):', e);
          }
        }

        // ── Post-QA only: GHL link, job number, PO, contact push ──
        // Only runs during Scope Complete (saveAfterSignOff). Regular cloud saves
        // just persist scope data — no job number, no GHL side-effects.
        if (_isSignOff) {
          // Write scope link back to GHL opportunity notes + assign job number
          var linkResult = null;
          if (!_ghlOpportunityId) {
            throw new Error('link_required: choose a GHL lead/contact before release');
          }
          try {
            linkResult = await cloud.ghl.linkScope(_ghlOpportunityId, _jobId, _toolType, _ghlContactId);
            if (linkResult && linkResult.jobNumber) {
              _lastJobNumber = linkResult.jobNumber;
              console.log('[Integration] Job number assigned:', linkResult.jobNumber);
            }
          } catch(ghlErr) {
            console.warn('[Integration] GHL link failed:', ghlErr);
            throw new Error('ghl_link_failed: ' + (ghlErr.message || ghlErr));
          }
          if (!_lastJobNumber) {
            throw new Error('job_number_missing_after_ghl_link');
          }

          // Apply job number to DOM so PDFs, toolbar, and header show the real number.
          // Per ADR 2026-04-27: status remains 'draft' until the quote is actually sent
          // to the client (release moment). assign_job_number no longer touches status.
          if (_lastJobNumber) {
            _applyJobNumber(_lastJobNumber);
          }

          // Auto-create TWO draft POs from scope: Materials + Labour (non-blocking)
          if (linkResult && linkResult.jobNumber && _jobId) {
            try {
              // Check for existing draft POs before creating new ones
              var existingPOs = [];
              var authorizedFetch = _requireAuthorizedFetch(cloud);
              try {
                var poResp = await authorizedFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=list_pos&job_id=' + _jobId);
                if (poResp.ok) {
                  var poData = await poResp.json();
                  existingPOs = (poData.purchase_orders || poData || []);
                }
              } catch(e) { console.warn('[Integration] PO check failed, will create:', e); }

              var hasDraftPOs = existingPOs.some(function(po) {
                return po.status === 'draft' && po.notes && po.notes.indexOf('Auto-generated from scope') !== -1;
              });

              if (hasDraftPOs) {
                console.log('[Integration] Draft POs already exist for job ' + _jobId + ', skipping creation');
              } else {
              // Get pricing_json line items from the scope tool state
              var pricing = (state && state.pricing) || {};
              var lineItems = pricing.line_items || pricing.items || [];
              var materialCost = pricing.materialCostEstimate || 0;
              var labourCost = pricing.labourCostEstimate || 0;

              // Split line items by category
              var materialCategories = ['steel', 'roofing', 'fencing', 'materials', 'concrete', 'flashings', 'fixings', 'guttering', 'delivery', 'gates'];
              var labourCategories = ['labour', 'installation', 'demolition', 'electrical'];

              // Group material items by supplier, keep labour separate
              var supplierGroups = {};  // { 'Bondor': [...], 'Metroll': [...], '': [...] }
              var labourItems = [];

              if (lineItems.length > 0) {
                lineItems.forEach(function(item) {
                  var cat = (item.category || '').toLowerCase();
                  var poItem = {
                    description: item.description || '',
                    quantity: item.quantity || 1,
                    unit: item.unit || 'ea',
                    unit_price: item.cost_price || item.unit_price || 0,
                  };
                  if (labourCategories.indexOf(cat) >= 0) {
                    labourItems.push(poItem);
                  } else {
                    var supplier = item.supplier_name || '';
                    if (!supplierGroups[supplier]) supplierGroups[supplier] = [];
                    supplierGroups[supplier].push(poItem);
                  }
                });
              }

              // Fallback: if no line items but we have totals, create summary items
              if (Object.keys(supplierGroups).length === 0 && materialCost > 0) {
                // Fall back to scope_to_po extraction
                var poRes = await authorizedFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=scope_to_po&jobId=' + _jobId);
                await _expectOk(poRes, 'PO material extraction');
                var poMaterials = await poRes.json();
                if (poMaterials && poMaterials.materials && poMaterials.materials.length > 0) {
                  supplierGroups[''] = poMaterials.materials;
                } else {
                  supplierGroups[''] = [{ description: 'Materials (per scope)', quantity: 1, unit: 'lot', unit_price: materialCost }];
                }
              }
              if (labourItems.length === 0 && labourCost > 0) {
                labourItems = [{ description: 'Installation labour (per scope)', quantity: 1, unit: 'lot', unit_price: labourCost }];
              }

              // U2 reference discipline (mission profit-materials-actuals-2026-07-03):
              // the draft PO's reference IS the canonical job number, and every
              // materials PO note carries the quote-back instruction so whoever
              // reviews/sends the order (in ops.html or by phone) stamps it and asks
              // the supplier to quote it on their invoice — that is what lets the
              // inbound bill-linker land the supplier's dollars on this job.
              var poJobRef = linkResult.jobNumber;
              var refDiscipline = ' Quote job ref ' + poJobRef + ' on the order and ask the supplier to quote ' + poJobRef + ' on their invoice so their bill lands on this job.';

              // Create one PO per supplier group
              var supplierNames = Object.keys(supplierGroups);
              for (var si = 0; si < supplierNames.length; si++) {
                var sName = supplierNames[si];
                var sItems = supplierGroups[sName];
                if (sItems.length === 0) continue;
                var poNotes = (sName
                  ? 'MATERIALS — ' + sName + '. Auto-generated from scope.'
                  : 'MATERIALS — Auto-generated from scope. Assign supplier and review before approving.')
                  + refDiscipline;
                var createMaterialPoRes = await authorizedFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    job_id: _jobId,
                    status: 'draft',
                    supplier_name: sName,
                    line_items: sItems,
                    reference: linkResult.jobNumber,
                    notes: poNotes
                  })
                });
                await _expectOk(createMaterialPoRes, 'Material PO creation');
                console.log('[Integration] Draft PO created for ' + (sName || 'unassigned') + ': ' + sItems.length + ' items');
              }

              // Create Labour PO
              if (labourItems.length > 0) {
                var labourPoRes = await authorizedFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    job_id: _jobId,
                    status: 'draft',
                    supplier_name: '',
                    line_items: labourItems,
                    reference: linkResult.jobNumber,
                    notes: 'LABOUR — Auto-generated from scope. Assign to trade crew and review before approving.'
                  })
                });
                await _expectOk(labourPoRes, 'Labour PO creation');
                console.log('[Integration] Draft Labour PO created');
              }

              // Sales Commission PO — % of expected gross profit, division-specific
              // patio/decking 13% of GP · fencing 15% of GP (Marnin ruling, 2026-07-05)
              // GP = revenue ex GST - material cost est - labour cost est
              var totalExGST = pricing.totalExGST || pricing.subtotal || 0;
              var matCostEst = pricing.materialCostEstimate || 0;
              var labCostEst = pricing.labourCostEstimate || 0;
              var grossProfit = totalExGST - matCostEst - labCostEst;
              var commissionRate = _toolType === 'fencing' ? 0.15 : 0.13;
              var commissionPct = _toolType === 'fencing' ? '15' : '13';
              var commissionAmount = grossProfit > 0 ? grossProfit * commissionRate : 0;
              if (commissionAmount > 0) {
                var commNote = 'SALES COMMISSION — ' + commissionPct + '% of gross profit ($' + grossProfit.toFixed(2) + ' GP).';
                var commDesc = 'Sales commission (' + commissionPct + '% of GP)';
                var commissionPoRes = await authorizedFetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    job_id: _jobId,
                    status: 'draft',
                    supplier_name: '',
                    line_items: [{ description: commDesc, quantity: 1, unit: 'lot', unit_price: commissionAmount }],
                    reference: linkResult.jobNumber,
                    notes: commNote + ' Auto-generated from scope.'
                  })
                });
                await _expectOk(commissionPoRes, 'Commission PO creation');
                console.log('[Integration] Draft Commission PO created: $' + commissionAmount.toFixed(2));
              }
              } // end if (!hasDraftPOs)
            } catch(poErr) {
              console.warn('[Integration] Draft PO creation failed (non-blocking):', poErr);
              _lastReleasePartialFailures.push({ step: 'po', message: poErr && poErr.message || String(poErr) });
            }

            // Upload quote PDF if available (blob captured during scope complete)
            try {
              var pdfBlob = null;
              // Fencing tool stores on app._capturePdfBlob, patio on window._capturePdfBlob
              if (window.app && window.app._capturePdfBlob && window.app._capturePdfBlob instanceof Blob) {
                pdfBlob = window.app._capturePdfBlob;
              } else if (window._capturePdfBlob && window._capturePdfBlob instanceof Blob) {
                pdfBlob = window._capturePdfBlob;
              }
              if (pdfBlob) {
                var pdfFileName = (linkResult.jobNumber || 'quote') + '-quote.pdf';
                await _uploadDocBlob(cloud, _jobId, linkResult.jobNumber, pdfBlob, pdfFileName, 'quote');
                console.log('[Integration] Quote PDF uploaded:', pdfFileName);
                if (window.app) window.app._capturePdfBlob = null;
                window._capturePdfBlob = null;
              }
            } catch(docErr) {
              console.warn('[Integration] Quote PDF upload failed (non-blocking):', docErr);
              _lastReleasePartialFailures.push({ step: 'pdf', message: docErr && docErr.message || String(docErr) });
            }
          }

          // Push contact details back to GHL — only send non-empty fields
          if (_ghlContactId && (meta.client_name || meta.client_email || meta.client_phone || meta.site_address || meta.site_suburb)) {
            try {
              var contactUpdate = {};
              if (meta.client_name) contactUpdate.name = meta.client_name;
              if (meta.client_email) contactUpdate.email = meta.client_email;
              if (meta.client_phone) contactUpdate.phone = meta.client_phone;
              if (meta.site_address) contactUpdate.address = meta.site_address;
              if (meta.site_suburb)  contactUpdate.suburb = meta.site_suburb;
              await cloud.ghl.updateContact(_ghlContactId, contactUpdate);
            } catch(ghlErr) {
              console.warn('[Integration] GHL contact update failed (non-blocking):', ghlErr);
            }
          }
        }

        // Start auto-save now that we have a real cloud job ID (only for draft jobs)
        if (_jobId && _jobId.indexOf('local-') !== 0 && _shouldAutoSave()) {
          cloud.startAutoSave(_jobId, _getStateFn, 30000);
        }

        if (scopeQueuedByServerError) {
          cloud.ui.showSaveStatus('offline', 'Server rejected the sync — saved on iPad only');
          if (window.updateSyncStatus) window.updateSyncStatus('local', new Date().toISOString());
          if (window.showToast) window.showToast('Server error saving to the cloud. Your work is on this iPad only — keep this device and retry.', 'warning');
        } else if (scopeQueuedLocally) {
          cloud.ui.showSaveStatus('offline', 'Saved on iPad — pending sync');
          if (window.updateSyncStatus) window.updateSyncStatus('local', new Date().toISOString());
        } else if (_lastJobNumber) {
          cloud.ui.showSaveStatus('saved', 'Saved — ' + _lastJobNumber);
          if (window.updateSyncStatus) window.updateSyncStatus('saved', new Date().toISOString());
        } else {
          cloud.ui.showSaveStatus('saved');
          if (window.updateSyncStatus) window.updateSyncStatus('saved', new Date().toISOString());
        }
        if (window.updateHeaderBadge) window.updateHeaderBadge();
        if (window.updateBottomToolbar) window.updateBottomToolbar();
        updateUI();

      } catch(e) {
        console.error('[Integration] Save failed:', e);
        cloud.ui.showSaveStatus('error');
        if (window.updateSyncStatus) window.updateSyncStatus('failed', new Date().toISOString());
        var message = (e && e.message) || String(e);
        if (_isScopeHashConflict(e)) {
          var recovered = await _handleScopeSaveError({ error: e, attemptedScope: state, fingerprint: String(_jobId) + ':manual' });
          if (recovered) return;
          message = 'Sync conflict: Supabase has a newer saved scope than this iPad loaded. Your iPad draft stayed local; reload/choose the correct scope before syncing again.';
        } else if (_isDuplicateJobNumberError(e)) {
          message = 'Recoverable conflict: duplicate job number (idx_jobs_job_number). Nothing was marked as saved — reload/link the job and retry.';
        }
        alert('Save failed: ' + message);
        throw e;
      }
    },

    loadPicker: function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      // Show GHL opportunity picker (primary flow)
      cloud.ui.showGHLPicker(_toolType, async function(opp) {
        console.log('[Integration] GHL opportunity selected:', opp.id, opp.contactName);
        try {
          await _enterJob('ghl_context', { row: opp, source: 'loadPicker' });
          var switchChoice = await _resolveFencingTargetSwitch('loadPicker', {
            jobId: opp._supabaseJobId || null,
            opportunityId: opp.id,
            label: opp.contactName || opp.name || opp.contactPhone || 'selected GHL lead'
          });
          if (switchChoice === 'cancel') return;
          _clearPendingNewOpp(opp.contactId);
          _ghlOpportunityId = opp.id;
          _ghlContactId = opp.contactId || null;

          // ── Local-wins checkpoint before loading new opportunity ──
          if (cloud) cloud.stopAutoSave();
          _jobId = null;
          _lastJobNumber = null;
          _jobLoaded = false;
          var localDraftWins = false;

          if (_toolType === 'fencing' && window.app) {
            if (switchChoice === 'keep_link') {
              localDraftWins = true;
              _checkpointLocalDraftBeforeLoad('loadPicker_keep_link');
            } else {
              localDraftWins = !_openFencingTargetSeparately('loadPicker');
            }
          } else {
            _resetPatioForm();
          }

          // Fetch full contact details from GHL (has address, suburb etc)
          var contact = null;
          if (_ghlContactId) {
            try {
              contact = await cloud.ghl.getContact(_ghlContactId);
              console.log('[Integration] Contact fetched:', contact);
            } catch(e) {
              console.warn('[Integration] Contact fetch failed, using opp data:', e);
              contact = { name: opp.contactName, email: opp.contactEmail, phone: opp.contactPhone };
            }
          } else {
            contact = { name: opp.contactName, email: opp.contactEmail, phone: opp.contactPhone };
          }

          // ── Supabase-loaded job (from "Search all jobs" fallback) ──
          if (opp._loadedFromSupabase && opp._supabaseJobId) {
            console.log('[Integration] Loading directly from Supabase job:', opp._supabaseJobId);
            var sbJob = await cloud.ghl.loadJob(opp._supabaseJobId);
            _rememberScopeCursor(sbJob);
            if (sbJob) {
              _jobId = sbJob.id;
              _ghlOpportunityId = sbJob.ghl_opportunity_id || null;
              _ghlContactId = sbJob.ghl_contact_id || null;
              _lastJobNumber = sbJob.job_number || null;
              _jobStatus = sbJob.status || 'draft';
              if (sbJob.scope_json && Object.keys(sbJob.scope_json).length > 0) {
                if (!localDraftWins) _loadFencingStateLocalWins(sbJob.scope_json, 'supabase_job_load');
              }
              if (!localDraftWins) {
                _applyJobNumber(_lastJobNumber);
                try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
              } else {
                console.log('[FenceSync] Supabase target found; local draft wins and remote job number/media stay out of the field draft.');
              }
              if (contact) _prefillContact(contact);
              _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'supabase_job_load');
              var newUrl = window.location.pathname + '?jobId=' + _jobId;
              window.history.replaceState({}, '', newUrl);
              console.log('[Integration] Supabase job loaded, URL updated:', newUrl);
              updateUI();
              if (_shouldAutoSave()) {
                cloud.startAutoSave(_jobId, _getStateFn, 30000);
              } else {
                console.log('[Integration] Auto-save skipped — job status:', _jobStatus);
              }
              return;
            }
          }

          // Check if a Supabase job already exists for this opportunity + tool type
          // Passing _toolType prevents cross-division overwrite (patio vs fencing)
          var existingJob = null;
          try {
            existingJob = await cloud.ghl.findJobByOpportunity(opp.id, _toolType);
            console.log('[Integration] Existing job for type ' + _toolType + ':', existingJob ? existingJob.id : 'none');
            _rememberScopeCursor(existingJob);
          } catch(e) {
            console.warn('[Integration] findJobByOpportunity failed:', e);
          }

          if (existingJob) {
            _jobId = existingJob.id;
            _lastJobNumber = existingJob.job_number || null;
            _jobStatus = existingJob.status || 'draft';
            console.log('[Integration] Found existing job:', _jobId, 'number:', _lastJobNumber);
            if (existingJob.scope_json && Object.keys(existingJob.scope_json).length > 0) {
              if (!localDraftWins) _loadFencingStateLocalWins(existingJob.scope_json, 'existing_opportunity_scope');
            }
            if (!localDraftWins) {
              // Override local job ref with Supabase job number (single source of truth)
              _applyJobNumber(_lastJobNumber);
              // Load photos/videos from cloud
              try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
            } else {
              console.log('[FenceSync] Existing target found; local draft wins and remote job number/media stay out of the field draft.');
            }
          } else {
            // The guarded preflight resolved an existing Supabase job before
            // this door was allowed to proceed. A changed/null second lookup is
            // ambiguous, never permission for the browser to mint around it.
            throw _entryError('identity_changed_during_entry', 'The opportunity-to-job mapping changed while opening it. Search again; nothing was created.');
          }

          // Pre-fill contact fields in the tool
          if (contact) _prefillContact(contact);
          _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'ghl_picker');

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
          console.log('[Integration] Job loaded, URL updated:', newUrl);
          updateUI();
          if (_shouldAutoSave()) {
            cloud.startAutoSave(_jobId, _getStateFn, 30000);
          } else {
            console.log('[Integration] Auto-save skipped — job status:', _jobStatus);
          }

        } catch(e) {
          console.error('[Integration] GHL load error:', e);
          alert('Error loading opportunity: ' + e.message);
        }
      });
    },

    // Search GHL leads — opens dropdown below header search bar.
    // opts.mode: 'load' (default) | 'new_job' (repeat-client, always fresh job).
    searchLeads: function(query, opts) {
      opts = opts || {};
      var mode = (opts.mode === 'new_job') ? 'new_job' : 'load';
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }
      // Don't reopen if already showing
      if (document.getElementById('sw-lead-search-dropdown')) return;

      cloud.ui.showLeadSearch(_toolType, async function(lead) {
        console.log('[Integration] Lead selected:', lead.id, lead.contactName, 'mode:', mode);
        var entryPermit;
        try {
          entryPermit = await _enterJob('ghl_context', { row: lead, source: 'lead_search', requestNew: mode === 'new_job' || lead.isContactOnly || lead.id == null });
        } catch(entryError) {
          console.warn('[FenceEntry] Lead entry stopped:', entryError);
          // Create-mode selection is awaited by the modal; reject so it unlocks
          // in place and renders the safe-stop reason instead of closing as if
          // a job had been created. Load mode owns its ordinary toast path.
          if (mode === 'new_job' || lead.isContactOnly || lead.id == null) throw entryError;
          if (window.app && window.app.showToast) window.app.showToast(entryError.message, 'error');
          else alert(entryError.message);
          return;
        }
        // new_job mode (any row) OR a contact-only row in load mode (nothing to
        // load) → start a brand-new job for that contact. Returns the promise so
        // the modal's in-flight lock can await it (AM-C). lookupFailed rows never
        // reach here (the modal blocks them).
        if (mode === 'new_job' || lead.isContactOnly || lead.id == null) {
          return _startNewJobForContact(lead, entryPermit);
        }
        try {
          var switchChoice = await _resolveFencingTargetSwitch('lead_search', {
            jobId: lead.supabaseJobId || null,
            opportunityId: lead.id,
            label: lead.contactName || lead.name || lead.contactPhone || 'selected lead'
          });
          if (switchChoice === 'cancel') return;
          _clearPendingNewOpp(lead.contactId);
          _ghlOpportunityId = lead.id;
          _ghlContactId = lead.contactId || null;

          // Local-wins checkpoint before loading the selected lead.
          if (cloud) cloud.stopAutoSave();
          _jobId = null;
          _lastJobNumber = null;
          _jobLoaded = false;
          var localDraftWins = false;

          if (_toolType === 'fencing' && window.app) {
            if (switchChoice === 'keep_link') {
              localDraftWins = true;
              _checkpointLocalDraftBeforeLoad('lead_search_keep_link');
            } else {
              localDraftWins = !_openFencingTargetSeparately('lead_search');
            }
          } else {
            _resetPatioForm();
          }

          // Fetch full contact details
          var contact = null;
          if (_ghlContactId) {
            try {
              contact = await cloud.ghl.getContact(_ghlContactId);
            } catch(e) {
              console.warn('[Integration] Contact fetch failed, using lead data:', e);
              contact = { name: lead.contactName, email: lead.contactEmail, phone: lead.contactPhone };
            }
          } else {
            contact = { name: lead.contactName, email: lead.contactEmail, phone: lead.contactPhone };
          }

          // If lead already has a Supabase job, load it
          if (lead.supabaseJobId) {
            console.log('[Integration] Lead has existing job, loading:', lead.supabaseJobId);
            var sbJob = await cloud.ghl.loadJob(lead.supabaseJobId);
            _rememberScopeCursor(sbJob);
            if (sbJob) {
              _jobId = sbJob.id;
              _ghlOpportunityId = sbJob.ghl_opportunity_id || null;
              _ghlContactId = sbJob.ghl_contact_id || null;
              _lastJobNumber = sbJob.job_number || null;
              _jobStatus = sbJob.status || 'draft';
              if (sbJob.scope_json && Object.keys(sbJob.scope_json).length > 0) {
                if (!localDraftWins) _loadFencingStateLocalWins(sbJob.scope_json, 'lead_supabase_job');
              }
              if (!localDraftWins) {
                _applyJobNumber(_lastJobNumber);
                try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
              } else {
                console.log('[FenceSync] Lead target found; local draft wins and remote job number/media stay out of the field draft.');
              }
              _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'lead_supabase_job');
              if (contact) _prefillContact(contact);
              var newUrl = window.location.pathname + '?jobId=' + _jobId;
              window.history.replaceState({}, '', newUrl);
              updateUI();
              if (_shouldAutoSave()) {
                cloud.startAutoSave(_jobId, _getStateFn, 30000);
              }
              return;
            }
          }

          // No existing job — check by opportunity ID then create
          var existingJob = null;
          if (lead.id) {
            try {
              existingJob = await cloud.ghl.findJobByOpportunity(lead.id, _toolType);
              _rememberScopeCursor(existingJob);
            } catch(e) {
              console.warn('[Integration] findJobByOpportunity failed:', e);
            }
          }

          if (existingJob) {
            _jobId = existingJob.id;
            _lastJobNumber = existingJob.job_number || null;
            _jobStatus = existingJob.status || 'draft';
            if (existingJob.scope_json && Object.keys(existingJob.scope_json).length > 0) {
              if (!localDraftWins) _loadFencingStateLocalWins(existingJob.scope_json, 'lead_existing_scope');
            }
            if (!localDraftWins) {
              _applyJobNumber(_lastJobNumber);
              try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
            } else {
              console.log('[FenceSync] Existing lead target found; local draft wins and remote job number/media stay out of the field draft.');
            }
          } else if (lead.id) {
            throw _entryError('identity_changed_during_entry', 'The opportunity-to-job mapping changed while opening it. Search again; nothing was created.');
          }

          if (contact) _prefillContact(contact);
          _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'lead_search');
          if (_jobId) {
            var newUrl = window.location.pathname + '?jobId=' + _jobId;
            window.history.replaceState({}, '', newUrl);
          }
          updateUI();
          if (_shouldAutoSave()) {
            cloud.startAutoSave(_jobId, _getStateFn, 30000);
          }
        } catch(e) {
          console.error('[Integration] Lead load error:', e);
          alert('Error loading lead: ' + e.message);
        }
      }, query || '', { mode: mode });
    },

    // Debounced version — called by oninput on header search bar
    searchLeadsDebounced: function(query) {
      // If dropdown is already open, the input handler inside showLeadSearch handles debounce
      // If not open yet, open it
      if (!document.getElementById('sw-lead-search-dropdown')) {
        this.searchLeads(query);
      }
    },

    // Legacy: load from Supabase job list directly
    loadFromSupabase: function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      cloud.ui.showJobPicker(_toolType, async function(jobId) {
        try {
          // ── Local-only new scope (no cloud job yet) ──
          if (jobId && jobId.indexOf('local-') === 0) {
            await _enterJob('resume_local', { localDraftId: jobId, source: 'load_from_supabase' });
            if (cloud) cloud.stopAutoSave();
            _jobId = jobId;
            _lastJobNumber = null;
            _jobLoaded = false;
            if (_toolType === 'fencing' && window.app) {
              if (!window.app.job) window.app.init();
              if (window.app._ensureFieldSync) window.app._ensureFieldSync('local_only_resume');
            } else {
              _resetPatioForm();
            }
            updateUI();
            return;
          }

          // ── Local-wins checkpoint before loading previous cloud job ──
          await _enterJob('editable_scope', { jobId: jobId, source: 'load_from_supabase' });
          var switchChoice = await _resolveFencingTargetSwitch('load_from_supabase', {
            jobId: jobId,
            opportunityId: null,
            label: 'selected previous scope'
          });
          if (switchChoice === 'cancel') return;
          if (cloud) cloud.stopAutoSave();
          _jobId = null;
          _lastJobNumber = null;
          _jobLoaded = false;
          var localDraftWins = false;

          if (_toolType === 'fencing' && window.app) {
            if (switchChoice === 'keep_link') {
              localDraftWins = true;
              _checkpointLocalDraftBeforeLoad('load_from_supabase_keep_link');
            } else {
              localDraftWins = !_openFencingTargetSeparately('load_from_supabase');
            }
          } else {
            _resetPatioForm();
          }

          var job = await cloud.ghl.loadJob(jobId);
          _rememberScopeCursor(job);
          _jobStatus = job.status || 'draft';
          _lastJobNumber = job.job_number || null;
          if (_lastJobNumber) _applyJobNumber(_lastJobNumber);
          if (job.scope_json && Object.keys(job.scope_json).length > 0) {
            var loaded = localDraftWins ? true : _loadFencingStateLocalWins(job.scope_json, 'load_from_supabase');
            if (loaded) {
              _jobId = jobId;
              _ghlOpportunityId = job.ghl_opportunity_id || null;
              _ghlContactId = job.ghl_contact_id || null;
              _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'load_from_supabase');
              var newUrl = window.location.pathname + '?jobId=' + _jobId;
              window.history.replaceState({}, '', newUrl);
              updateUI();
              cloud.ui.showSaveStatus('saved');
              if (_shouldAutoSave()) {
                cloud.startAutoSave(_jobId, _getStateFn, 30000);
              } else {
                console.log('[Integration] Auto-save skipped — job status:', _jobStatus);
              }
            } else {
              alert('Failed to load job data into the tool.');
            }
          } else {
            _jobId = jobId;
            _ghlOpportunityId = job.ghl_opportunity_id || null;
            _ghlContactId = job.ghl_contact_id || null;
            _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'load_from_supabase');
            var newUrl = window.location.pathname + '?jobId=' + _jobId;
            window.history.replaceState({}, '', newUrl);
            updateUI();

            if (job.client_name) {
              if (_toolType === 'fencing') {
                _prefillContact({ name: job.client_name, phone: job.client_phone || '', email: job.client_email || '', address: job.site_address || '', suburb: job.site_suburb || '' });
              } else {
                var nameFields = document.querySelectorAll('#clientName, #customerName, [name="clientName"]');
                nameFields.forEach(function(f) { if (!f.value) f.value = job.client_name; });
              }
            }

            if (_shouldAutoSave()) {
              cloud.startAutoSave(_jobId, _getStateFn, 30000);
            } else {
              console.log('[Integration] Auto-save skipped — job status:', _jobStatus);
            }
          }
        } catch(e) {
          alert('Error loading job: ' + e.message);
        }
      });
    },

    openDashboard: function() {
      window.location.href = '../dashboard/index.html';
    },

    hasReleaseAnchor: function() {
      return _hasReleaseAnchor();
    },

    resolveFencingTargetSwitch: function(source, target) {
      return _resolveFencingTargetSwitch(source, target);
    },

    // Repeat-client / contact-only helper, shared with the inline client-name
    // autocomplete (index.html). Returns a promise. Never loads an old job.
    startNewJobForContact: async function(row) {
      var permit = await _enterJob('ghl_context', { row: row, source: 'inline_contact_new_job', requestNew: true });
      return _startNewJobForContact(row, permit);
    },

    // Single guarded entry owner used by launcher/local callbacks in index.html
    // and by every cloud/direct/frozen door in this module.
    enterJob: function(intent, target) {
      return _enterJob(intent, target);
    },

    getEntryAudit: function() {
      return _entryAudit.slice();
    },

    // The checkpoint+reset sequence for opening a different target. Exposed so
    // every caller — including the inline client-name autocomplete in
    // index.html — resets through this one implementation and inherits the
    // media wipe; a hand-rolled copy silently leaks the previous client's media.
    openFencingTargetSeparately: function(source) {
      return _openFencingTargetSeparately(source);
    },

    // The media wipe on its own, for reset paths that already own their
    // checkpoint/reset sequence (startLocalDraft, resetJob) and only need the
    // queue cleared. Same invariant as openFencingTargetSeparately: a reset that
    // skips this leaks the previous client's photos into the next job.
    resetToolMediaState: function() {
      _resetToolMediaState();
    },

    // Selecting a real opportunity row settles any earlier failed new-job
    // attempt for that contact. Every path that links a row must call this or
    // the orphan opportunity gets reused by a later, legitimately-new job.
    clearPendingNewOpp: function(contactId) {
      _clearPendingNewOpp(contactId);
    },

    // The reset wipes window.sitePhotos/siteVideo, so every path that links an
    // existing job must reload its media or the scoper sees an empty grid on a
    // job that already has photos. Returns a promise.
    loadCloudMedia: function(jobId) {
      return _loadCloudMedia(jobId);
    },

    getSyncState: function() {
      return {
        jobId: _jobId,
        ghlOpportunityId: _ghlOpportunityId,
        ghlContactId: _ghlContactId,
        jobNumber: _lastJobNumber,
        hasReleaseAnchor: _hasReleaseAnchor(),
        isLocalOnly: !_isRealJobId(_jobId)
      };
    },

    ensureJobSynced: async function(options) {
      options = options || {};
      if (_isReadonly) return { ok: false, reason: 'readonly' };
      if (!_hasReleaseAnchor()) return { ok: false, reason: 'link_required', releaseState: 'needs_ghl_or_job_anchor' };
      if (!cloud) return { ok: false, reason: 'no_cloud' };
      if (!cloud.auth.isLoggedIn()) return { ok: false, reason: 'login' };
      if (!_isRealJobId(_jobId) && _ghlOpportunityId) {
        // Release state machine seam: saveAfterSignOff will create/link the real job.
        return { ok: true, reason: 'anchored_pending_cloud_job', releaseState: 'resumable_prepare_quote' };
      }
      return { ok: true, jobId: _jobId, jobNumber: _lastJobNumber || null, linked: true, releaseState: 'ready_to_freeze_scope' };
    },

    // ── Cloud save triggered after QA sign-off ──
    // Called automatically by both patio and fencing tools when scope is signed off.
    // Runs validation, saves scope + pricing + verification state to Supabase,
    // uploads photos/video, and links to GHL. Shows progress overlay.
    saveAfterSignOff: async function() {
      if (_isReadonly) {
        console.warn('[Integration] Sign-off blocked — readonly mode');
        return { success: false, reason: 'readonly' };
      }
      if (!cloud) {
        console.warn('[Integration] Cloud not available — sign-off saved locally only');
        return { success: false, reason: 'no_cloud' };
      }
      if (!cloud.auth.isLoggedIn()) {
        console.warn('[Integration] Not logged in — sign-off saved locally only');
        return { success: false, reason: 'not_logged_in' };
      }

      // Skip the validation modal — QA checks are stricter and already passed.
      var validation = _validateForSave();
      if (!validation.valid) {
        console.warn('[Integration] Validation failed after sign-off:', validation.errors);
      }

      // ── Media upload gate ─────────────────────────────────────────────────────
      var gateOk = await _mediaUploadGate();
      if (!gateOk) {
        return { success: false, reason: 'media_gate_cancelled' };
      }
      // ── End media upload gate ─────────────────────────────────────────────────

      try {
        // Set sign-off flag — this gates GHL link, job number, PO creation
        _isSignOff = true;
        await integration.save();
        if (!_lastJobNumber) {
          throw new Error('job_number_missing_after_save');
        }
        console.log('[Integration] Cloud save after sign-off completed');
        return { success: true, jobNumber: _lastJobNumber, linked: _hasReleaseAnchor(), jobId: _jobId, partialFailures: _lastReleasePartialFailures.slice() };
      } catch(e) {
        console.error('[Integration] Cloud save after sign-off failed:', e);
        return { success: false, reason: e.message };
      } finally {
        _isSignOff = false;
      }
    },

    // Convenience: create cloud job + save scope in one step (for local-only sessions)
    saveToCloud: async function() {
      return await integration.save();
    },

    // Returns true if the current session is local-only (no cloud job yet)
    isLocalOnly: function() {
      return !_jobId || (_jobId && _jobId.indexOf('local-') === 0);
    },

    // Returns the current job ID (used by tools to check if cloud-connected)
    getJobId: function() { return _jobId; },
    getLastJobNumber: function() { return _lastJobNumber; },

    // Returns whether cloud save is available
    isCloudReady: function() {
      return !!(cloud && cloud.auth.isLoggedIn());
    },

    // Cursor shared with cloud.js autosave: every save carries the server scope hash
    // that this iPad loaded/saved against, so reconnects cannot overwrite newer cloud edits.
    getScopeSaveCursor: function() {
      // Persisted legacy hashes have no trustworthy owner. Do not resurrect one
      // from _fieldSync: UNKNOWN rehydrates through missing_scope_cursor instead.
      var owned = String(_scopeCursorJobId || '') === String(_jobId || '');
      return {
        baseScopeHash: owned ? _baseScopeHash : null,
        baseScopeUpdatedAt: owned ? _baseScopeUpdatedAt : null,
        scopeCursorJobId: owned ? _scopeCursorJobId : null,
        scopeCursorProvenance: owned ? 'server_issued' : 'unknown',
        scopeCursorReconcileV1: _toolType === 'fencing'
      };
    },
    _rememberScopeCursor: _rememberScopeCursor,
    // Public recovery seam used by the offline flush and deterministic browser
    // harness. It accepts only typed save events and keeps all guard decisions
    // inside this module.
    handleScopeSaveError: _handleScopeSaveError,

    // Connect integration state from an external load path (e.g. inline name search).
    // Ensures _jobId, _ghlOpportunityId, _ghlContactId are set so saves work correctly.
    _connectJob: function(jobId, opportunityId, contactId, status) {
      _lastJobNumber = null;
      _ghlOpportunityId = opportunityId || null;
      _ghlContactId = contactId || null;
      if (status) _jobStatus = status;
      if (jobId) {
        if (String(jobId).indexOf('local-') === 0) { _baseScopeHash = null; _baseScopeUpdatedAt = null; _scopeCursorJobId = null; }
        _jobId = jobId;
        _jobLoaded = true;
        // Only update URL and start auto-save for real cloud jobs (not local-only)
        if (String(jobId).indexOf('local-') !== 0) {
          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
          if (cloud && _shouldAutoSave()) {
            cloud.startAutoSave(_jobId, _getStateFn, 30000);
          } else if (cloud && !_shouldAutoSave()) {
            console.log('[Integration] Auto-save skipped in _connectJob — job status:', _jobStatus);
          }
        }
        console.log('[Integration] _connectJob: connected to job', _jobId);
      } else if (opportunityId) {
        // No Supabase job yet — just store the GHL IDs so the next save creates one linked correctly
        console.log('[Integration] _connectJob: GHL opportunity set, no cloud job yet', opportunityId);
      } else {
        // Full reset — no job, no opportunity
        _jobId = null;
        _baseScopeHash = null;
        _baseScopeUpdatedAt = null;
        _scopeCursorJobId = null;
        _jobLoaded = false;
        if (cloud) cloud.stopAutoSave();
        console.log('[Integration] _connectJob: fully cleared');
      }
      updateUI();
    }
  };

  window._swIntegration = integration;

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════

  function init() {
    console.log('[Integration] init() called');
    cloud = window.SECUREWORKS_CLOUD;

    // Skip init if embedded in an iframe with noAuth (e.g. trade app 3D viewer)
    if (cloud && cloud.noAuth) {
      console.log('[Integration] Embedded noAuth mode — skipping integration init');
      return;
    }

    _toolType = detectToolType();
    console.log('[Integration] Tool type:', _toolType, '| Cloud:', !!cloud);

    if (_toolType === 'fencing') {
      _getStateFn = getFencingState;
      _loadStateFn = loadFencingState;
    } else if (_toolType === 'decking') {
      _getStateFn = getDeckingState;
      _loadStateFn = loadDeckingState;
    } else {
      _getStateFn = getPatioState;
      _loadStateFn = loadPatioState;
    }

    injectToolbar();

    if (!cloud) {
      updateUI();
      return;
    }

    cloud.on('auth:login', function() {
      updateUI();
      _autoLoadJob();
    });

    cloud.on('auth:logout', function() {
      _jobId = null;
      _ghlOpportunityId = null;
      _ghlContactId = null;
      cloud.stopAutoSave();
      updateUI();
    });

    cloud.on('autosave:success', function() {
      cloud.ui.showSaveStatus('saved');
    });
    cloud.on('autosave:queued', function(event) {
      if (event && event.queuedReason === 'server_error') {
        cloud.ui.showSaveStatus('offline', 'Server rejected the sync — saved on iPad only');
        if (window.updateSyncStatus) window.updateSyncStatus('local', new Date().toISOString());
        return;
      }
      cloud.ui.showSaveStatus('offline', 'Saved on iPad — pending sync');
      if (window.updateSyncStatus) window.updateSyncStatus('local', new Date().toISOString());
    });
    cloud.on('autosave:error', function(event) {
      cloud.ui.showSaveStatus('error');
      _handleScopeSaveError(event).catch(function(e) {
        console.error('[FenceSync] Save recovery failed:', e);
        _showScopeRecoveryState('recovery_failed', 'Sync recovery failed. Your iPad draft is retained and automatic retries are stopped.');
      });
    });

    cloud.on('online', function() {
      var el = document.getElementById('sw-cloud-status');
      if (el) el.textContent = el.textContent.replace(' (offline)', '');
    });
    cloud.on('offline', function() {
      var el = document.getElementById('sw-cloud-status');
      if (el && !el.textContent.includes('offline')) {
        el.textContent += ' (offline)';
      }
    });

    updateUI();

    // If already logged in, load job immediately (auth:login won't fire)
    if (cloud.auth.isLoggedIn()) {
      _autoLoadJob();
    }
  }

  // Shared job-load logic — called from auth:login AND isLoggedIn() check.
  // Guard prevents double-load.
  //
  // Branches (Scope-Memory-Saving step 8 Option B):
  //   * ?scope_revision_id=<uuid> → frozen-revision viewer mode.
  //   * Otherwise: existing live-job auto-load path.
  async function _autoLoadJob() {
    if (_jobLoaded) return;
    var urlParams = new URLSearchParams(window.location.search);
    var scopeRevId = urlParams.get('scope_revision_id');
    if (scopeRevId) {
      await _enterJob('frozen_revision', { scopeRevisionId: scopeRevId, jobId: getJobIdFromURL(), source: 'direct_revision_url' });
      if (_toolType === 'fencing' && window.app && window.app._hasMeaningfulLocalDraft && window.app._hasMeaningfulLocalDraft()) {
        var frozenChoice = await _resolveFencingTargetSwitch('frozen_revision_url', {
          jobId: getJobIdFromURL(), scopeRevisionId: scopeRevId, label: 'the sealed read-only revision'
        });
        // A frozen parent cannot accept keep_link. Keep/cancel means retain the
        // current editable scope and remove the viewer URL/readonly flag; switch
        // checkpoints then opens the sealed parent read-only.
        if (frozenChoice === 'cancel' || frozenChoice === 'keep_link') {
          _isReadonly = false;
          _jobLoaded = false;
          document.documentElement.classList.remove('readonly-mode');
          _restoreCurrentFenceUrl();
          updateUI();
          return;
        }
        _openFencingTargetSeparately('frozen_revision_url');
      }
      return _autoLoadFrozenRevision(scopeRevId);
    }
    var urlJobId = getJobIdFromURL();
    if (!urlJobId) return;
    await _enterJob('existing_job', { jobId: urlJobId, source: 'direct_job_url' });
    _jobLoaded = true;

    var localDraftWins = false;
    var switchChoice = 'open_separately';
    if (_toolType === 'fencing' && window.app) {
      // Startup/reconnect target guard: app.init() may have already restored fenceJob.
      // Never attach an existing local draft to a different ?jobId without an explicit operator choice.
      switchChoice = await _resolveFencingTargetSwitch('auto_load_url_job', {
        jobId: urlJobId,
        opportunityId: null,
        label: 'job from the URL'
      });
      if (switchChoice === 'cancel') {
        _jobLoaded = false;
        _restoreCurrentFenceUrl();
        console.log('[FenceSync] URL auto-load cancelled before setting job anchor:', urlJobId);
        return;
      }
      if (switchChoice === 'keep_link') {
        localDraftWins = true;
        _checkpointLocalDraftBeforeLoad('auto_load_url_job_keep_link');
      } else {
        localDraftWins = !_openFencingTargetSeparately('auto_load_url_job');
      }
    }
    _jobId = urlJobId;
    console.log('[Integration] Auto-loading job:', urlJobId, 'localDraftWins:', localDraftWins);
    try {
      var job = await cloud.ghl.loadJob(urlJobId);
      _rememberScopeCursor(job);
      _jobStatus = job.status || 'draft';
      // (M4 G-F1) Reopening a quoted job defaults to the READ-ONLY frozen view so
      // nobody accidentally re-publishes an old scope. Redirect to the frozen-viewer
      // URL, which sets readonly-mode on reload and reuses the existing frozen
      // machinery. "Make a revision" navigates back with ?edit=1 to bypass this and
      // load the editable clone.
      var wantsEdit = urlParams.get('edit') === '1';
      if (!wantsEdit && job.latest_frozen_scope_revision_id) {
        var _fu = new URL(window.location.href);
        _fu.searchParams.set('jobId', urlJobId);
        _fu.searchParams.set('scope_revision_id', job.latest_frozen_scope_revision_id);
        window.location.replace(_fu.toString());
        return;
      }
      if (job.scope_json && Object.keys(job.scope_json).length > 0) {
        if (!localDraftWins) _loadFencingStateLocalWins(job.scope_json, 'auto_load_url_job');
      }
      _ghlOpportunityId = job.ghl_opportunity_id || null;
      _ghlContactId = job.ghl_contact_id || null;
      _lastJobNumber = job.job_number || null;
      _linkFencingAnchor(_jobId, _ghlOpportunityId, _ghlContactId, 'auto_load_url_job');
      // Apply job number AFTER loadStateFn has finished setting the local ref
      if (!localDraftWins) _applyJobNumber(_lastJobNumber);
      if (!localDraftWins) {
        try { await _loadCloudMedia(urlJobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
      } else {
        console.log('[FenceSync] Auto-load linked cloud job but skipped remote media/scope hydration because local draft wins.');
      }
      if (_shouldAutoSave() && !localDraftWins) {
        cloud.startAutoSave(_jobId, _getStateFn, 30000);
      } else {
        console.log('[Integration] Auto-save skipped — job status:', _jobStatus, 'localDraftWins:', localDraftWins);
      }
      updateUI();
    } catch(e) {
      console.warn('[Integration] Failed to auto-load job:', e);
      _jobLoaded = false; // Allow retry
    }
  }

  // Frozen-revision branch of _autoLoadJob (Scope-Memory-Saving step 8 Option B).
  // Fetches an immutable scope_revisions row via ops-api and hydrates the
  // tool with that exact frozen scope_json. Pricing recompute still happens
  // against the current rate tables — the frozen banner shows the SEALED
  // total so the operator can compare. Auto-save is disabled by _isReadonly.
  async function _autoLoadFrozenRevision(scopeRevId) {
    _jobLoaded = true;
    console.log('[Integration] Auto-loading frozen revision:', scopeRevId);
    try {
      if (!cloud || !cloud.auth || !cloud.auth.isLoggedIn || !cloud.auth.isLoggedIn()) {
        console.warn('[Integration] No auth session — cannot load frozen revision');
        _renderFrozenError(0, 'Not signed in. Sign in via the dashboard first, then re-open this URL.');
        return;
      }
      var supabaseUrl = cloud.supabaseUrl || (cloud.config && cloud.config.supabaseUrl) || '';
      if (!supabaseUrl) {
        console.warn('[Integration] No supabaseUrl configured');
        _renderFrozenError(0, 'Cloud config missing supabaseUrl');
        return;
      }
      var authorizedFetch = _requireAuthorizedFetch(cloud);
      var resp = await authorizedFetch(supabaseUrl + '/functions/v1/ops-api?action=get_scope_revision_for_viewer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope_revision_id: scopeRevId })
      });
      if (!resp.ok) {
        var errText = '';
        try { errText = await resp.text(); } catch(_) {}
        _renderFrozenError(resp.status, errText);
        return;
      }
      var data = await resp.json();
      if (!data || !data.ok) {
        _renderFrozenError(0, (data && JSON.stringify(data.error || data)) || 'unknown error');
        return;
      }
      _jobId = data.job_id || null;
      _jobStatus = 'frozen';
      if (data.scope_json && Object.keys(data.scope_json).length > 0 && _loadStateFn) {
        _loadStateFn(data.scope_json);
      }
      _renderFrozenBanner(data, scopeRevId);
      // Load site photos + video walkthrough so the sealed job's captured media is
      // viewable/downloadable in the read-only frozen view. Previously skipped, which
      // hid the scoper's docs on reopen and left them unable to see photos/video
      // (M4 frozen-docs fix). Auto-save stays OFF: frozen mode is read-only and
      // _isReadonly already blocks every write path, so this is a pure read.
      if (_jobId) {
        try { await _loadCloudMedia(_jobId); }
        catch (e) { console.warn('[Integration] Frozen media load failed:', e); }
      }
      updateUI();
    } catch (e) {
      console.warn('[Integration] _autoLoadFrozenRevision threw:', e);
      _renderFrozenError(0, e && e.message || String(e));
    }
  }

  function _renderFrozenBanner(data, scopeRevId) {
    if (document.getElementById('sw-frozen-revision-banner')) return;
    var pricing = data.pricing_json_public || {};
    var sealedTotal = pricing.totalIncGST != null
      ? '$' + Math.round(pricing.totalIncGST).toLocaleString() + ' inc GST'
      : '—';
    var sealedAt = data.frozen_at
      ? new Date(data.frozen_at).toLocaleString('en-AU')
      : '—';
    var jobId = data.job_id || null;
    var banner = document.createElement('div');
    banner.id = 'sw-frozen-revision-banner';
    banner.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:99999',
      'background:#F15A29','color:#fff','padding:6px 14px',
      'font-family:Helvetica,Arial,sans-serif','font-size:11px','font-weight:600',
      'letter-spacing:0.3px','box-shadow:0 2px 6px rgba(0,0,0,0.2)',
      'display:flex','align-items:center','justify-content:center',
      'flex-wrap:wrap','gap:8px'
    ].join(';');

    // Sealed-info text span
    var infoSpan = document.createElement('span');
    infoSpan.textContent =
      '🔒 FROZEN REVISION r' + (data.revision_number || '?') +
      ' · ' + (data.status || '').toUpperCase() +
      ' · sealed ' + sealedAt +
      ' · sealed total ' + sealedTotal +
      ' · read-only';
    banner.appendChild(infoSpan);

    // Controls area
    var controls = document.createElement('span');
    controls.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-shrink:0;';

    // "Make a revision" button (G-F2)
    var revBtn = document.createElement('button');
    revBtn.textContent = 'Make a revision';
    revBtn.style.cssText = [
      'background:#fff','color:#c04a1a','border:none','border-radius:4px',
      'padding:2px 10px','font-size:11px','font-weight:700','cursor:pointer',
      'white-space:nowrap'
    ].join(';');
    revBtn.onclick = function() { _makeRevision(scopeRevId, jobId); };
    controls.appendChild(revBtn);

    // Version switcher select (G-F3) — hidden until _loadRevisionSwitcher shows it
    var switcher = document.createElement('select');
    switcher.id = 'sw-frozen-rev-switcher';
    switcher.style.cssText = [
      'display:none','font-size:11px','border-radius:4px','padding:1px 4px',
      'border:none','background:#fff2ec','color:#7a2e00','cursor:pointer'
    ].join(';');
    controls.appendChild(switcher);

    banner.appendChild(controls);
    banner.dataset.swPadTop = '36';
    document.body.appendChild(banner);
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0', 10) + 36) + 'px';

    // Populate switcher asynchronously (stays hidden if only one revision)
    _loadRevisionSwitcher(jobId, scopeRevId, switcher);
  }

  function _renderFrozenError(status, msg) {
    if (document.getElementById('sw-frozen-error-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'sw-frozen-error-banner';
    banner.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:99999',
      'background:#c00','color:#fff','padding:8px 14px',
      'font-family:Helvetica,Arial,sans-serif','font-size:12px','font-weight:600',
      'text-align:center'
    ].join(';');
    var prefix = status ? ('HTTP ' + status + ' — ') : '';
    banner.textContent = 'Failed to load frozen revision: ' + prefix + (msg || '').slice(0, 300);
    banner.dataset.swPadTop = '32';
    document.body.appendChild(banner);
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0', 10) + 32) + 'px';
  }

  // Tear down every frozen-viewer chrome element and give back the body padding
  // each one reserved. Pairs with _renderFrozenBanner / _renderFrozenError so a
  // job that leaves the frozen viewer can never keep a stale banner (whose
  // controls close over the OLD revision/job) pinned over an editable scope.
  function _clearFrozenViewerChrome() {
    ['sw-frozen-revision-banner', 'sw-frozen-error-banner'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var reserved = parseInt((el.dataset && el.dataset.swPadTop) || '0', 10);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (reserved) {
        var current = parseInt(document.body.style.paddingTop || '0', 10);
        document.body.style.paddingTop = Math.max(0, current - reserved) + 'px';
      }
    });
  }

  // (M4 G-F2/G-F5) Clone the current frozen revision into an editable draft and
  // reopen the tool in edit mode. Warns first if the client already accepted.
  async function _makeRevision(scopeRevId, jobId) {
    await _enterJob('amendment', { scopeRevisionId: scopeRevId, jobId: jobId, source: 'frozen_banner' });
    var accepted = false;
    try { accepted = await _quoteAccepted(jobId); } catch (_e) {
      window.alert('Could not verify whether the client has accepted this quote. Revision editing is blocked until quote status can be checked.');
      return;
    }
    var msg = accepted
      ? 'This quote was ACCEPTED by the client (a deposit invoice may exist).\n\nMaking a revision creates a new version. It will NOT change or void the existing deposit invoice.\n\nContinue?'
      : 'Make a revision?\n\nThis creates an editable copy of the sealed scope. On sign-off it becomes a new version that supersedes this one.';
    if (!window.confirm(msg)) return;
    try {
      var supabaseUrl = cloud.supabaseUrl || (cloud.config && cloud.config.supabaseUrl) || '';
      var authorizedFetch = _requireAuthorizedFetch(cloud);
      var resp = await authorizedFetch(supabaseUrl + '/functions/v1/ops-api?action=clone_scope_for_edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope_revision_id: scopeRevId })
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        var code = data && data.error && data.error.code;
        // draft_already_exists → a revision draft is already open; just enter edit mode.
        if (code !== 'draft_already_exists') {
          window.alert('Could not start a revision: ' + (code || ('HTTP ' + resp.status)));
          return;
        }
      }
      var u = new URL(window.location.href);
      u.searchParams.set('jobId', jobId);
      u.searchParams.delete('scope_revision_id');
      u.searchParams.set('edit', '1');
      window.location.replace(u.toString());
    } catch (e) {
      window.alert('Could not start a revision: ' + (e && e.message || e));
    }
  }

  // (M4 G-F3) Populate the read-only version switcher. Stays hidden unless the job
  // has more than one frozen/superseded revision.
  async function _loadRevisionSwitcher(jobId, currentRevId, selectEl) {
    if (!selectEl || !jobId) return;
    try {
      var supabaseUrl = cloud.supabaseUrl || (cloud.config && cloud.config.supabaseUrl) || '';
      var authorizedFetch = _requireAuthorizedFetch(cloud);
      var resp = await authorizedFetch(supabaseUrl + '/functions/v1/ops-api?action=list_scope_revisions_for_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      var data = await resp.json();
      if (!data || !data.ok || !data.revisions) return;
      var revs = data.revisions.filter(function(r) { return r.status === 'frozen' || r.status === 'superseded'; });
      if (revs.length <= 1) return;
      selectEl.innerHTML = '';
      revs.forEach(function(r) {
        var opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = 'Revision ' + r.revision_number + (r.status === 'superseded' ? ' (superseded)' : '');
        if (r.id === currentRevId) opt.selected = true;
        selectEl.appendChild(opt);
      });
      selectEl.style.display = '';
      selectEl.onchange = function() {
        var u = new URL(window.location.href);
        u.searchParams.set('jobId', jobId);
        u.searchParams.set('scope_revision_id', selectEl.value);
        window.location.replace(u.toString());
      };
    } catch (e) { console.warn('[Integration] revision switcher load failed:', e); }
  }

  // (M4 G-F5 helper) Authoritative check whether this job's quote was accepted.
  // Reuses window._quoteStatusCache (populated by the quote-status badge in
  // index.html). Falls back to a direct GET on /functions/v1/send-quote/status.
  async function _quoteAccepted(jobId) {
    if (window._quoteStatusCache && window._quoteStatusCache.job_id === jobId) {
      return window._quoteStatusCache.status === 'accepted';
    }
    try {
      var supabaseUrl = cloud.supabaseUrl || (cloud.config && cloud.config.supabaseUrl) || '';
      var authorizedFetch = _requireAuthorizedFetch(cloud);
      var resp = await authorizedFetch(supabaseUrl + '/functions/v1/send-quote/status?job_id=' + encodeURIComponent(jobId));
      await _expectOk(resp, 'Quote status check');
      var d = await resp.json();
      return !!(d && d.status === 'accepted');
    } catch (_e) { throw new Error('quote_status_unverified: ' + (_e && _e.message || _e)); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 200); });
  } else {
    setTimeout(init, 200);
  }

})();

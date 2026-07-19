// ════════════════════════════════════════════════════════════
// SecureWorks — Cloud Module (Supabase)
// Auth, Job CRUD, Media Upload, Offline Queueing
//
// Usage: Include after Supabase CDN script + brand.js
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="../shared/brand.js"></script>
//   <script src="../shared/cloud.js"></script>
//
// Configure: Set SUPABASE_URL and SUPABASE_ANON_KEY before loading,
//   or the module reads from <meta> tags:
//   <meta name="supabase-url" content="https://xxx.supabase.co">
//   <meta name="supabase-anon-key" content="eyJ...">
//
// The module exposes window.SECUREWORKS_CLOUD — scoping tools check
// for this to know if cloud features are available.
// ════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // ── Iframe Guard ──
  // If loaded inside an iframe with noAuth=true (e.g. trade app 3D viewer),
  // provide a stub cloud object that won't crash but skips auth, redirects, and auto-save.
  var _isEmbedded = window !== window.top;
  var _noAuth = new URLSearchParams(window.location.search).get('noAuth') === 'true';
  if (_isEmbedded && _noAuth) {
    console.log('[SecureWorks Cloud] Embedded mode (noAuth) — skipping auth init');
    // Stub object with no-op methods so patio tool code doesn't crash
    var _noop = function() {};
    var _noopPromise = function() { return Promise.resolve(null); };
    window.SECUREWORKS_CLOUD = {
      embedded: true, noAuth: true,
      on: _noop, off: _noop, emit: _noop,
      startAutoSave: _noop, stopAutoSave: _noop,
      auth: { isLoggedIn: function() { return false; }, getUser: _noopPromise },
      ghl: {
        search: _noopPromise, getContact: _noopPromise, loadJob: _noopPromise,
        saveScope: _noopPromise, findJobByOpportunity: _noopPromise, listMedia: _noopPromise,
        searchJobs: _noopPromise, linkScope: _noopPromise, createJobForOpportunity: _noopPromise,
        createContactAndOpportunity: _noopPromise, uploadPhoto: _noopPromise,
      },
      ui: { showGHLPicker: _noop, showJobPicker: _noop, showLoginModal: _noop, showSaveStatus: _noop },
      supabase: null,
    };
    return;
  }

  // ── Configuration ──
  var metaUrl = document.querySelector('meta[name="supabase-url"]');
  var metaKey = document.querySelector('meta[name="supabase-anon-key"]');
  var SUPABASE_URL = window.SUPABASE_URL || (metaUrl && metaUrl.content) || '';
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || (metaKey && metaKey.content) || '';
  // Shared key fallback: field work must never hard-block when a per-user session is absent.
  var SW_API_KEY = window.SW_API_KEY || '097a1160f9a8b2f517f4770ebbe88dca105a36f816ef728cc8724da25b2667dc';

  console.log('[SecureWorks Cloud] URL:', SUPABASE_URL ? 'found' : 'MISSING');
  console.log('[SecureWorks Cloud] Key:', SUPABASE_ANON_KEY ? 'found' : 'MISSING');
  console.log('[SecureWorks Cloud] supabase global:', typeof window.supabase);

  // Bail if no config — tools work offline
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log('[SecureWorks Cloud] No Supabase config found — running in offline mode');
    return;
  }

  // Check for Supabase library
  if (!window.supabase || !window.supabase.createClient) {
    console.warn('[SecureWorks Cloud] Supabase JS library not loaded');
    return;
  }

  console.log('[SecureWorks Cloud] Initialising...');

  // ── Init Supabase Client ──
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── State ──
  var _user = null;
  var _userProfile = null;
  var _orgId = null;
  var _online = navigator.onLine;
  var _offlineQueue = [];
  var _offlineJobIdMap = {};
  var _listeners = {};
  var _autoSaveTimer = null;
  var _autoSaveContext = null;
  var _flushPromise = null;

  // ── Event System ──
  function emit(event, data) {
    (_listeners[event] || []).forEach(function(fn) { fn(data); });
  }

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
  }

  function _authError() {
    var err = new Error('Authentication required: sign in before syncing SecureWorks cloud data.');
    err.code = 'auth_required';
    return err;
  }

  async function authorizedHeaders(extra) {
    // Prefer the signed-in user's JWT (per-user attribution). If the session is
    // missing or expired, try one refresh, then fall back to the shared key so a
    // logged-in-but-session-evicted field user is never hard-blocked from syncing.
    var token = null;
    try {
      var result = await sb.auth.getSession();
      var session = result && result.data && result.data.session;
      token = session && session.access_token;
      if (!token) {
        var refreshed = await sb.auth.refreshSession();
        token = refreshed && refreshed.data && refreshed.data.session && refreshed.data.session.access_token;
      }
    } catch (e) {
      token = null;
    }
    var h = { 'Content-Type': 'application/json' };
    if (token) {
      h['Authorization'] = 'Bearer ' + token;
    } else {
      h['x-api-key'] = SW_API_KEY;
    }
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
  }

  // Parse a JSON body without letting a non-JSON error page (a plain-text 404
  // from the platform when the function is missing, an HTML 502) throw before
  // the caller can decide what the status actually means.
  async function _safeJson(res) {
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Sticky for the session once the deployed ghl-proxy has told us lead_search
  // does not exist, so the hot path (400ms-debounced autocomplete) stops paying
  // for a doomed probe on every keystroke. A page reload re-probes.
  var _leadSearchUnavailable = false;
  // Consecutive ambiguous misses ON THE SAME QUERY. An HTML 400 from a gateway
  // looks identical to a missing action, so one is never enough to latch the
  // session onto the legacy path (which cannot return contact-only rows). Scoped
  // to one query so unrelated failures across different searches can't add up.
  var _leadSearchMisses = 0;
  var _leadSearchMissQuery = null;
  var _LEAD_SEARCH_MISS_LIMIT = 2;

  // The edge function rejected the ACTION itself (rather than the request
  // payload) — i.e. this build is ahead of the deployed ghl-proxy.
  // 'confirmed' is safe to latch on for the session; 'maybe' falls back for this
  // call only, so a transient blip self-heals on the next keystroke; 'soft'
  // falls back too but never counts toward the latch.
  function _unknownActionSignal(res, data) {
    if (res.status === 501) return 'confirmed';
    // Only a status that plausibly means "this route does not exist" may confirm,
    // so a 500 whose body happens to mention an action can never latch the
    // session onto the legacy path.
    if (res.status !== 400 && res.status !== 404) return false;
    // An explicit machine-readable code is the one signal that means the ACTION
    // was rejected rather than the payload.
    var code = String((data && data.code) || '').toLowerCase();
    if (/^(unknown|invalid|unsupported|unrecogni[sz]ed)_action$/.test(code)) return 'confirmed';
    // This backend reports errors as {error: '...'} with no code field, so the
    // canonical undeployed-action reply is a 400 "Unknown action: lead_search"
    // and prose has to be able to confirm on a 400 too. Only phrasing that
    // rejects the ACTION ITSELF counts — a live action rejecting its payload
    // ("invalid action parameters") means the action EXISTS.
    var msg = String((data && data.error) || '').toLowerCase();
    if (/\b(unknown|invalid|unsupported|unrecogni[sz]ed|no such)\s+action\b(?!\s+(?:param|arg|payload|body|input|field))/.test(msg) ||
      /\baction\b[^.]{0,40}\b(?:is\s+)?(?:not supported|not recogni[sz]ed|not allowed|unknown|does not exist)/.test(msg)) {
      return 'confirmed';
    }
    // A 404 can't be ruled out as an unknown action, but it is also what a
    // backend may answer a zero-result search with. It falls back for this call
    // only and NEVER counts toward the latch: a run of no-match searches must
    // not strand the session on a path that cannot return contact-only rows.
    if (res.status === 404) return 'soft';
    // A 400 whose body won't parse is a gateway/HTML reply — a live action
    // rejecting a payload would answer JSON — so it stays a countable miss.
    if (!data) return 'maybe';
    return false;
  }

  // Merge a caller's abort signal into a fetch options object.
  function _signalOpts(opts, base) {
    var out = Object.assign({}, base || {});
    if (opts && opts.signal) out.signal = opts.signal;
    return out;
  }

  // Matches what fetch itself rejects with, so callers can treat a give-up
  // between round trips exactly like an aborted request.
  function _abortError() {
    var e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  async function authorizedFetch(url, options) {
    options = options || {};
    var headers = await authorizedHeaders(options.headers || {});
    return fetch(url, Object.assign({}, options, { headers: headers }));
  }

  // ── Online/Offline Detection ──
  window.addEventListener('online', function() {
    _online = true;
    emit('online');
    _flushQueue();
    // A confirmed browser connectivity transition starts a fresh transport
    // budget. Conflict/ref stops remain owned by the integration reconciler.
    if (_autoSaveContext && _autoSaveContext.transportAttempts) resumeAutoSave({ immediate: true });
  });

  window.addEventListener('offline', function() {
    _online = false;
    emit('offline');
  });

  // ── Offline Queue ──
  function _newOpId(prefix) {
    return (prefix || 'op') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function _saveOfflineQueue() {
    try { localStorage.setItem('sw_offline_queue', JSON.stringify(_offlineQueue)); } catch(e) {}
  }

  function _loadOfflineJobIdMap() {
    try {
      var raw = localStorage.getItem('sw_offline_job_id_map');
      _offlineJobIdMap = raw ? JSON.parse(raw) : {};
    } catch(e) { _offlineJobIdMap = {}; }
    return _offlineJobIdMap;
  }

  function _saveOfflineJobIdMap() {
    try { localStorage.setItem('sw_offline_job_id_map', JSON.stringify(_offlineJobIdMap || {})); } catch(e) {}
  }

  function _recordOfflineJournal(action, status, detail) {
    try {
      var raw = localStorage.getItem('sw_offline_journal');
      var journal = raw ? JSON.parse(raw) : [];
      journal.push({
        opId: action && action.opId || _newOpId('journal'),
        type: action && action.type || 'unknown',
        localJobId: action && action.jobId || (action && action.data && action.data.id) || null,
        status: status,
        detail: detail || null,
        at: new Date().toISOString()
      });
      if (journal.length > 120) journal = journal.slice(journal.length - 120);
      localStorage.setItem('sw_offline_journal', JSON.stringify(journal));
    } catch(e) {}
  }

  function _sameLogicalSave(a, b) {
    return a && b && a.type === 'save_job' && b.type === 'save_job' && String(a.jobId) === String(b.jobId);
  }

  function _mergeSaveMeta(original, latest, jobId) {
    original = Object.assign({}, original || {});
    latest = Object.assign({}, latest || {});
    delete original._flushAttempt;
    delete latest._flushAttempt;
    var hashSource = (original.baseScopeHash || original.expectedScopeHash || original.scope_hash) ? original : latest;
    var baseScopeHash = hashSource.baseScopeHash || hashSource.expectedScopeHash || hashSource.scope_hash || null;
    var baseScopeUpdatedAt = original.baseScopeUpdatedAt || latest.baseScopeUpdatedAt || null;
    var merged = Object.assign({}, original, latest);
    if (baseScopeHash) merged.baseScopeHash = baseScopeHash;
    if (baseScopeUpdatedAt) merged.baseScopeUpdatedAt = baseScopeUpdatedAt;
    if (hashSource.scopeCursorJobId) merged.scopeCursorJobId = hashSource.scopeCursorJobId;
    // Quarantine belongs to the surviving cursor, not to the action it merged
    // into: re-derive it so an owned cursor cannot inherit an earlier stripped
    // cursor's flag and trip the flush guard.
    delete merged.cursorQuarantined;
    if (merged.scopeCursorReconcileV1 === true && baseScopeHash
        && String(merged.scopeCursorJobId || '') !== String(jobId == null ? '' : jobId)) {
      merged.cursorQuarantined = true;
      delete merged.baseScopeHash;
      delete merged.baseScopeUpdatedAt;
    }
    delete merged._flushAttempt;
    return merged;
  }

  function _upsertQueuedAction(action, recordStatus, detail) {
    action = action || {};
    if (!action.opId) action.opId = _newOpId(action.type || 'offline');
    if (!action.createdAt) action.createdAt = new Date().toISOString();
    if (action.meta) delete action.meta._flushAttempt;
    if (action.type === 'save_job') {
      for (var i = 0; i < _offlineQueue.length; i++) {
        if (_sameLogicalSave(_offlineQueue[i], action)) {
          var existing = _offlineQueue[i];
          existing.scopeJson = action.scopeJson;
          existing.meta = _mergeSaveMeta(existing.meta, action.meta, existing.jobId || action.jobId);
          existing.updatedAt = new Date().toISOString();
          _offlineQueue[i] = existing;
          _saveOfflineQueue();
          if (recordStatus) _recordOfflineJournal(action, recordStatus, Object.assign({ coalescedIntoOpId: existing.opId }, detail || {}));
          return existing;
        }
      }
    }
    _offlineQueue.push(action);
    _saveOfflineQueue();
    if (recordStatus) _recordOfflineJournal(action, recordStatus, detail);
    return action;
  }

  function _enqueue(action) {
    return _upsertQueuedAction(action, 'queued');
  }

  function _retainUnresolvedAction(action) {
    if (action && action.meta) delete action.meta._flushAttempt;
    if (action && action.type === 'save_job') {
      for (var i = 0; i < _offlineQueue.length; i++) {
        if (_sameLogicalSave(_offlineQueue[i], action)) {
          var newer = _offlineQueue[i];
          newer.meta = _mergeSaveMeta(action.meta, newer.meta);
          newer.updatedAt = new Date().toISOString();
          _offlineQueue[i] = newer;
          _saveOfflineQueue();
          return newer;
        }
      }
    }
    return _upsertQueuedAction(action, null);
  }

  function _discardQueuedScopePayload(jobId, scopeJson) {
    var wanted;
    var wantedFingerprint;
    try {
      wanted = JSON.stringify(scopeJson);
      wantedFingerprint = _autoSaveFingerprint(jobId, scopeJson);
    } catch(e) { return false; }
    var removed = false;
    _offlineQueue = _offlineQueue.filter(function(action) {
      if (removed || !action || action.type !== 'save_job' || String(action.jobId) !== String(jobId)) return true;
      try {
        if (JSON.stringify(action.scopeJson) !== wanted && _autoSaveFingerprint(jobId, action.scopeJson) !== wantedFingerprint) return true;
      } catch(e) { return true; }
      removed = true;
      return false;
    });
    if (removed) _saveOfflineQueue();
    return removed;
  }

  function _queueScopeSave(jobId, scopeJson, meta, queuedReason) {
    meta = Object.assign({}, meta || {});
    delete meta._flushAttempt;
    delete meta._autoSaveAttempt;
    if (meta.scopeCursorReconcileV1 === true && meta.baseScopeHash && String(meta.scopeCursorJobId || '') !== String(jobId)) {
      // A capable client may retain the payload, but an unowned legacy hash is
      // UNKNOWN and must never be replayed as a cursor for this target.
      delete meta.baseScopeHash;
      delete meta.expectedScopeHash;
      delete meta.scope_hash;
      meta.cursorQuarantined = true;
      meta.scopeCursorProvenance = 'unknown';
    }
    try { localStorage.setItem('sw_job_' + jobId, JSON.stringify(scopeJson)); } catch(e) {}
    _enqueue({ type: 'save_job', jobId: jobId, scopeJson: scopeJson, meta: meta });
    emit('job:saved_local', { jobId: jobId, queued: true, queuedReason: queuedReason || 'offline' });
    return {
      id: jobId,
      local: true,
      queued: true,
      queuedReason: queuedReason || 'offline',
      current_scope_hash: meta.baseScopeHash || meta.expectedScopeHash || meta.scope_hash || null,
      current_scope_updated_at: meta.baseScopeUpdatedAt || null
    };
  }

  function _loadQueue() {
    try {
      var raw = localStorage.getItem('sw_offline_queue');
      if (raw) _offlineQueue = JSON.parse(raw);
    } catch(e) { _offlineQueue = []; }
    _loadOfflineJobIdMap();
  }

  function _scopeCursorFromJob(job) {
    if (!job) return null;
    var hash = job.current_scope_hash || job.currentScopeHash || null;
    var updatedAt = job.current_scope_updated_at || job.updated_at || null;
    return hash || updatedAt ? {
      baseScopeHash: hash,
      baseScopeUpdatedAt: updatedAt,
      scopeCursorJobId: job.id || job.job_id || null,
      scopeCursorProvenance: 'server_issued'
    } : null;
  }

  function _applyScopeCursor(meta, cursor) {
    meta = Object.assign({}, meta || {});
    if (cursor && cursor.baseScopeHash) meta.baseScopeHash = cursor.baseScopeHash;
    if (cursor && cursor.baseScopeUpdatedAt) meta.baseScopeUpdatedAt = cursor.baseScopeUpdatedAt;
    if (cursor && cursor.scopeCursorJobId) meta.scopeCursorJobId = cursor.scopeCursorJobId;
    if (cursor && cursor.scopeCursorProvenance) meta.scopeCursorProvenance = cursor.scopeCursorProvenance;
    if (cursor && cursor.baseScopeHash) delete meta.cursorQuarantined;
    delete meta._flushAttempt;
    return meta;
  }

  function _advancePendingSaveCursor(originalJobId, mappedJobId, savedJob) {
    var cursor = _scopeCursorFromJob(savedJob);
    if (!cursor) return;
    var changed = false;
    for (var i = 0; i < _offlineQueue.length; i++) {
      var action = _offlineQueue[i];
      if (action.type !== 'save_job') continue;
      if (String(action.jobId) !== String(originalJobId) && String(action.jobId) !== String(mappedJobId)) continue;
      action.meta = _applyScopeCursor(action.meta, cursor);
      changed = true;
    }
    if (changed) _saveOfflineQueue();
  }

  function _isScopeConflict(e) {
    var code = e && (e.code || (e.details && e.details.code));
    var msg = String((e && (e.message || e.error)) || e || '');
    return ['scope_hash_conflict', 'missing_scope_cursor', 'scope_ref_mismatch'].indexOf(code) !== -1 ||
      /scope_hash_conflict|missing_scope_cursor|scope_ref_mismatch|Scope changed in Supabase/i.test(msg);
  }

  function _emitFlush(status, action, detail) {
    emit('offline:flush', Object.assign({
      status: status,
      type: action && action.type || 'unknown',
      jobId: action && action.jobId || (action && action.data && action.data.id) || null,
      opId: action && action.opId || null
    }, detail || {}));
  }

  async function _flushQueue() {
    if (_flushPromise) return _flushPromise;
    _flushPromise = (async function() {
      _loadOfflineJobIdMap();
      if (!_online || _offlineQueue.length === 0) return;
      var queue = _offlineQueue.slice();
      _offlineQueue = [];
      localStorage.removeItem('sw_offline_queue');
      var localJobIdMap = Object.assign({}, _offlineJobIdMap || {});
      var scopeCursors = {};

      for (var i = 0; i < queue.length; i++) {
        var action = queue[i];
        try {
          if (action.type === 'create_job') {
            var localJob = action.data || {};
            var created = await cloud.createJob(localJob.type || 'patio', localJob);
            if (localJob.id && created && created.id) {
              localJobIdMap[localJob.id] = created.id;
              _offlineJobIdMap[localJob.id] = created.id;
              _saveOfflineJobIdMap();
              _recordOfflineJournal(action, 'flushed', { jobId: created.id });
              _emitFlush('success', action, { jobId: created.id });
            }
          } else if (action.type === 'save_job') {
            var jobId = localJobIdMap[action.jobId] || action.jobId;
            var cursorKey = String(jobId);
            var meta = Object.assign({}, action.meta || {}, { _flushAttempt: true });
            if (scopeCursors[cursorKey]) meta = Object.assign(_applyScopeCursor(meta, scopeCursors[cursorKey]), { _flushAttempt: true });
            if (meta.cursorQuarantined && !scopeCursors[cursorKey]) {
              var unknownCursorError = new Error('Queued cursor ownership is unknown; rehydrate before write');
              unknownCursorError.name = 'ScopeSaveError';
              unknownCursorError.httpStatus = 409;
              unknownCursorError.status = 409;
              unknownCursorError.reason = 'missing_scope_cursor';
              unknownCursorError.code = 'missing_scope_cursor';
              unknownCursorError.jobId = jobId;
              unknownCursorError.targetJobId = jobId;
              unknownCursorError.requestId = action.opId;
              unknownCursorError.loadServerScope = function(opts) { return ghl.loadJob(this.targetJobId, opts); };
              throw unknownCursorError;
            }
            var savedJob = await ghl.saveScope(jobId, action.scopeJson, meta);
            var cursor = _scopeCursorFromJob(savedJob);
            if (cursor) scopeCursors[cursorKey] = cursor;
            _advancePendingSaveCursor(action.jobId, jobId, savedJob);
            _recordOfflineJournal(action, 'flushed', { jobId: jobId });
            _emitFlush('success', action, { jobId: jobId, cursor: cursor || null });
          } else if (action.type === 'update_status') {
            var mappedJobId = localJobIdMap[action.jobId] || action.jobId;
            try {
              await cloud.updateJobStatus(mappedJobId, action.status);
              _recordOfflineJournal(action, 'flushed', { jobId: mappedJobId });
              _emitFlush('success', action, { jobId: mappedJobId });
            } catch(e2) {
              console.warn('[Cloud] Status update failed:', e2);
              throw e2;
            }
          }
        } catch(e) {
          var conflict = _isScopeConflict(e);
          console.warn('[Cloud] Failed to flush queued action:', e);
          _recordOfflineJournal(action, conflict ? 'conflict' : 'failed', { message: e && e.message || String(e), code: e && e.code || null });
          _retainUnresolvedAction(action);
          _emitFlush(conflict ? 'conflict' : 'failure', action, { message: e && e.message || String(e), code: e && e.code || null });
          if (conflict && action.type === 'save_job') {
            emit('autosave:error', {
              jobId: action.jobId,
              error: e,
              attemptedScope: action.scopeJson,
              fingerprint: _autoSaveFingerprint(action.jobId, action.scopeJson),
              fromOfflineQueue: true,
              retryStopped: true
            });
          }
        }
      }
    })();
    try {
      await _flushPromise;
    } finally {
      _flushPromise = null;
    }
  }

  // ════════════════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════════════════

  var auth = {
    // Send magic link email
    async sendMagicLink(email) {
      // Use current URL if on GitHub Pages, otherwise fall back to GitHub Pages patio URL
      var redirectUrl = window.location.href.split('?')[0].split('#')[0];
      if (redirectUrl.startsWith('file:') || redirectUrl.includes('127.0.0.1') || redirectUrl.includes('localhost')) {
        // Local dev — redirect to GitHub Pages so the link actually works
        var title = (document.title || '').toLowerCase();
        redirectUrl = title.includes('fence') ? 'https://marninms98-dotcom.github.io/fence-designer/' : 'https://marninms98-dotcom.github.io/patio/';
      }
      var result = await sb.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: redirectUrl }
      });
      if (result.error) throw result.error;
      return true;
    },

    // Sign in with email + password (fallback)
    async signIn(email, password) {
      var result = await sb.auth.signInWithPassword({ email: email, password: password });
      if (result.error) throw result.error;
      _user = result.data.user;
      await _loadUserProfile();
      emit('auth:login', _userProfile);
      return _userProfile;
    },

    // Sign out
    async signOut() {
      await sb.auth.signOut();
      _user = null;
      _userProfile = null;
      _orgId = null;
      emit('auth:logout');
    },

    // Get current user
    getUser() { return _userProfile; },

    // Check if logged in
    isLoggedIn() { return !!_user; },

    // Get current user role
    getRole() { return _userProfile?.role || null; },

    // Get current Supabase session (v2 API - reads local storage, auto-refreshes). Returns null if not signed in.
    async session() { var r = await sb.auth.getSession(); return r.data?.session || null; }
  };

  // Load user profile via edge function (bypasses RLS)
  async function _loadUserProfile() {
    if (!_user) return;
    try {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=get_profile', {
        method: 'POST',
        body: JSON.stringify({ userId: _user.id, email: _user.email || '' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Profile load failed');
      _userProfile = data.profile;
      _orgId = _userProfile.org_id;
    } catch(e) {
      console.warn('[Cloud] Profile load failed, using auth data:', e);
      // Fallback: use basic auth data so user isn't blocked
      _userProfile = { id: _user.id, email: _user.email, name: (_user.email || '').split('@')[0], role: 'estimator', org_id: '00000000-0000-0000-0000-000000000001' };
      _orgId = _userProfile.org_id;
    }
  }

  // Listen for auth state changes
  sb.auth.onAuthStateChange(async function(event, session) {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
      _user = session.user;
      await _loadUserProfile();
      emit('auth:login', _userProfile);
      _flushQueue();
    } else if (event === 'SIGNED_OUT') {
      _user = null;
      _userProfile = null;
      _orgId = null;
      emit('auth:logout');
    }
  });

  // ════════════════════════════════════════════════════════════
  // JOB CRUD
  // ════════════════════════════════════════════════════════════

  var cloud = {
    // Create a new job
    async createJob(type, clientDetails) {
      if (!_online) {
        // Create locally, queue for sync
        var localId = 'local-' + Date.now();
        var job = Object.assign({ id: localId, type: type, status: 'draft' }, clientDetails);
        _enqueue({ type: 'create_job', data: job });
        return job;
      }

      var data = {
        org_id: _orgId,
        created_by: _user.id,
        type: type || 'patio',
        status: 'draft',
        client_name: clientDetails?.client_name || '',
        client_phone: clientDetails?.client_phone || '',
        client_email: clientDetails?.client_email || '',
        site_address: clientDetails?.site_address || '',
        site_suburb: clientDetails?.site_suburb || ''
      };

      var result = await sb.from('jobs').insert(data).select().single();
      if (result.error) throw result.error;

      // Log event
      _logEvent(result.data.id, 'job_created');

      emit('job:created', result.data);
      return result.data;
    },

    // Save scope_json to a job
    async saveJob(jobId, scopeJson, meta) {
      if (!_online) {
        // Save locally, queue for sync
        try {
          localStorage.setItem('sw_job_' + jobId, JSON.stringify(scopeJson));
        } catch(e) {}
        _enqueue({ type: 'save_job', jobId: jobId, scopeJson: scopeJson, meta: meta });
        emit('job:saved_local', { jobId: jobId });
        return { id: jobId, local: true };
      }

      var update = { scope_json: scopeJson };
      if (meta) {
        if (meta.client_name) update.client_name = meta.client_name;
        if (meta.client_phone) update.client_phone = meta.client_phone;
        if (meta.client_email) update.client_email = meta.client_email;
        if (meta.site_address) update.site_address = meta.site_address;
        if (meta.site_suburb) update.site_suburb = meta.site_suburb;
        if (meta.pricing_json) update.pricing_json = meta.pricing_json;
        if (meta.notes) update.notes = meta.notes;
      }

      var result = await sb.from('jobs').update(update).eq('id', jobId).select().single();
      if (result.error) throw result.error;

      _logEvent(jobId, 'scope_saved');
      emit('job:saved', result.data);
      return result.data;
    },

    // Load a job
    async loadJob(jobId) {
      // Try cloud first
      if (_online) {
        var result = await sb.from('jobs').select('*').eq('id', jobId).single();
        if (result.error) throw result.error;
        return result.data;
      }
      // Fallback to local
      var local = localStorage.getItem('sw_job_' + jobId);
      if (local) return { id: jobId, scope_json: JSON.parse(local), local: true };
      throw new Error('Job not found (offline)');
    },

    // List jobs with optional filters
    async listJobs(filters) {
      filters = filters || {};
      var query = sb.from('jobs')
        .select('id, type, status, client_name, client_phone, site_suburb, created_at, updated_at, pricing_json')
        .order('updated_at', { ascending: false });

      if (filters.status) query = query.eq('status', filters.status);
      if (filters.type) query = query.eq('type', filters.type);
      if (filters.search) {
        query = query.or(
          'client_name.ilike.%' + filters.search + '%,' +
          'site_suburb.ilike.%' + filters.search + '%,' +
          'client_phone.ilike.%' + filters.search + '%'
        );
      }
      if (filters.limit) query = query.limit(filters.limit);

      var result = await query;
      if (result.error) throw result.error;
      return result.data;
    },

    // Update job status
    async updateJobStatus(jobId, newStatus) {
      if (!_online) {
        _enqueue({ type: 'update_status', jobId: jobId, status: newStatus });
        return;
      }

      var update = { status: newStatus };
      // Set timestamps for key transitions
      if (newStatus === 'quoted') update.quoted_at = new Date().toISOString();
      if (newStatus === 'accepted') update.accepted_at = new Date().toISOString();
      if (newStatus === 'scheduled') update.scheduled_at = new Date().toISOString();
      if (newStatus === 'complete') update.completed_at = new Date().toISOString();

      var result = await sb.from('jobs').update(update).eq('id', jobId).select().single();
      if (result.error) throw result.error;

      _logEvent(jobId, 'status_changed', { from: null, to: newStatus });
      emit('job:status_changed', { jobId: jobId, status: newStatus });
      return result.data;
    },

    // Delete a job (admin only)
    async deleteJob(jobId) {
      var result = await sb.from('jobs').delete().eq('id', jobId);
      if (result.error) throw result.error;
      emit('job:deleted', { jobId: jobId });
    },

    // ── Pipeline Stats ──
    async getPipelineStats() {
      var result = await sb.from('pipeline_summary').select('*');
      if (result.error) throw result.error;
      return result.data;
    },

    // ── Schedule ──
    async getUpcomingSchedule() {
      var result = await sb.from('upcoming_schedule').select('*');
      if (result.error) throw result.error;
      return result.data;
    }
  };

  // ════════════════════════════════════════════════════════════
  // GHL PROXY  (calls ghl-proxy edge function)
  // ════════════════════════════════════════════════════════════

  var ghl = {
    // Get opportunities from a pipeline
    async getOpportunities(pipeline) {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=opportunities&pipeline=' + encodeURIComponent(pipeline));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load opportunities');
      return data.opportunities || [];
    },

    // Search opportunities by contact name
    async search(query) {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=search&q=' + encodeURIComponent(query));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      return data.opportunities || [];
    },

    // Get full contact details from GHL. opts.signal lets the caller bound how
    // long the request can hang.
    async getContact(contactId, opts) {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=contact&contactId=' + encodeURIComponent(contactId), _signalOpts(opts));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get contact');
      return data.contact;
    },

    // Update GHL contact with details from the tool
    async updateContact(contactId, details) {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=update_contact', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ contactId: contactId }, details))
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update contact');
      return data;
    },

    // Link a scope to a GHL opportunity (adds note to contact + tags opportunity)
    async linkScope(opportunityId, jobId, toolType, contactId) {
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=link', {
        method: 'POST',
        body: JSON.stringify({ opportunityId: opportunityId, jobId: jobId, toolType: toolType, contactId: contactId || '' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to link scope');
      return data;
    },

    // Find existing Supabase job for a GHL opportunity (via edge function to bypass RLS)
    async findJobByOpportunity(opportunityId, type) {
      console.log('[Cloud] findJobByOpportunity:', opportunityId, 'type:', type || 'any');
      var url = SUPABASE_URL + '/functions/v1/ghl-proxy?action=find_job&opportunityId=' + encodeURIComponent(opportunityId);
      if (type) url += '&type=' + encodeURIComponent(type);
      var res = await authorizedFetch(url);
      var data = await res.json();
      console.log('[Cloud] findJobByOpportunity result:', data);
      if (!res.ok) throw new Error(data.error || 'Failed to find job');
      return data.job || null;
    },

    // Search GHL leads with pipeline filter + Supabase cross-reference.
    // Uses the fast lead_search action (contacts-first + parallel opp lookup);
    // opts.signal lets the caller abort/timeout a stale in-flight request.
    // If lead_search is not deployed yet this falls back to the legacy search
    // action, so a Pages build can never outrun the edge function. The fallback
    // only goes sticky once the backend has confirmed the action is missing;
    // an ambiguous failure falls back for that call alone and re-probes next time.
    async searchLeads(query, pipeline, opts) {
      opts = opts || {};
      var qs = '';
      if (pipeline) qs += '&pipeline=' + encodeURIComponent(pipeline);
      if (query) qs += '&q=' + encodeURIComponent(query);
      var fetchOpts = opts.signal ? { signal: opts.signal } : undefined;
      var base = SUPABASE_URL + '/functions/v1/ghl-proxy?action=';

      var res, data, fallBack = false;
      if (!_leadSearchUnavailable) {
        // The streak only means anything within one query; a different search is
        // a different question and starts its own count.
        if (query !== _leadSearchMissQuery) {
          _leadSearchMissQuery = query;
          _leadSearchMisses = 0;
        }
        res = await authorizedFetch(base + 'lead_search' + qs, fetchOpts);
        data = await _safeJson(res);
        if (res.ok) {
          _leadSearchMisses = 0;
        } else {
          var signal = _unknownActionSignal(res, data);
          fallBack = !!signal;
          // Anything that is not an ambiguous miss breaks the streak — the
          // limit only latches on misses that were genuinely CONSECUTIVE.
          if (signal === 'maybe') _leadSearchMisses++; else _leadSearchMisses = 0;
          if (signal === 'confirmed' || _leadSearchMisses >= _LEAD_SEARCH_MISS_LIMIT) {
            _leadSearchUnavailable = true;
            console.warn('[Cloud] lead_search unavailable on the backend — falling back to the legacy search action for the rest of this session.');
          } else if (signal) {
            console.warn('[Cloud] lead_search failed (HTTP ' + res.status + ') — retrying this search on the legacy action.');
          }
        }
      }
      if ((_leadSearchUnavailable || fallBack) && (!res || !res.ok)) {
        res = await authorizedFetch(base + 'search' + qs, fetchOpts);
        data = await _safeJson(res);
      }
      if (!res.ok) throw new Error((data && data.error) || ('Search failed (HTTP ' + res.status + ')'));
      // Contact-only is DERIVED here, at the data boundary, so the card render,
      // the tap handler and integration.js can never disagree about what a row
      // does. The backend flag is advisory only.
      return ((data && data.opportunities) || []).map(function(lead) {
        lead.isContactOnly = (lead.id == null) && !lead.lookupFailed;
        return lead;
      });
    },

    // Search Supabase jobs (via edge function, bypasses RLS)
    async searchJobs(query, type, limit, hasScope) {
      var url = SUPABASE_URL + '/functions/v1/ghl-proxy?action=search_jobs';
      if (query) url += '&q=' + encodeURIComponent(query);
      if (type) url += '&type=' + encodeURIComponent(type);
      if (limit) url += '&limit=' + limit;
      if (hasScope) url += '&has_scope=true';
      var res = await authorizedFetch(url);
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      return data.jobs || [];
    },

    // Load a job by ID (via edge function, bypasses RLS)
    async loadJob(jobId, opts) {
      console.log('[Cloud] loadJob:', jobId);
      var url = SUPABASE_URL + '/functions/v1/ghl-proxy?action=load_job&jobId=' + encodeURIComponent(jobId);
      var signal = (opts && opts.signal) || null;
      // Retry once on 503 (Supabase cold start / transient timeout). An aborted
      // caller skips the sleep and the retry: a bounded call must not outlive
      // its budget by 1.5s plus a second round trip.
      var res = await authorizedFetch(url, _signalOpts(opts));
      if (res.status === 503 && !(signal && signal.aborted)) {
        console.warn('[Cloud] loadJob got 503, retrying...');
        await new Promise(function(r) { setTimeout(r, 1500); });
        if (signal && signal.aborted) throw _abortError();
        res = await authorizedFetch(url, _signalOpts(opts));
      }
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load job');
      var job = data.job;
      if (job) {
        job.latest_frozen_scope_revision_id = data.latest_frozen_scope_revision_id || null;
        job.frozen_revision_count = data.frozen_revision_count || 0;
        job.current_scope_hash = data.current_scope_hash || job.current_scope_hash || null;
        job.current_scope_updated_at = data.current_scope_updated_at || job.updated_at || null;
      }
      return job;
    },

    // List photos/videos for a job (via edge function)
    async listMedia(jobId) {
      console.log('[Cloud] listMedia:', jobId);
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=list_media&jobId=' + encodeURIComponent(jobId));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to list media');
      return data.media || [];
    },

    // Upload a photo to Supabase Storage (via edge function)
    async uploadPhoto(jobId, dataUrl, label, caption) {
      console.log('[Cloud] uploadPhoto:', jobId, label);
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=upload_photo', {
        method: 'POST',
        body: JSON.stringify({ jobId: jobId, dataUrl: dataUrl, label: label || '', caption: caption || '' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload photo');
      return data;
    },

    // Save scope data to a job (via edge function to bypass RLS)
    async saveScope(jobId, scopeJson, meta) {
      console.log('[Cloud] saveScope:', jobId);
      meta = meta || {};
      if (!_online) {
        return _queueScopeSave(jobId, scopeJson, meta);
      }

      var requestMeta = Object.assign({}, meta);
      delete requestMeta._flushAttempt;
      delete requestMeta._autoSaveAttempt;
      var clientRequestId = requestMeta.requestId || _newOpId('scope-save');
      requestMeta.requestId = clientRequestId;
      var res;
      try {
        res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=save_scope', {
          method: 'POST',
          body: JSON.stringify({ jobId: jobId, scopeJson: scopeJson, meta: requestMeta })
        });
      } catch(e) {
        if (meta._flushAttempt) {
          e.httpStatus = e.httpStatus || 0;
          e.reason = e.reason || 'transport_error';
          e.code = e.code || e.reason;
          e.jobId = e.jobId || jobId;
          e.targetJobId = e.targetJobId || jobId;
          e.requestId = e.requestId || clientRequestId;
          throw e;
        }
        console.warn('[Cloud] saveScope network failure; queued local scope save:', e);
        var queuedNetworkSave = _queueScopeSave(jobId, scopeJson, requestMeta);
        if (meta._autoSaveAttempt) {
          e.httpStatus = e.httpStatus || 0;
          e.reason = e.reason || 'transport_error';
          e.code = e.code || e.reason;
          e.jobId = e.jobId || jobId;
          e.targetJobId = e.targetJobId || jobId;
          e.requestId = e.requestId || clientRequestId;
          e.localQueued = true;
          throw e;
        }
        return queuedNetworkSave;
      }
      var data = await _safeJson(res) || {};
      console.log('[Cloud] saveScope result:', data);
      if (!res.ok) {
        var reason = data.reason || data.code || (res.status === 401 ? 'auth_error' : (res.status >= 500 ? 'transport_error' : 'save_rejected'));
        var err = new Error(data.error || data.message || 'Failed to save scope');
        err.name = 'ScopeSaveError';
        err.httpStatus = res.status;
        err.status = res.status;
        err.reason = reason;
        err.code = reason;
        err.current_scope_hash = data.current_scope_hash || data.currentScopeHash || null;
        err.currentScopeHash = err.current_scope_hash;
        err.jobId = jobId;
        err.targetJobId = jobId;
        err.serverJobId = data.job_id || data.jobId || null;
        err.requestId = data.request_id || data.requestId || (res.headers && res.headers.get && (res.headers.get('x-request-id') || res.headers.get('x-supabase-request-id'))) || clientRequestId;
        err.details = data;
        // Scope bytes are deliberately not trusted from an error body. Recovery
        // reuses the guarded load path and verifies the returned job identity.
        err.loadServerScope = function(opts) { return ghl.loadJob(jobId, opts); };
        var authRetryable = res.status === 401 ||
          ['missing_auth', 'invalid_user_jwt', 'user_jwt_required', 'auth_error'].indexOf(err.code) !== -1;
        if (authRetryable && !meta._flushAttempt) {
          console.warn('[Cloud] saveScope login expired; queued local scope save:', err);
          return _queueScopeSave(jobId, scopeJson, requestMeta);
        }
        var transportRetryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (transportRetryable && !meta._flushAttempt) {
          var queuedTransportSave = _queueScopeSave(jobId, scopeJson, requestMeta, 'server_error');
          if (!meta._autoSaveAttempt) return queuedTransportSave;
          err.localQueued = true;
        }
        throw err;
      }
      return data.job;
    },

    // Auto-create GHL contact + opportunity for walk-up clients (dedup by email/phone)
    async createContactAndOpportunity(contact, toolType, opts) {
      console.log('[Cloud] createContactAndOpportunity:', toolType);
      var firstName = contact.firstName || '';
      var lastName = contact.lastName || '';
      if (!firstName && contact.name) {
        var parts = contact.name.trim().split(/\s+/);
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
      }
      var body = {
        firstName: firstName,
        lastName: lastName,
        email: contact.email || '',
        phone: contact.phone || '',
        address: contact.address || '',
        suburb: contact.suburb || '',
        toolType: toolType
      };
      // Repeat-client path: caller already knows the contact — skip dedup/creation
      // on the backend and just spin up a NEW opportunity for this contact.
      if (contact.contactId) body.contactId = contact.contactId;
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=create_contact_and_opportunity', _signalOpts(opts, {
        method: 'POST',
        body: JSON.stringify(body)
      }));
      var data = await res.json();
      console.log('[Cloud] createContactAndOpportunity result:', data);
      if (!res.ok) throw new Error(data.error || 'Failed to create contact/opportunity');
      return data;
    },

    // Create a Supabase job linked to a GHL opportunity (via edge function to bypass RLS)
    async createJobForOpportunity(opportunityId, toolType, contact, opts) {
      console.log('[Cloud] createJobForOpportunity:', opportunityId, toolType);
      var payload = {
        toolType: toolType,
        clientName: contact.name || '',
        clientPhone: contact.phone || '',
        clientEmail: contact.email || '',
        siteAddress: contact.address || '',
        siteSuburb: contact.suburb || ''
      };
      if (opportunityId) payload.opportunityId = opportunityId;
      if (contact.contactId) payload.contactId = contact.contactId;
      var res = await authorizedFetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=create_job', _signalOpts(opts, {
        method: 'POST',
        body: JSON.stringify(payload)
      }));
      var data = await res.json();
      console.log('[Cloud] createJobForOpportunity result:', data);
      if (!res.ok) throw new Error(data.error || 'Failed to create job');
      return data.job;
    }
  };

  // ════════════════════════════════════════════════════════════
  // DOCUMENTS
  // ════════════════════════════════════════════════════════════

  var docs = {
    // Upload a generated PDF
    async uploadPDF(jobId, pdfBlob, docType, dataSnapshot) {
      var version = 1;

      // Get latest version for this doc type
      var existing = await sb.from('job_documents')
        .select('version')
        .eq('job_id', jobId)
        .eq('type', docType)
        .order('version', { ascending: false })
        .limit(1);

      if (existing.data && existing.data.length > 0) {
        version = existing.data[0].version + 1;
      }

      // Upload to storage
      var path = _orgId + '/' + jobId + '/' + docType + '_v' + version + '.pdf';
      var uploadResult = await sb.storage.from('job-pdfs').upload(path, pdfBlob, {
        contentType: 'application/pdf',
        upsert: false
      });
      if (uploadResult.error) throw uploadResult.error;

      // Get public URL
      var urlResult = sb.storage.from('job-pdfs').getPublicUrl(path);
      var pdfUrl = urlResult.data.publicUrl;

      // Insert document record
      var record = {
        job_id: jobId,
        type: docType,
        version: version,
        pdf_url: pdfUrl,
        data_snapshot_json: dataSnapshot || null,
        created_by: _user?.id
      };

      var result = await sb.from('job_documents').insert(record).select().single();
      if (result.error) throw result.error;

      _logEvent(jobId, docType + '_generated', { version: version });
      return result.data;
    },

    // List documents for a job
    async listDocuments(jobId) {
      var result = await sb.from('job_documents')
        .select('*')
        .eq('job_id', jobId)
        .order('type')
        .order('version', { ascending: false });
      if (result.error) throw result.error;
      return result.data;
    },

    // Get document by share token (public — for client-facing pages)
    async getByShareToken(token) {
      var result = await sb.from('job_documents')
        .select('*, jobs(client_name, site_suburb, type)')
        .eq('share_token', token)
        .eq('sent_to_client', true)
        .single();
      if (result.error) throw result.error;

      // Mark as viewed
      if (!result.data.viewed_at) {
        await sb.from('job_documents')
          .update({ viewed_at: new Date().toISOString() })
          .eq('id', result.data.id);
      }

      return result.data;
    },

    // Mark document as sent to client
    async markSent(docId) {
      var result = await sb.from('job_documents')
        .update({ sent_to_client: true, sent_at: new Date().toISOString() })
        .eq('id', docId)
        .select()
        .single();
      if (result.error) throw result.error;
      return result.data;
    },

    // Client accepts quote
    async acceptQuote(docId) {
      var result = await sb.from('job_documents')
        .update({ accepted_at: new Date().toISOString() })
        .eq('id', docId)
        .select()
        .single();
      if (result.error) throw result.error;

      // Also update job status
      if (result.data.job_id) {
        await cloud.updateJobStatus(result.data.job_id, 'accepted');
      }

      return result.data;
    },

    // Client declines quote
    async declineQuote(docId) {
      var result = await sb.from('job_documents')
        .update({ declined_at: new Date().toISOString() })
        .eq('id', docId)
        .select()
        .single();
      if (result.error) throw result.error;
      return result.data;
    }
  };

  // ════════════════════════════════════════════════════════════
  // MEDIA UPLOAD
  // ════════════════════════════════════════════════════════════

  var media = {
    // Upload a photo to Supabase Storage
    async uploadPhoto(jobId, file, meta) {
      meta = meta || {};
      var uuid = crypto.randomUUID();
      var ext = file.name?.split('.').pop() || 'jpg';
      var path = _orgId + '/' + jobId + '/photos/' + uuid + '.' + ext;

      // Upload original
      var uploadResult = await sb.storage.from('job-photos').upload(path, file, {
        contentType: file.type || 'image/jpeg'
      });
      if (uploadResult.error) throw uploadResult.error;

      var urlResult = sb.storage.from('job-photos').getPublicUrl(path);
      var storageUrl = urlResult.data.publicUrl;

      // Generate and upload thumbnail
      var thumbnailUrl = null;
      try {
        var thumbBlob = await _generateThumbnail(file, 200);
        var thumbPath = _orgId + '/' + jobId + '/photos/thumb_' + uuid + '.' + ext;
        var thumbUpload = await sb.storage.from('job-photos').upload(thumbPath, thumbBlob, {
          contentType: 'image/jpeg'
        });
        if (!thumbUpload.error) {
          thumbnailUrl = sb.storage.from('job-photos').getPublicUrl(thumbPath).data.publicUrl;
        }
      } catch(e) {
        console.warn('[Cloud] Thumbnail generation failed:', e);
      }

      // Insert media record
      var record = {
        job_id: jobId,
        phase: meta.phase || 'scope',
        type: 'photo',
        storage_url: storageUrl,
        thumbnail_url: thumbnailUrl,
        label: meta.label || '',
        notes: meta.notes || '',
        lat: meta.lat || null,
        lng: meta.lng || null,
        taken_at: meta.taken_at || new Date().toISOString(),
        uploaded_by: _user?.id
      };

      var result = await sb.from('job_media').insert(record).select().single();
      if (result.error) throw result.error;

      _logEvent(jobId, 'photo_added', { media_id: result.data.id });
      return result.data;
    },

    // Upload a video
    async uploadVideo(jobId, file, meta) {
      meta = meta || {};
      var uuid = crypto.randomUUID();
      var ext = file.name?.split('.').pop() || 'mp4';
      var path = _orgId + '/' + jobId + '/videos/' + uuid + '.' + ext;

      var uploadResult = await sb.storage.from('job-videos').upload(path, file, {
        contentType: file.type || 'video/mp4'
      });
      if (uploadResult.error) throw uploadResult.error;

      var urlResult = sb.storage.from('job-videos').getPublicUrl(path);

      var record = {
        job_id: jobId,
        phase: meta.phase || 'scope',
        type: 'video',
        storage_url: urlResult.data.publicUrl,
        label: meta.label || '',
        uploaded_by: _user?.id
      };

      var result = await sb.from('job_media').insert(record).select().single();
      if (result.error) throw result.error;

      _logEvent(jobId, 'video_added', { media_id: result.data.id });
      return result.data;
    },

    // List media for a job
    async listMedia(jobId, phase) {
      var query = sb.from('job_media')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at');
      if (phase) query = query.eq('phase', phase);

      var result = await query;
      if (result.error) throw result.error;
      return result.data;
    },

    // Delete a media item
    async deleteMedia(mediaId) {
      // Get the record first to find storage path
      var item = await sb.from('job_media').select('*').eq('id', mediaId).single();
      if (item.error) throw item.error;

      // Delete from storage
      var bucket = item.data.type === 'video' ? 'job-videos' : 'job-photos';
      var storagePath = new URL(item.data.storage_url).pathname.split('/').slice(-4).join('/');
      await sb.storage.from(bucket).remove([storagePath]);

      // Delete thumbnail if exists
      if (item.data.thumbnail_url) {
        var thumbPath = new URL(item.data.thumbnail_url).pathname.split('/').slice(-4).join('/');
        await sb.storage.from('job-photos').remove([thumbPath]);
      }

      // Delete record
      var result = await sb.from('job_media').delete().eq('id', mediaId);
      if (result.error) throw result.error;
    }
  };

  // ── Thumbnail Generator ──
  function _generateThumbnail(file, maxWidth) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
          var scale = maxWidth / img.width;
          var canvas = document.createElement('canvas');
          canvas.width = maxWidth;
          canvas.height = img.height * scale;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function(blob) {
            resolve(blob);
          }, 'image/jpeg', 0.7);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ════════════════════════════════════════════════════════════
  // EVENT LOGGING
  // ════════════════════════════════════════════════════════════

  async function _logEvent(jobId, eventType, detail) {
    try {
      await sb.from('job_events').insert({
        job_id: jobId,
        user_id: _user?.id,
        event_type: eventType,
        detail_json: detail || {}
      });
    } catch(e) {
      console.warn('[Cloud] Failed to log event:', e);
    }
  }

  // ════════════════════════════════════════════════════════════
  // AUTO-SAVE
  // ════════════════════════════════════════════════════════════

  function _autoSaveFingerprint(jobId, state) {
    try {
      // getFencingState stamps savedAt on every read. It is transport metadata,
      // not an edit, so it must not manufacture a fresh retry budget.
      return String(jobId) + ':' + JSON.stringify(state, function(key, value) {
        return key === 'savedAt' ? undefined : value;
      });
    } catch(e) { return String(jobId) + ':unserializable'; }
  }

  function _isTypedScopeConflict(e) {
    var reason = e && (e.reason || e.code);
    return ['scope_hash_conflict', 'missing_scope_cursor', 'scope_ref_mismatch'].indexOf(reason) !== -1;
  }

  function _isTransportSaveFailure(e) {
    var status = Number(e && (e.httpStatus || e.status) || 0);
    var reason = e && (e.reason || e.code);
    return reason === 'transport_error' || status === 0 || status === 408 || status === 429 || status >= 500;
  }

  function _scheduleAutoSave(delayMs) {
    if (!_autoSaveContext) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(_runAutoSave, delayMs);
  }

  async function _runAutoSave() {
    var ctx = _autoSaveContext;
    if (!ctx || ctx.running) return;
    ctx.running = true;
    var state = null;
    var fingerprint = null;
    try {
      state = ctx.getStateFn();
      if (!state) return;
      fingerprint = _autoSaveFingerprint(ctx.jobId, state);
      if (fingerprint !== ctx.fingerprint) {
        ctx.fingerprint = fingerprint;
        if (ctx.blockedReason === 'transport_exhausted' || !ctx.blockedReason) {
          ctx.transportAttempts = 0;
          ctx.blockedFingerprint = null;
          ctx.blockedReason = null;
        } else {
          // Conflict/ref decisions remain stopped across edits until their
          // explicit recovery path resolves. An edit must not become a bypass.
          ctx.blockedFingerprint = fingerprint;
        }
      }
      if (ctx.blockedFingerprint === fingerprint) return;

      // Build meta so auto-save keeps jobs table fields current
      var meta = {};
      if (state.customer || state.client) {
        var c = state.customer || {};
        var cl = state.client || {};
        meta.client_name = c.name || cl.name || '';
        meta.client_phone = c.phone || cl.phone || '';
        meta.client_email = c.email || cl.email || '';
        meta.site_address = c.address || cl.address || '';
        meta.site_suburb = cl.suburb || '';
      } else if (state.job) {
        meta.client_name = ((state.job.clientFirstName || '') + ' ' + (state.job.clientLastName || '')).trim() || state.job.client || '';
        meta.client_phone = state.job.phone || '';
        meta.client_email = state.job.email || '';
        meta.site_address = state.job.address || '';
        meta.site_suburb = state.job.suburb || '';
      }

      var hasMeaningfulContact = !!(
        (meta.client_name && meta.client_name.trim()) ||
        (meta.client_phone && meta.client_phone.trim()) ||
        (meta.client_email && meta.client_email.trim()) ||
        (meta.site_address && meta.site_address.trim()) ||
        (meta.site_suburb && meta.site_suburb.trim())
      );
      if (!hasMeaningfulContact) return;

      if (state.job && state.job._pricing_json) meta.pricing_json = state.job._pricing_json;
      else if (state._pricing_json) meta.pricing_json = state._pricing_json;

      meta._autoSaveAttempt = true;
      if (window._swIntegration && window._swIntegration.getScopeSaveCursor) {
        var cursor = window._swIntegration.getScopeSaveCursor();
        if (cursor && cursor.baseScopeHash) meta.baseScopeHash = cursor.baseScopeHash;
        if (cursor && cursor.scopeCursorJobId) meta.scopeCursorJobId = cursor.scopeCursorJobId;
        if (cursor && cursor.scopeCursorProvenance) meta.scopeCursorProvenance = cursor.scopeCursorProvenance;
        if (cursor && cursor.scopeCursorReconcileV1 === true) meta.scopeCursorReconcileV1 = true;
      }
      var savedJob = await ghl.saveScope(ctx.jobId, state, meta);
      // Scoped to this job and payload, so it is safe (and required) even after
      // a swap: the server accepted it, and a replay would 409 on a spent cursor.
      if (!(savedJob && savedJob.queued)) _discardQueuedScopePayload(ctx.jobId, state);
      // A job swap mid-flight retires this context. Its cursor and status belong
      // to the job we left, so nothing below may touch the new job's state.
      if (ctx !== _autoSaveContext) return;
      ctx.transportAttempts = 0;
      ctx.blockedReason = null;
      if (savedJob && savedJob.queued) {
        emit('autosave:queued', { jobId: ctx.jobId, fingerprint: fingerprint, queuedReason: savedJob.queuedReason || 'offline' });
      } else {
        if (window._swIntegration && window._swIntegration._rememberScopeCursor) window._swIntegration._rememberScopeCursor(savedJob);
        emit('autosave:success', { jobId: ctx.jobId, fingerprint: fingerprint });
      }
    } catch(e) {
      console.warn('[Cloud] Auto-save failed:', e);
      if (ctx !== _autoSaveContext) return;
      var conflict = _isTypedScopeConflict(e);
      var transport = !conflict && _isTransportSaveFailure(e);
      if (conflict || !transport) {
        ctx.blockedFingerprint = fingerprint;
        ctx.blockedReason = conflict ? (e.reason || e.code || 'scope_conflict') : 'save_rejected';
      }
      if (transport) {
        ctx.transportAttempts += 1;
        if (ctx.transportAttempts >= 5) {
          ctx.blockedFingerprint = fingerprint;
          ctx.blockedReason = 'transport_exhausted';
        }
      }
      emit('autosave:error', {
        jobId: ctx.jobId,
        error: e,
        attemptedScope: state,
        fingerprint: fingerprint,
        transportAttempt: ctx.transportAttempts,
        retryStopped: ctx.blockedFingerprint === fingerprint
      });
    } finally {
      if (!ctx || ctx !== _autoSaveContext) return;
      ctx.running = false;
      if (ctx.blockedFingerprint && ctx.blockedFingerprint === ctx.fingerprint) {
        // A stopped payload is polled locally for edits only. No request is made
        // while the fingerprint stays blocked, so the loop must not die: killing
        // the timer would strand the transport budget reset and leave the session
        // with no autosave at all until a full re-arm.
        _scheduleAutoSave(ctx.intervalMs);
        return;
      }
      var retryDelays = [30000, 120000, 300000, 300000, 300000];
      var delay = ctx.transportAttempts ? retryDelays[Math.min(ctx.transportAttempts - 1, retryDelays.length - 1)] : ctx.intervalMs;
      _scheduleAutoSave(delay);
    }
  }

  function startAutoSave(jobId, getStateFn, intervalMs) {
    stopAutoSave();
    _autoSaveContext = {
      jobId: jobId,
      getStateFn: getStateFn,
      intervalMs: intervalMs || 30000,
      fingerprint: null,
      blockedFingerprint: null,
      blockedReason: null,
      transportAttempts: 0,
      running: false
    };
    _scheduleAutoSave(_autoSaveContext.intervalMs);
  }

  function resumeAutoSave(opts) {
    if (!_autoSaveContext) return;
    opts = opts || {};
    _autoSaveContext.blockedFingerprint = null;
    _autoSaveContext.blockedReason = null;
    if (opts.resetBudget !== false) _autoSaveContext.transportAttempts = 0;
    _scheduleAutoSave(opts.immediate ? 0 : _autoSaveContext.intervalMs);
  }

  function stopAutoSave() {
    if (_autoSaveTimer) {
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = null;
    }
    _autoSaveContext = null;
  }

  // ════════════════════════════════════════════════════════════
  // UI HELPERS  (login modal, save indicator, job picker)
  // ════════════════════════════════════════════════════════════

  var ui = {
    // Inject a minimal login modal into the page
    showLoginModal: function(onSuccess) {
      var hex = (window.SW_BRAND?.HEX) || { orange: '#F15A29', dark: '#293C46', mid: '#4C6A7C' };
      var overlay = document.createElement('div');
      overlay.id = 'sw-login-overlay';
      overlay.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;">' +
          '<div style="background:#fff;border-radius:12px;padding:32px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);position:relative;">' +
            '<h2 style="margin:0 0 8px;color:' + hex.dark + ';font-size:18px;">Sign In</h2>' +
            '<p style="margin:0 0 20px;color:' + hex.mid + ';font-size:13px;">Enter your email and password</p>' +
            '<input type="email" id="sw-login-email" placeholder="your@email.com" style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:10px;">' +
            '<input type="password" id="sw-login-password" placeholder="Password" style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:12px;">' +
            '<button id="sw-login-btn" style="width:100%;padding:10px;background:' + hex.orange + ';color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Log In</button>' +
            '<p id="sw-login-status" style="margin:12px 0 0;font-size:12px;color:' + hex.mid + ';text-align:center;"></p>' +
            '<button id="sw-login-close" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      document.getElementById('sw-login-close').onclick = function() {
        overlay.remove();
      };

      // Enter key on password field
      document.getElementById('sw-login-password').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('sw-login-btn').click();
      });

      document.getElementById('sw-login-btn').onclick = async function() {
        var email = document.getElementById('sw-login-email').value.trim();
        var password = document.getElementById('sw-login-password').value;
        var status = document.getElementById('sw-login-status');
        if (!email || !password) { status.textContent = 'Please enter email and password'; return; }

        try {
          document.getElementById('sw-login-btn').disabled = true;
          document.getElementById('sw-login-btn').textContent = 'Logging in...';
          await auth.signIn(email, password);
          overlay.remove();
          if (onSuccess) onSuccess(_userProfile);
        } catch(e) {
          status.style.color = '#FF3B30';
          status.textContent = e.message || 'Wrong email or password';
          document.getElementById('sw-login-btn').disabled = false;
          document.getElementById('sw-login-btn').textContent = 'Log In';
        }
      };

      // If already logged in via redirect, close modal
      if (auth.isLoggedIn()) {
        overlay.remove();
        if (onSuccess) onSuccess(_userProfile);
      }
    },

    // Show job picker modal
    showJobPicker: function(toolType, onSelect) {
      var hex = (window.SW_BRAND?.HEX) || { orange: '#F15A29', dark: '#293C46', mid: '#4C6A7C' };
      var overlay = document.createElement('div');
      overlay.id = 'sw-jobpicker-overlay';
      overlay.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;">' +
          '<div style="background:#fff;border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
              '<h2 style="margin:0;color:' + hex.dark + ';font-size:18px;">Load Job</h2>' +
              '<button onclick="this.closest(\'#sw-jobpicker-overlay\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>' +
            '</div>' +
            '<input type="text" id="sw-job-search" placeholder="Search by name, suburb, phone..." style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:12px;">' +
            '<div id="sw-job-list" style="overflow-y:auto;flex:1;min-height:200px;">' +
              '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">Loading jobs...</p>' +
            '</div>' +
            '<button id="sw-job-new" style="margin-top:12px;width:100%;padding:10px;background:' + hex.dark + ';color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">+ New Job</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      // Load jobs
      var _loadList = async function(search) {
        var list = document.getElementById('sw-job-list');
        try {
          var filters = {};
          if (toolType) filters.type = toolType;
          if (search) filters.search = search;
          filters.limit = 50;

          var jobs = await cloud.listJobs(filters);
          if (jobs.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">No jobs found</p>';
            return;
          }

          list.innerHTML = jobs.map(function(job) {
            var price = job.pricing_json?.totalIncGST;
            var priceStr = price ? '$' + Number(price).toLocaleString() : '';
            var statusColors = {
              draft: '#999', quoted: '#007AFF', accepted: '#34C759',
              scheduled: '#FF9500', in_progress: '#FF9500', complete: '#34C759', invoiced: '#8E8E93'
            };
            return '<div class="sw-job-item" data-id="' + job.id + '" style="padding:12px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background=\'#f8f8f8\'" onmouseout="this.style.background=\'#fff\'">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<strong style="color:' + hex.dark + ';">' + (job.client_name || 'Untitled') + '</strong>' +
                '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:' + (statusColors[job.status] || '#999') + '20;color:' + (statusColors[job.status] || '#999') + ';font-weight:600;">' + job.status + '</span>' +
              '</div>' +
              '<div style="font-size:12px;color:' + hex.mid + ';margin-top:4px;">' +
                (job.site_suburb || '') + (priceStr ? ' &middot; ' + priceStr : '') +
                ' &middot; ' + new Date(job.updated_at).toLocaleDateString() +
              '</div>' +
            '</div>';
          }).join('');

          // Click handlers
          list.querySelectorAll('.sw-job-item').forEach(function(el) {
            el.onclick = function() {
              overlay.remove();
              if (onSelect) onSelect(el.dataset.id);
            };
          });
        } catch(e) {
          list.innerHTML = '<p style="text-align:center;color:#FF3B30;padding:40px 0;">Error loading jobs: ' + e.message + '</p>';
        }
      };

      _loadList();

      // Search debounce
      var _searchTimer;
      document.getElementById('sw-job-search').oninput = function() {
        clearTimeout(_searchTimer);
        var val = this.value;
        _searchTimer = setTimeout(function() { _loadList(val); }, 300);
      };

      // New job button — local-only until explicit cloud save
      document.getElementById('sw-job-new').onclick = function() {
        var localId = 'local-' + Date.now();
        overlay.remove();
        if (onSelect) onSelect(localId);
      };
    },

    // Show GHL opportunity picker modal — simplified to "Load Previous Scope" (Supabase jobs with scope data only)
    showGHLPicker: function(toolType, onSelect) {
      var hex = (window.SW_BRAND?.HEX) || { orange: '#F15A29', dark: '#293C46', mid: '#4C6A7C' };
      var pipelineLabel = (toolType === 'fencing') ? 'Fencing' : 'Patio';
      var overlay = document.createElement('div');
      overlay.id = 'sw-ghlpicker-overlay';
      overlay.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;">' +
          '<div style="background:#fff;border-radius:12px;padding:24px;max-width:560px;width:92%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
              '<h2 style="margin:0;color:' + hex.dark + ';font-size:18px;">Load Previous Scope <span style="font-size:13px;font-weight:400;color:' + hex.mid + ';">(' + pipelineLabel + ')</span></h2>' +
              '<button id="sw-ghl-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
              '<input type="text" id="sw-ghl-search" placeholder="Search by name, job number, address, phone..." style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box;">' +
            '</div>' +
            '<div id="sw-ghl-list" style="overflow-y:auto;flex:1;min-height:200px;">' +
              '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">Loading jobs...</p>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);
      document.getElementById('sw-ghl-close').onclick = function() { overlay.remove(); };

      // Helper: build scope description from scope_json
      function _scopeDesc(job) {
        var scope = job.scope_json;
        if (!scope || typeof scope !== 'object') return '';
        // Patio
        if (scope.config) {
          var c = scope.config;
          var parts = [];
          if (c.length && c.projection) parts.push(c.length + 'm \u00d7 ' + c.projection + 'm');
          if (c.roofStyle) parts.push(c.roofStyle.charAt(0).toUpperCase() + c.roofStyle.slice(1));
          if (c.roofing) parts.push(c.roofing);
          return parts.join(' \u2014 ');
        }
        // Fencing
        if (scope.job && scope.job.runs) {
          var runs = scope.job.runs;
          var totalM = runs.reduce(function(s, r) { return s + (r.totalLength || r.lengthM || 0); }, 0);
          return totalM > 0 ? Math.round(totalM) + 'm \u2014 ' + runs.length + ' run(s)' : '';
        }
        return '';
      }

      // Helper: render a job card
      function _renderJobCard(job) {
        var hasScope = job.scope_json && Object.keys(job.scope_json).length > 0;
        var hasJobNum = !!job.job_number;
        var isPosted = hasJobNum && job.status !== 'draft';
        var price = job.pricing_json?.totalIncGST;
        var priceStr = price ? '$' + Number(price).toLocaleString() : '';
        var desc = _scopeDesc(job);
        var addrParts = [job.site_address, job.site_suburb].filter(Boolean);
        var addrLine = addrParts.join(', ');
        var statusColors = { draft: '#999', quoted: '#007AFF', accepted: '#34C759', scheduled: '#FF9500', in_progress: '#FF9500', complete: '#34C759', invoiced: '#8E8E93', cancelled: '#FF3B30' };
        var statusColor = statusColors[job.status] || '#999';
        var borderColor = isPosted ? '#34C759' : hasScope ? '#007AFF' : '#eee';
        var borderWidth = (isPosted || hasScope) ? '2px' : '1px';

        var html = '<div class="sw-job-card" data-jobid="' + job.id + '" style="padding:12px;border:' + borderWidth + ' solid ' + borderColor + ';border-radius:8px;margin-bottom:8px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background=\'#f8f8f8\'" onmouseout="this.style.background=\'#fff\'">';
        // Row 1: Name + status
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<strong style="color:' + hex.dark + ';">' + (job.client_name || 'Untitled') + '</strong>';
        html += '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:' + statusColor + '20;color:' + statusColor + ';font-weight:600;">' + (job.status || 'draft') + '</span>';
        html += '</div>';
        // Row 2: Job number (if posted) or draft label
        if (hasJobNum) {
          html += '<div style="margin-top:3px;"><strong style="font-size:14px;color:' + hex.dark + ';letter-spacing:0.5px;">' + job.job_number + '</strong></div>';
        } else if (hasScope) {
          html += '<div style="margin-top:3px;font-size:11px;color:#FF9500;font-weight:600;">DRAFT \u2014 not yet posted</div>';
        }
        // Row 3: Address
        if (addrLine) html += '<div style="font-size:11px;color:#999;margin-top:2px;">' + addrLine + '</div>';
        // Row 4: Scope description
        if (desc) html += '<div style="font-size:11px;color:' + hex.mid + ';margin-top:2px;">' + desc + '</div>';
        // Row 5: Badges
        var badges = [];
        if (hasScope) badges.push('<span style="background:#34C75920;color:#34C759;padding:1px 6px;border-radius:4px;font-size:10px;">Scope saved</span>');
        if (priceStr) badges.push('<span style="font-size:10px;color:' + hex.mid + ';">' + priceStr + ' inc GST</span>');
        if (job.updated_at) badges.push('<span style="font-size:10px;color:#aaa;">Updated ' + new Date(job.updated_at).toLocaleDateString('en-AU') + '</span>');
        if (badges.length) html += '<div style="margin-top:3px;">' + badges.join(' ') + '</div>';
        // Row 6: GHL stage (enriched async)
        html += '<div class="sw-ghl-stage" data-jobid="' + job.id + '" style="margin-top:3px;"></div>';
        // Action label
        html += '<div style="margin-top:4px;">';
        if (hasScope) html += '<span style="font-size:11px;padding:3px 10px;border-radius:6px;background:#22C55E18;color:#22C55E;font-weight:600;">Resume Scope \u2192</span>';
        else html += '<span style="font-size:11px;padding:3px 10px;border-radius:6px;background:' + hex.orange + '18;color:' + hex.orange + ';font-weight:600;">Start Scope</span>';
        html += '</div>';
        html += '</div>';
        return html;
      }

      // Main load function — Supabase jobs with scope data only
      var _loadJobs = async function(search) {
        var list = document.getElementById('sw-ghl-list');
        list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">Loading...</p>';

        try {
          var jobs = await ghl.searchJobs(search || '', toolType, 30, true);

          if (jobs.length === 0 && !search) {
            list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">No saved scopes yet. Use the search bar to find a lead and start scoping.</p>';
          } else if (jobs.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">No jobs matching "' + search + '"</p>';
          } else {
            list.innerHTML = jobs.map(function(job) { return _renderJobCard(job); }).join('');

            // Click handlers
            list.querySelectorAll('.sw-job-card').forEach(function(el) {
              el.onclick = function() {
                var jobId = el.dataset.jobid;
                var job = jobs.find(function(j) { return j.id === jobId; });
                if (!job) return;
                overlay.remove();
                var syntheticOpp = {
                  id: job.ghl_opportunity_id || null,
                  contactId: job.ghl_contact_id || null,
                  contactName: job.client_name || '',
                  contactEmail: job.client_email || '',
                  contactPhone: job.client_phone || '',
                  contactAddress: job.site_address || '',
                  contactCity: job.site_suburb || '',
                  _supabaseJobId: job.id,
                  _loadedFromSupabase: true
                };
                if (onSelect) onSelect(syntheticOpp);
              };
            });

            // Async GHL stage enrichment
            jobs.forEach(function(job) {
              if (!job.ghl_opportunity_id) return;
              ghl.search(job.client_name).then(function(opps) {
                var match = opps.find(function(o) { return o.id === job.ghl_opportunity_id; });
                if (!match) return;
                var stageEl = list.querySelector('.sw-ghl-stage[data-jobid="' + job.id + '"]');
                if (stageEl && match.stageName) {
                  stageEl.innerHTML = '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:' + hex.orange + '15;color:' + hex.orange + ';">GHL: ' + match.stageName + '</span>';
                }
              }).catch(function() {});
            });
          }
        } catch(e) {
          list.innerHTML = '<p style="text-align:center;color:#FF3B30;padding:40px 0;">Error: ' + e.message + '</p>';
        }
      };

      // Initial load
      _loadJobs('');

      // Search debounce
      var _searchTimer;
      document.getElementById('sw-ghl-search').oninput = function() {
        clearTimeout(_searchTimer);
        var val = this.value;
        _searchTimer = setTimeout(function() { _loadJobs(val); }, 300);
      };
    },

    // Lead search — self-contained centered modal (no header dependency)
    showLeadSearch: function(toolType, onSelect, initialQuery, opts) {
      opts = opts || {};
      var mode = (opts.mode === 'new_job') ? 'new_job' : 'load';
      var hex = (window.SW_BRAND?.HEX) || { orange: '#F15A29', dark: '#293C46', mid: '#4C6A7C' };
      var pipelineKey = (toolType === 'fencing') ? 'fencing' : 'patio';

      // Remove any existing modal
      var existing = document.getElementById('sw-lead-search-dropdown');
      if (existing) existing.remove();
      var existingBackdrop = document.getElementById('sw-lead-search-backdrop');
      if (existingBackdrop) existingBackdrop.remove();

      // Fail loud rather than silently: the modal renders straight into body,
      // so the only way it can't is if body is not ready.
      if (!document.body) { alert('Cannot open lead search — page not ready.'); return; }

      // Backdrop doubles as the centering container + click-away dismissal
      var backdrop = document.createElement('div');
      backdrop.id = 'sw-lead-search-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(41,60,70,0.45);display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px 16px;';
      backdrop.onclick = function() { _close(); };

      // Centered modal panel (id kept as sw-lead-search-dropdown so the
      // integration.js reopen guard stays consistent)
      var modal = document.createElement('div');
      modal.id = 'sw-lead-search-dropdown';
      modal.style.cssText = 'width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(41,60,70,0.35);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
      // Prevent clicks inside the modal from closing it
      modal.onclick = function(e) { e.stopPropagation(); };

      // Header row: title + close button
      var header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid #eee;';
      var headerTitle = (mode === 'new_job') ? 'New job for existing client/lead' : 'Load lead / contact';
      header.innerHTML = '<div style="font-weight:700;color:' + hex.dark + ';font-size:15px;">' + headerTitle + '</div>';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.style.cssText = 'border:none;background:transparent;color:' + hex.mid + ';font-size:24px;line-height:1;cursor:pointer;padding:0 4px;';
      closeBtn.onclick = function() { _close(); };
      header.appendChild(closeBtn);

      // Search input row (the modal owns its own input)
      var searchWrap = document.createElement('div');
      searchWrap.style.cssText = 'padding:12px 16px;border-bottom:1px solid #f2f2f2;';
      var searchInput = document.createElement('input');
      searchInput.id = 'sw-lead-search-input';
      searchInput.type = 'text';
      searchInput.placeholder = 'Search leads by name or phone...';
      searchInput.value = initialQuery || '';
      searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;color:' + hex.dark + ';outline:none;';
      searchInput.onfocus = function() { this.style.borderColor = hex.orange; };
      searchInput.onblur = function() { this.style.borderColor = '#ddd'; };
      searchWrap.appendChild(searchInput);

      // Scrollable list area
      var listWrap = document.createElement('div');
      listWrap.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px;';
      listWrap.innerHTML = '<div id="sw-lead-list"><p style="text-align:center;color:' + hex.mid + ';padding:30px 0;font-size:13px;">Loading leads...</p></div>';

      modal.appendChild(header);
      modal.appendChild(searchWrap);
      modal.appendChild(listWrap);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      // Autofocus the search input
      setTimeout(function() { try { searchInput.focus(); } catch(e) {} }, 0);

      // `force` is for the internal post-create teardown only. A user-driven
      // dismissal (backdrop / × / Escape) is IGNORED while a create is in
      // flight (AM-C), so the modal is still mounted to show the error banner
      // and offer a retry if it fails.
      function _close(force) {
        if (_locked && !force) { _flashCreatingStatus(); return; }
        document.removeEventListener('keydown', _escHandler);
        // Tear down everything setup armed: a dismissed modal must not keep a
        // fetch alive, nor let its timers fire into a detached list node.
        if (_abortController) { try { _abortController.abort(); } catch(e) {} }
        _abortController = null;
        clearTimeout(_searchAbortTimer);
        clearTimeout(_searchTimer);
        clearTimeout(_flashTimer);
        var bd = document.getElementById('sw-lead-search-backdrop');
        if (bd) bd.remove();
        var md = document.getElementById('sw-lead-search-dropdown');
        if (md) md.remove();
      }

      // Escape key to close
      function _escHandler(e) {
        if (e.key === 'Escape') { _close(); }
      }
      document.addEventListener('keydown', _escHandler);

      function _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // Render a lead card. `idx` is the array index — the ONLY selection key,
      // because contact-only rows have id === null (AM-D).
      function _renderLeadCard(lead, idx) {
        var phone = lead.contactPhone || '';
        var rawName = (lead.contactName || lead.name || '').trim();
        var phoneOnlyName = /^\+?\d[\d\s\-]+$/.test(rawName);
        var name = (!rawName || phoneOnlyName) ? (phone ? 'Phone lead ' + phone : 'Unnamed lead') : rawName;
        var stage = lead.stageName || 'New';
        var hasJob = !!lead.supabaseJobId;
        var hasScope = !!lead.hasScope;
        // Normalised by ghl.searchLeads — the same flag the tap handler and
        // integration.js branch on, so the badge can't disagree with the action.
        var isContactOnly = !!lead.isContactOnly;
        var lookupFailed = !!lead.lookupFailed;

        var borderColor = hasScope ? '#34C759' : hasJob ? '#007AFF' : '#eee';
        var borderWidth = (hasScope || hasJob) ? '2px' : '1px';
        // lookupFailed rows are dimmed + not clickable in any mode (AM-C).
        var extraStyle = lookupFailed
          ? 'opacity:0.5;cursor:not-allowed;'
          : 'cursor:pointer;';
        var hoverAttrs = lookupFailed
          ? ''
          : ' onmouseover="this.style.background=\'#f8f8f8\'" onmouseout="this.style.background=\'#fff\'"';

        var html = '<div class="sw-lead-item" data-idx="' + idx + '"' + (lookupFailed ? ' data-locked="1"' : '') + ' style="padding:10px 12px;border:' + borderWidth + ' solid ' + borderColor + ';border-radius:8px;margin-bottom:6px;transition:background 0.15s;display:flex;justify-content:space-between;align-items:center;gap:8px;' + extraStyle + '"' + hoverAttrs + '>';
        html += '<div style="flex:1;min-width:0;">';
        html += '<div style="font-weight:600;color:' + hex.dark + ';font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + _esc(name) + '</div>';
        if (phone) html += '<div style="font-size:11px;color:#999;margin-top:1px;">' + _esc(phone) + '</div>';
        // In new_job mode every selectable card explains what tapping does.
        if (mode === 'new_job' && !lookupFailed) {
          html += '<div class="sw-lead-subtitle" style="font-size:11px;color:' + hex.orange + ';margin-top:2px;">Creates a new job for this client</div>';
        }
        html += '</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">';
        html += '<span class="sw-lead-status" style="display:none;"></span>';
        if (lookupFailed) {
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#8E8E9320;color:#8E8E93;font-weight:600;">Couldn\'t check — retry search</span>';
        } else if (isContactOnly) {
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#8E8E9320;color:#8E8E93;font-weight:600;">Contact</span>';
        } else if (hasScope) {
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#34C75920;color:#34C759;font-weight:600;">Scope saved</span>';
        } else if (hasJob) {
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#007AFF20;color:#007AFF;font-weight:600;">Job linked</span>';
        }
        if (!isContactOnly && !lookupFailed) {
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:' + hex.orange + '15;color:' + hex.orange + ';font-weight:500;">' + _esc(stage) + '</span>';
        }
        html += '</div>';
        html += '</div>';
        return html;
      }

      // Per-modal request coordination (AM-F): one AbortController, monotonic seq.
      // A newer search aborts the previous in-flight fetch and bumps the seq so a
      // late/stale response is discarded. `_locked` is the new_job double-tap guard.
      var _abortController = null;
      var _seq = 0;
      var _locked = false;
      // The "Creating job…" pill on the tapped card. A dismissal that the lock
      // swallows flashes it, so the tap reads as "still working", not "dead UI".
      var _lockedStatusEl = null;
      var _flashTimer = null;
      // Modal-scoped so _close can disarm the in-flight search's timeout.
      var _searchAbortTimer = null;
      // Survives the list rebuild that _loadLeads performs, so a message about
      // the search that was just re-run can outlive the innerHTML it replaces.
      var _pendingRefreshMsg = '';
      function _takeRefreshNotice() {
        if (!_pendingRefreshMsg) return '';
        var html = '<p id="sw-lead-modal-error" style="text-align:center;color:#FF3B30;padding:8px 0;font-size:12px;margin:0 0 6px;">' +
          _esc(_pendingRefreshMsg) + '</p>';
        _pendingRefreshMsg = '';
        return html;
      }
      function _flashCreatingStatus() {
        var el = _lockedStatusEl;
        if (!el) return;
        clearTimeout(_flashTimer);
        el.style.transition = 'none';
        el.style.opacity = '0.25';
        _flashTimer = setTimeout(function() {
          el.style.transition = 'opacity 0.25s';
          el.style.opacity = '1';
        }, 120);
      }

      // Load leads
      var _loadLeads = async function(query) {
        var list = document.getElementById('sw-lead-list');
        if (!list) return;
        if (_locked) return; // a job is being created; don't disturb the list

        if (_abortController) { try { _abortController.abort(); } catch(e) {} }
        var controller = new AbortController();
        _abortController = controller;
        var mySeq = ++_seq;
        var timedOut = false;
        clearTimeout(_searchAbortTimer);
        var timer = _searchAbortTimer = setTimeout(function() { timedOut = true; try { controller.abort(); } catch(e) {} }, 30000);

        list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:30px 0;font-size:13px;">Searching contacts…</p>';

        try {
          var leads = await ghl.searchLeads(query || '', pipelineKey, { signal: controller.signal });
          clearTimeout(timer);
          if (mySeq !== _seq) return; // superseded by a newer search — discard

          // Keep phone-only/no-name leads; field launch still needs a sync target.
          leads = leads || [];

          if (leads.length === 0) {
            list.innerHTML = _takeRefreshNotice() +
              '<p style="text-align:center;color:' + hex.mid + ';padding:30px 0;font-size:13px;">No matches — check spelling or try a phone number.</p>';
            return;
          }

          // Client keeps only the hasScope-first stable sort; backend already
          // orders opp rows by recency and appends contact-only rows (AM-E).
          leads.sort(function(a, b) {
            if (a.hasScope && !b.hasScope) return -1;
            if (!a.hasScope && b.hasScope) return 1;
            return 0;
          });

          list.innerHTML = _takeRefreshNotice() +
            leads.map(function(lead, i) { return _renderLeadCard(lead, i); }).join('');

          // Click handlers — keyed by array index (AM-D).
          list.querySelectorAll('.sw-lead-item').forEach(function(el) {
            if (el.getAttribute('data-locked') === '1') return; // lookupFailed: not selectable
            el.onclick = function() {
              if (_locked) return;
              var idx = parseInt(el.getAttribute('data-idx'), 10);
              var lead = leads[idx];
              if (!lead || lead.lookupFailed) return;

              // Any selection that creates a job — new_job mode, OR a contact-only
              // row in load mode (nothing to load, so onSelect resets then makes a
              // new job) — must use the locked/awaited path so a failed create
              // can't strand the user on a blank scope with the modal gone.
              var createsJob = (mode === 'new_job') || !!lead.isContactOnly;

              if (createsJob) {
                // AM-C: lock the whole list, show "Creating job…" on the tapped
                // card, and hold the modal open until onSelect settles.
                _locked = true;
                list.querySelectorAll('.sw-lead-item').forEach(function(c) {
                  c.style.pointerEvents = 'none';
                  if (c !== el) c.style.opacity = '0.5';
                });
                var statusEl = el.querySelector('.sw-lead-status');
                if (statusEl) {
                  statusEl.style.display = '';
                  statusEl.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:10px;background:' + hex.orange + '20;color:' + hex.orange + ';font-weight:600;';
                  statusEl.textContent = 'Creating job…';
                }
                _lockedStatusEl = statusEl || null;
                Promise.resolve(onSelect ? onSelect(lead) : null).then(function() {
                  _locked = false;
                  _lockedStatusEl = null;
                  _close(true);
                }).catch(function(err) {
                  _locked = false;
                  _lockedStatusEl = null;
                  clearTimeout(_flashTimer);
                  list.querySelectorAll('.sw-lead-item').forEach(function(c) {
                    // lookupFailed rows stay dimmed + inert — they were never
                    // selectable, so the reset must not make them look tappable.
                    if (c.getAttribute('data-locked') === '1') return;
                    c.style.pointerEvents = '';
                    c.style.opacity = '';
                  });
                  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
                  var msg = (err && err.message) ? err.message : 'Could not create the job';
                  if (err && err.code === 'cancelled') return; // user backed out of the confirm
                  // A timed-out create may have committed server-side without us
                  // learning the opportunity id, so never invite a blind retry:
                  // re-run the search instead. Anything that landed comes back as
                  // a real opp row, which LOADS rather than minting a duplicate.
                  if (err && err.code === 'timeout') {
                    _pendingRefreshMsg = 'Timed out. If the job was created it is listed below — tap it to open. Otherwise tap the client to try again.';
                    _loadLeads(query || '');
                    return;
                  }
                  var banner = document.getElementById('sw-lead-modal-error');
                  if (!banner) {
                    banner = document.createElement('p');
                    banner.id = 'sw-lead-modal-error';
                    banner.style.cssText = 'text-align:center;color:#FF3B30;padding:8px 0;font-size:12px;margin:0 0 6px;';
                    list.insertBefore(banner, list.firstChild);
                  }
                  banner.textContent = 'Error: ' + msg + ' — tap the client to retry.';
                });
              } else {
                _close();
                if (onSelect) onSelect(lead);
              }
            };
          });
        } catch(e) {
          clearTimeout(timer);
          if (mySeq !== _seq) return; // superseded — ignore
          if (e && e.name === 'AbortError') {
            // Our own cancellation of a superseded fetch is silent; only a real
            // client-side timeout surfaces an error state.
            if (timedOut) {
              list.innerHTML = _takeRefreshNotice() +
                '<p style="text-align:center;color:#FF3B30;padding:30px 0;font-size:13px;">Search timed out. Retry, or refine your search.</p>';
            }
            return;
          }
          list.innerHTML = _takeRefreshNotice() +
            '<p style="text-align:center;color:#FF3B30;padding:30px 0;font-size:13px;">Error: ' + _esc(e.message) + ' — Retry.</p>';
        }
      };

      // Initial load
      _loadLeads(initialQuery || '');

      // Live search from the modal's own input (300ms debounce)
      var _searchTimer;
      searchInput.addEventListener('input', function() {
        clearTimeout(_searchTimer);
        var val = searchInput.value;
        _searchTimer = setTimeout(function() { _loadLeads(val); }, 300);
      });
    },

    // Small save indicator badge
    showSaveStatus: function(status, message) {
      var el = document.getElementById('sw-save-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sw-save-status';
        el.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:8px 16px;border-radius:20px;font-size:12px;font-weight:600;z-index:9999;transition:opacity 0.3s;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
        document.body.appendChild(el);
      }

      if (status === 'saving') {
        el.style.background = '#F0F4F7';
        el.style.color = '#4C6A7C';
        el.textContent = message || 'Saving...';
        el.style.opacity = '1';
      } else if (status === 'saved') {
        el.style.background = '#34C75920';
        el.style.color = '#34C759';
        el.textContent = message || 'Saved to cloud';
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, message ? 4000 : 2000);
      } else if (status === 'offline') {
        el.style.background = '#FF950020';
        el.style.color = '#FF9500';
        el.textContent = message || 'Saved locally (offline)';
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, 3000);
      } else if (status === 'error') {
        el.style.background = '#FF3B3020';
        el.style.color = '#FF3B30';
        el.textContent = 'Save failed';
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, 3000);
      }
    }
  };

  // ════════════════════════════════════════════════════════════
  // INIT — check for existing session
  // ════════════════════════════════════════════════════════════

  (async function init() {
    _loadQueue();

    try {
      var session = await sb.auth.getSession();
      if (session.data?.session?.user) {
        _user = session.data.session.user;
        await _loadUserProfile();
        emit('auth:login', _userProfile);
        _flushQueue();
      }
    } catch(e) {
      console.warn('[Cloud] Session check failed:', e);
    }
  })();

  // ════════════════════════════════════════════════════════════
  // PRICING — fetch scope_tool_defaults from DB
  // ════════════════════════════════════════════════════════════

  var pricing = {
    async getDefaults(scopeTool) {
      try {
        var { data, error } = await sb.from('scope_tool_defaults')
          .select('category, item_key, item_description, unit, default_price, default_cost_rate, default_sqm_rate, last_updated_at, default_supplier_name, default_supplier_id')
          .eq('scope_tool', scopeTool);
        if (error || !data) return null;
        var map = {};
        data.forEach(function(row) { map[row.item_key] = row; });
        return { defaults: map, fetched_at: new Date().toISOString() };
      } catch(e) {
        console.warn('[Cloud] pricing.getDefaults failed:', e);
        return null;
      }
    },

    async getSuppliers() {
      try {
        var { data, error } = await sb.from('suppliers')
          .select('id, name, email, categories, default_for, delivery_lead_days')
          .eq('is_active', true)
          .not('categories', 'is', null)
          .order('name');
        if (error || !data) return [];
        return data;
      } catch(e) {
        console.warn('[Cloud] pricing.getSuppliers failed:', e);
        return [];
      }
    },

    async getSupplierPrices(supplierName, category) {
      try {
        var query = sb.from('material_price_ledger')
          .select('item_description, material_code, unit, unit_price, raw_supplier_price, raw_supplier_unit, captured_at')
          .eq('supplier_name', supplierName)
          .eq('status', 'confirmed')
          .order('captured_at', { ascending: false });
        if (category) query = query.eq('material_category', category);
        var { data, error } = await query;
        if (error || !data) return [];
        return data;
      } catch(e) {
        console.warn('[Cloud] pricing.getSupplierPrices failed:', e);
        return [];
      }
    }
  };

  // ════════════════════════════════════════════════════════════
  // EXPORT
  // ════════════════════════════════════════════════════════════

  window.SECUREWORKS_CLOUD = {
    auth: auth,
    jobs: cloud,
    docs: docs,
    media: media,
    ghl: ghl,
    ui: ui,
    pricing: pricing,

    // Auto-save helpers
    startAutoSave: startAutoSave,
    resumeAutoSave: resumeAutoSave,
    stopAutoSave: stopAutoSave,
    authorizedHeaders: authorizedHeaders,
    authorizedFetch: authorizedFetch,
    flushOfflineQueue: _flushQueue,
    discardQueuedScopePayload: _discardQueuedScopePayload,

    // Event system
    on: on,
    off: off,

    // State
    isOnline: function() { return _online; },
    getOfflineState: function() { return { queue: _offlineQueue.slice(), jobIdMap: Object.assign({}, _offlineJobIdMap || {}) }; },

    // Direct Supabase access (escape hatch)
    supabase: sb,
    supabaseUrl: SUPABASE_URL
  };

})();

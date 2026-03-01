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

  // ── Configuration ──
  var metaUrl = document.querySelector('meta[name="supabase-url"]');
  var metaKey = document.querySelector('meta[name="supabase-anon-key"]');
  var SUPABASE_URL = window.SUPABASE_URL || (metaUrl && metaUrl.content) || '';
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || (metaKey && metaKey.content) || '';

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
  var _listeners = {};
  var _autoSaveTimer = null;

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

  // ── Online/Offline Detection ──
  window.addEventListener('online', function() {
    _online = true;
    emit('online');
    _flushQueue();
  });

  window.addEventListener('offline', function() {
    _online = false;
    emit('offline');
  });

  // ── Offline Queue ──
  function _enqueue(action) {
    _offlineQueue.push(action);
    try {
      localStorage.setItem('sw_offline_queue', JSON.stringify(_offlineQueue));
    } catch(e) {}
  }

  function _loadQueue() {
    try {
      var raw = localStorage.getItem('sw_offline_queue');
      if (raw) _offlineQueue = JSON.parse(raw);
    } catch(e) { _offlineQueue = []; }
  }

  async function _flushQueue() {
    if (!_online || _offlineQueue.length === 0) return;
    var queue = _offlineQueue.slice();
    _offlineQueue = [];
    localStorage.removeItem('sw_offline_queue');

    for (var i = 0; i < queue.length; i++) {
      var action = queue[i];
      try {
        if (action.type === 'save_job') {
          await ghl.saveScope(action.jobId, action.scopeJson, action.meta || {});
        } else if (action.type === 'update_status') {
          // Status updates still use direct Supabase (less critical)
          try { await cloud.updateJobStatus(action.jobId, action.status); } catch(e2) { console.warn('[Cloud] Status update failed:', e2); }
        }
      } catch(e) {
        console.warn('[Cloud] Failed to flush queued action:', e);
        _enqueue(action);
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════════════════

  var auth = {
    // Send magic link email
    async sendMagicLink(email) {
      var result = await sb.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
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
    getRole() { return _userProfile?.role || null; }
  };

  // Load user profile from users table
  async function _loadUserProfile() {
    if (!_user) return;
    var result = await sb.from('users').select('*').eq('id', _user.id).single();
    if (result.error) {
      // User exists in auth but not in users table — auto-create
      if (result.error.code === 'PGRST116') {
        var insert = await sb.from('users').insert({
          id: _user.id,
          org_id: '00000000-0000-0000-0000-000000000001', // default org
          name: _user.email.split('@')[0],
          email: _user.email,
          role: 'estimator'
        }).select().single();
        if (insert.error) throw insert.error;
        _userProfile = insert.data;
      } else {
        throw result.error;
      }
    } else {
      _userProfile = result.data;
    }
    _orgId = _userProfile.org_id;
  }

  // Listen for auth state changes
  sb.auth.onAuthStateChange(async function(event, session) {
    if (event === 'SIGNED_IN' && session?.user) {
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
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=opportunities&pipeline=' + encodeURIComponent(pipeline));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load opportunities');
      return data.opportunities || [];
    },

    // Search opportunities by contact name
    async search(query) {
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=search&q=' + encodeURIComponent(query));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      return data.opportunities || [];
    },

    // Get full contact details from GHL
    async getContact(contactId) {
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=contact&contactId=' + encodeURIComponent(contactId));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get contact');
      return data.contact;
    },

    // Update GHL contact with details from the tool
    async updateContact(contactId, details) {
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=update_contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ contactId: contactId }, details))
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update contact');
      return data;
    },

    // Link a scope to a GHL opportunity (adds note to contact + tags opportunity)
    async linkScope(opportunityId, jobId, toolType, contactId) {
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId: opportunityId, jobId: jobId, toolType: toolType, contactId: contactId || '' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to link scope');
      return data;
    },

    // Find existing Supabase job for a GHL opportunity (via edge function to bypass RLS)
    async findJobByOpportunity(opportunityId) {
      console.log('[Cloud] findJobByOpportunity:', opportunityId);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=find_job&opportunityId=' + encodeURIComponent(opportunityId));
      var data = await res.json();
      console.log('[Cloud] findJobByOpportunity result:', data);
      if (!res.ok) throw new Error(data.error || 'Failed to find job');
      return data.job || null;
    },

    // Load a job by ID (via edge function, bypasses RLS)
    async loadJob(jobId) {
      console.log('[Cloud] loadJob:', jobId);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=load_job&jobId=' + encodeURIComponent(jobId));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load job');
      return data.job;
    },

    // List photos/videos for a job (via edge function)
    async listMedia(jobId) {
      console.log('[Cloud] listMedia:', jobId);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=list_media&jobId=' + encodeURIComponent(jobId));
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to list media');
      return data.media || [];
    },

    // Upload a photo to Supabase Storage (via edge function)
    async uploadPhoto(jobId, dataUrl, label, caption) {
      console.log('[Cloud] uploadPhoto:', jobId, label);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=upload_photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId, dataUrl: dataUrl, label: label || '', caption: caption || '' })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload photo');
      return data;
    },

    // Save scope data to a job (via edge function to bypass RLS)
    async saveScope(jobId, scopeJson, meta) {
      console.log('[Cloud] saveScope:', jobId);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=save_scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId, scopeJson: scopeJson, meta: meta })
      });
      var data = await res.json();
      console.log('[Cloud] saveScope result:', data);
      if (!res.ok) throw new Error(data.error || 'Failed to save scope');
      return data.job;
    },

    // Create a Supabase job linked to a GHL opportunity (via edge function to bypass RLS)
    async createJobForOpportunity(opportunityId, toolType, contact) {
      console.log('[Cloud] createJobForOpportunity:', opportunityId, toolType);
      var res = await fetch(SUPABASE_URL + '/functions/v1/ghl-proxy?action=create_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: opportunityId,
          toolType: toolType,
          clientName: contact.name || '',
          clientPhone: contact.phone || '',
          clientEmail: contact.email || '',
          siteAddress: contact.address || '',
          siteSuburb: contact.suburb || ''
        })
      });
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

  function startAutoSave(jobId, getStateFn, intervalMs) {
    stopAutoSave();
    intervalMs = intervalMs || 30000; // 30 seconds default

    _autoSaveTimer = setInterval(async function() {
      try {
        var state = getStateFn();
        if (!state) return;
        await ghl.saveScope(jobId, state, {});
        emit('autosave:success', { jobId: jobId });
      } catch(e) {
        console.warn('[Cloud] Auto-save failed:', e);
        emit('autosave:error', { jobId: jobId, error: e });
      }
    }, intervalMs);
  }

  function stopAutoSave() {
    if (_autoSaveTimer) {
      clearInterval(_autoSaveTimer);
      _autoSaveTimer = null;
    }
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
          '<div style="background:#fff;border-radius:12px;padding:32px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
            '<h2 style="margin:0 0 8px;color:' + hex.dark + ';font-size:18px;">Sign In</h2>' +
            '<p style="margin:0 0 20px;color:' + hex.mid + ';font-size:13px;">Enter your email to receive a magic link</p>' +
            '<input type="email" id="sw-login-email" placeholder="your@email.com" style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:12px;">' +
            '<button id="sw-login-btn" style="width:100%;padding:10px;background:' + hex.orange + ';color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Send Magic Link</button>' +
            '<p id="sw-login-status" style="margin:12px 0 0;font-size:12px;color:' + hex.mid + ';text-align:center;"></p>' +
            '<button id="sw-login-close" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      document.getElementById('sw-login-close').onclick = function() {
        overlay.remove();
      };

      document.getElementById('sw-login-btn').onclick = async function() {
        var email = document.getElementById('sw-login-email').value.trim();
        var status = document.getElementById('sw-login-status');
        if (!email) { status.textContent = 'Please enter your email'; return; }

        try {
          document.getElementById('sw-login-btn').disabled = true;
          document.getElementById('sw-login-btn').textContent = 'Sending...';
          await auth.sendMagicLink(email);
          status.style.color = '#34C759';
          status.textContent = 'Check your email for the login link!';
        } catch(e) {
          status.style.color = '#FF3B30';
          status.textContent = e.message || 'Failed to send link';
          document.getElementById('sw-login-btn').disabled = false;
          document.getElementById('sw-login-btn').textContent = 'Send Magic Link';
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

      // New job button
      document.getElementById('sw-job-new').onclick = async function() {
        try {
          var job = await cloud.createJob(toolType, {});
          overlay.remove();
          if (onSelect) onSelect(job.id);
        } catch(e) {
          alert('Failed to create job: ' + e.message);
        }
      };
    },

    // Show GHL opportunity picker modal
    showGHLPicker: function(toolType, onSelect) {
      var hex = (window.SW_BRAND?.HEX) || { orange: '#F15A29', dark: '#293C46', mid: '#4C6A7C' };
      var pipelineKey = (toolType === 'fencing') ? 'fencing' : 'patio';
      var overlay = document.createElement('div');
      overlay.id = 'sw-ghlpicker-overlay';
      overlay.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;">' +
          '<div style="background:#fff;border-radius:12px;padding:24px;max-width:520px;width:90%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
              '<h2 style="margin:0;color:' + hex.dark + ';font-size:18px;">Load from GHL</h2>' +
              '<button id="sw-ghl-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
              '<select id="sw-ghl-pipeline" style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
                '<option value="patio"' + (pipelineKey === 'patio' ? ' selected' : '') + '>Patios Sales</option>' +
                '<option value="fencing"' + (pipelineKey === 'fencing' ? ' selected' : '') + '>Fencing Sales</option>' +
              '</select>' +
              '<input type="text" id="sw-ghl-search" placeholder="Search by name..." style="flex:2;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
            '</div>' +
            '<div id="sw-ghl-list" style="overflow-y:auto;flex:1;min-height:200px;">' +
              '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">Loading opportunities...</p>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      document.getElementById('sw-ghl-close').onclick = function() { overlay.remove(); };

      // Load opportunities
      var _loadOpps = async function(pipeline, search) {
        var list = document.getElementById('sw-ghl-list');
        list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">Loading...</p>';
        try {
          var opps;
          if (search) {
            opps = await ghl.search(search);
          } else {
            opps = await ghl.getOpportunities(pipeline);
          }

          if (opps.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:' + hex.mid + ';padding:40px 0;">No opportunities found</p>';
            return;
          }

          list.innerHTML = opps.map(function(opp) {
            var subtitle = [opp.stageName, opp.contactPhone, opp.contactEmail].filter(Boolean).join(' \u00b7 ');
            return '<div class="sw-ghl-item" data-opp=\'' + JSON.stringify(opp).replace(/'/g, '&#39;') + '\' style="padding:12px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background=\'#f8f8f8\'" onmouseout="this.style.background=\'#fff\'">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<strong style="color:' + hex.dark + ';">' + (opp.contactName || opp.name || 'Unknown') + '</strong>' +
                '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:' + hex.orange + '20;color:' + hex.orange + ';font-weight:600;">' + (opp.stageName || opp.status || '') + '</span>' +
              '</div>' +
              (subtitle ? '<div style="font-size:12px;color:' + hex.mid + ';margin-top:4px;">' + subtitle + '</div>' : '') +
            '</div>';
          }).join('');

          // Click handlers
          list.querySelectorAll('.sw-ghl-item').forEach(function(el) {
            el.onclick = function() {
              var opp = JSON.parse(el.dataset.opp);
              overlay.remove();
              if (onSelect) onSelect(opp);
            };
          });
        } catch(e) {
          list.innerHTML = '<p style="text-align:center;color:#FF3B30;padding:40px 0;">Error: ' + e.message + '</p>';
        }
      };

      // Initial load
      _loadOpps(pipelineKey, '');

      // Pipeline change
      document.getElementById('sw-ghl-pipeline').onchange = function() {
        pipelineKey = this.value;
        document.getElementById('sw-ghl-search').value = '';
        _loadOpps(pipelineKey, '');
      };

      // Search debounce
      var _searchTimer;
      document.getElementById('sw-ghl-search').oninput = function() {
        clearTimeout(_searchTimer);
        var val = this.value;
        _searchTimer = setTimeout(function() { _loadOpps(pipelineKey, val); }, 300);
      };
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
        el.textContent = 'Saved to cloud';
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, 2000);
      } else if (status === 'offline') {
        el.style.background = '#FF950020';
        el.style.color = '#FF9500';
        el.textContent = 'Saved locally (offline)';
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
  // EXPORT
  // ════════════════════════════════════════════════════════════

  window.SECUREWORKS_CLOUD = {
    auth: auth,
    jobs: cloud,
    docs: docs,
    media: media,
    ghl: ghl,
    ui: ui,

    // Auto-save helpers
    startAutoSave: startAutoSave,
    stopAutoSave: stopAutoSave,

    // Event system
    on: on,
    off: off,

    // State
    isOnline: function() { return _online; },

    // Direct Supabase access (escape hatch)
    supabase: sb,
    supabaseUrl: SUPABASE_URL
  };

})();

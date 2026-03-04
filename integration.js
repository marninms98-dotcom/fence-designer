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
  var _getStateFn = null;
  var _loadStateFn = null;

  // Pre-fill all contact fields in the tool from a GHL contact object
  function _prefillContact(contact) {
    if (!contact) return;
    console.log('[Integration] Pre-filling contact:', contact);

    // Build full address string from parts
    var fullAddress = [contact.address, contact.suburb, contact.state, contact.postcode].filter(Boolean).join(', ');

    // Fencing tool v2: set fields directly on app.job and re-render
    if (window.app && window.app.job && _toolType === 'fencing') {
      var nameParts = (contact.name || '').split(' ');
      if (nameParts.length >= 2) {
        window.app.job.clientFirstName = nameParts[0];
        window.app.job.clientLastName = nameParts.slice(1).join(' ');
      } else {
        window.app.job.clientFirstName = contact.name || '';
      }
      window.app.job.client = contact.name || '';
      if (contact.email) window.app.job.email = contact.email;
      if (contact.phone) window.app.job.phone = contact.phone;
      if (fullAddress) window.app.job.address = fullAddress;
      if (contact.suburb) window.app.job.suburb = contact.suburb;
      window.app.save();
      if (typeof window.app.render === 'function') window.app.render();
      return;
    }

    // Patio tool + fallback: use DOM selectors
    var mapping = [
      { val: contact.name, selectors: '#customerName, #clientName, #client, [name="clientName"]' },
      { val: contact.email, selectors: '#clientEmail, #customerEmail, [name="clientEmail"], [name="email"]' },
      { val: contact.phone, selectors: '#customerPhone, #clientPhone, [name="clientPhone"], [name="phone"]' },
      { val: fullAddress, selectors: '#customerAddress, #clientAddress, #siteAddress, #address, [name="siteAddress"], [name="address"]' },
      { val: contact.suburb || '', selectors: '#customerSuburb, #clientSuburb' }
    ];

    mapping.forEach(function(m) {
      if (!m.val) return;
      document.querySelectorAll(m.selectors).forEach(function(el) {
        el.value = m.val;
        // Trigger input event so the tool picks up the change
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    // Also set window globals if the tool uses them
    if (typeof window.customer === 'object' && window.customer) {
      if (contact.name) window.customer.name = contact.name;
      if (contact.phone) window.customer.phone = contact.phone;
      if (contact.email) window.customer.email = contact.email;
      if (fullAddress) window.customer.address = fullAddress;
    }
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

    // Fencing tool v2: photos live in app.job.checklist.photos
    if (_toolType === 'fencing' && window.app && window.app.job) {
      if (photos.length > 0) {
        if (!window.app.job.checklist) window.app.job.checklist = {};
        if (!window.app.job.checklist.photos) window.app.job.checklist.photos = [];
        for (var i = 0; i < photos.length; i++) {
          var p = photos[i];
          // Only add if not already present (by cloudUrl)
          var exists = window.app.job.checklist.photos.some(function(ep) { return ep.cloudUrl === p.storage_url; });
          if (!exists) {
            window.app.job.checklist.photos.push({
              id: 'cloud-' + Date.now() + '-' + i,
              name: p.label || 'Photo ' + (i + 1),
              label: p.label || 'Photo',
              dataUrl: p.storage_url,
              cloudUrl: p.storage_url,
              timestamp: Date.now()
            });
          }
        }
        if (typeof window.app.renderChecklist === 'function') window.app.renderChecklist();
        if (typeof window.app.updateSectionStatuses === 'function') window.app.updateSectionStatuses();
        console.log('[Integration] Loaded', photos.length, 'photos into checklist');
      }
      if (videos.length > 0) {
        window.app.job.checklist.videoWalkthrough = true;
        if (typeof window.app.renderChecklist === 'function') window.app.renderChecklist();
        console.log('[Integration] Video exists in cloud, marking walkthrough done');
      }
      return;
    }

    // Patio tool / legacy: inject into window.sitePhotos
    if (photos.length > 0 && typeof window.sitePhotos !== 'undefined') {
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        var numericId = Date.now() + i;
        window.sitePhotos.push({
          id: numericId,
          cloudId: p.id,
          dataUrl: p.storage_url,
          cloudUrl: p.storage_url,
          label: p.label || 'Photo',
          caption: p.notes || '',
          originalSize: 0,
          compressedSize: 0
        });
      }
      if (typeof window.renderPhotoGrid === 'function') window.renderPhotoGrid();
      if (typeof window.updatePhotoCount === 'function') window.updatePhotoCount();
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
        file: null
      };
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
  }

  // ── Update UI based on auth state ──
  function updateUI() {
    var loginBtn = document.getElementById('sw-btn-login');
    var saveBtn = document.getElementById('sw-btn-save');
    var loadBtn = document.getElementById('sw-btn-load');
    var dashBtn = document.getElementById('sw-btn-dashboard');
    var status = document.getElementById('sw-cloud-status');

    if (!loginBtn) {
      console.warn('[Integration] updateUI: buttons not found in DOM');
      return;
    }

    if (cloud && cloud.auth.isLoggedIn()) {
      var user = cloud.auth.getUser();
      var userName = (user && user.name) || (user && user.email) || '';
      loginBtn.style.display = 'none';
      saveBtn.style.display = '';
      loadBtn.style.display = '';
      dashBtn.style.display = '';
      status.textContent = userName + (_jobId ? ' | Job loaded' : '');
      console.log('[Integration] UI updated: logged in as', userName);
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
  // STATE GETTERS / SETTERS  (tool-specific)
  // ════════════════════════════════════════════════════════════

  function getFencingState() {
    if (window.app && window.app.job) {
      // Deep clone job so we can strip base64 photo data (uploaded separately)
      var job = JSON.parse(JSON.stringify(window.app.job));
      // Strip base64 dataUrls from checklist photos to keep scope_json small
      // Photos with cloudUrl are already uploaded; others will be uploaded by save()
      if (job.checklist && job.checklist.photos) {
        job.checklist.photos = job.checklist.photos.map(function(p) {
          return { id: p.id, name: p.name, label: p.label, timestamp: p.timestamp, cloudUrl: p.cloudUrl || null };
        });
      }
      return {
        tool: 'fencing',
        version: '2.0',
        job: job,
        savedAt: new Date().toISOString()
      };
    }
    return null;
  }

  function loadFencingState(scopeJson) {
    if (!scopeJson || !scopeJson.job || !window.app) return false;
    try {
      window.app.job = scopeJson.job;
      if (window.app.job.runs && window.app.job.runs.length > 0) {
        window.app.currentRunId = window.app.job.runs[0].id;
      }
      // Sync header fields (jobRef, date, scoper)
      if (typeof window.app.syncHeaderFromJob === 'function') window.app.syncHeaderFromJob();
      // Full re-render populates all dynamically rendered sections (site info, runs, gates, etc.)
      if (typeof window.app.render === 'function') window.app.render();
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
      var textarea = document.getElementById('loadJobTextarea');
      if (textarea && typeof window.loadJobData === 'function') {
        textarea.value = JSON.stringify(scopeJson);
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
      // ── Patio tool ──
      // Try gatherJobData() first, fall back to DOM
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
      }

      // DOM fallbacks
      if (!data.name) data.name = (document.getElementById('customerName') || {}).value || '';
      if (!data.phone) data.phone = (document.getElementById('customerPhone') || {}).value || '';
      if (!data.email) data.email = (document.getElementById('clientEmail') || {}).value || '';
      if (!data.address) data.address = (document.getElementById('customerAddress') || {}).value || '';
      if (!data.suburb) data.suburb = (document.getElementById('customerSuburb') || {}).value || '';

      // Patio always has at least one config — check if roof style is set
      var roofStyle = (document.getElementById('inRoofStyle') || {}).value || '';
      data.hasItems = roofStyle !== '' && roofStyle !== 'none';

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

  // Run 8 validation checks. Returns { valid: boolean, errors: string[] }
  function _validateForSave() {
    var d = _collectValidationData();
    var errors = [];

    if (!d.name)       errors.push('Client name is required');
    if (!d.phone)      errors.push('Phone number is required');
    if (!d.email)      errors.push('Email address is required');
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
    login: function() {
      if (cloud) cloud.ui.showLoginModal();
    },

    save: async function() {
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
      // Fallback: read directly from DOM if meta is empty (covers both patio + fencing IDs)
      if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || document.getElementById('client') || {}).value || '';
      if (!meta.client_phone) meta.client_phone = (document.getElementById('customerPhone') || document.getElementById('clientPhone') || {}).value || '';
      if (!meta.client_email) meta.client_email = (document.getElementById('clientEmail') || {}).value || '';
      if (!meta.site_address) meta.site_address = (document.getElementById('customerAddress') || document.getElementById('address') || {}).value || '';
      if (!meta.site_suburb) meta.site_suburb = (document.getElementById('customerSuburb') || document.getElementById('clientSuburb') || {}).value || '';

      // Include pricing_json if the tool attached it to job state
      if (state.job && state.job._pricing_json) {
        meta.pricing_json = state.job._pricing_json;
      }

      try {
        cloud.ui.showSaveStatus('saving');

        if (!_jobId) {
          // Use DOM fields first, then prompt as last resort
          if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || {}).value || '';
          if (!meta.client_name) meta.client_name = prompt('Client name for this job:');
          if (!meta.client_name) { cloud.ui.showSaveStatus('error'); return; }

          // Create job via edge function (bypasses RLS)
          var contact = { name: meta.client_name, phone: meta.client_phone, email: meta.client_email, address: meta.site_address, suburb: meta.site_suburb };
          var job = await cloud.ghl.createJobForOpportunity(_ghlOpportunityId || '', _toolType, contact);
          _jobId = job.id;

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
        }

        // Save via edge function (bypasses RLS)
        console.log('[Integration] Saving scope for job:', _jobId);
        await cloud.ghl.saveScope(_jobId, state, meta);
        console.log('[Integration] Scope saved successfully');

        // Upload site photos via signed URLs (handles large photos, no size limit)
        // Fencing v2: photos are in app.job.checklist.photos with base64 dataUrls
        var sitePhotos = (_toolType === 'fencing' && window.app && window.app.job && window.app.job.checklist)
          ? (window.app.job.checklist.photos || [])
          : (window.sitePhotos || []);
        var photosToUpload = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl && p.dataUrl.startsWith('data:'); });
        if (photosToUpload.length > 0) {
          console.log('[Integration] Uploading', photosToUpload.length, 'photos via signed URLs...');
          cloud.ui.showSaveStatus('saving', 'Uploading photos 0/' + photosToUpload.length);
          for (var i = 0; i < photosToUpload.length; i++) {
            var photo = photosToUpload[i];
            try {
              cloud.ui.showSaveStatus('saving', 'Uploading photo ' + (i + 1) + '/' + photosToUpload.length);

              // Convert dataUrl to Blob for direct upload
              var mimeMatch = photo.dataUrl.match(/data:([^;]+);/);
              var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
              var ext = mime.includes('png') ? 'png' : 'jpg';
              var b64 = photo.dataUrl.split(',')[1];
              var binary = atob(b64);
              var bytes = new Uint8Array(binary.length);
              for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
              var blob = new Blob([bytes], { type: mime });

              // Get signed upload URL
              var urlRes = await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  fileName: (photo.label || 'photo_' + i) + '.' + ext,
                  contentType: mime
                })
              });
              var urlData = await urlRes.json();
              if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL');

              // Upload directly to Supabase Storage
              var uploadRes = await fetch(urlData.signedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': mime },
                body: blob
              });
              if (!uploadRes.ok) throw new Error('Photo upload failed: ' + uploadRes.status);

              // Register in database
              await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  storageUrl: urlData.publicUrl,
                  type: 'photo',
                  label: photo.label || 'Photo ' + (i + 1)
                })
              });

              photo.cloudUrl = urlData.publicUrl;
              console.log('[Integration] Photo uploaded:', photo.label, (blob.size / 1024).toFixed(0) + 'KB');
            } catch(photoErr) {
              console.warn('[Integration] Photo upload failed:', photo.label, photoErr);
            }
          }
        }

        // Upload site video via signed URL (handles large files)
        var siteVideo = window.siteVideo || null;
        if (siteVideo && !siteVideo.cloudUrl) {
          // Need either a File object or a dataUrl to upload
          var videoBody = siteVideo.file || null;
          var videoMime = 'video/mp4';
          var videoName = 'video.mp4';

          if (!videoBody && siteVideo.dataUrl) {
            // Convert dataUrl to blob (rare — most videos come as File)
            var vMimeMatch = siteVideo.dataUrl.match(/data:([^;]+);/);
            videoMime = vMimeMatch ? vMimeMatch[1] : 'video/mp4';
            var vB64 = siteVideo.dataUrl.split(',')[1];
            var vBinary = atob(vB64);
            var vBytes = new Uint8Array(vBinary.length);
            for (var k = 0; k < vBinary.length; k++) vBytes[k] = vBinary.charCodeAt(k);
            videoBody = new Blob([vBytes], { type: videoMime });
          }

          if (videoBody) {
            try {
              if (videoBody.name) videoName = videoBody.name;
              if (videoBody.type) videoMime = videoBody.type;
              console.log('[Integration] Uploading video...', videoName, ((videoBody.size || 0) / 1048576).toFixed(1) + 'MB');
              cloud.ui.showSaveStatus('saving', 'Uploading video...');

              var urlRes = await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=get_upload_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: _jobId, fileName: videoName, contentType: videoMime })
              });
              var urlData = await urlRes.json();
              if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL');

              var uploadRes = await fetch(urlData.signedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': videoMime },
                body: videoBody
              });
              if (!uploadRes.ok) throw new Error('Video upload failed: ' + uploadRes.status);

              await fetch(cloud.supabaseUrl + '/functions/v1/ghl-proxy?action=register_media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: _jobId,
                  storageUrl: urlData.publicUrl,
                  type: 'video',
                  label: siteVideo.label || 'Site Walkthrough'
                })
              });

              siteVideo.cloudUrl = urlData.publicUrl;
              console.log('[Integration] Video uploaded:', urlData.publicUrl);
            } catch(vidErr) {
              console.warn('[Integration] Video upload failed:', vidErr);
            }
          }
        }

        // Write scope link back to GHL opportunity notes
        if (_ghlOpportunityId) {
          try {
            await cloud.ghl.linkScope(_ghlOpportunityId, _jobId, _toolType, _ghlContactId);
          } catch(ghlErr) {
            console.warn('[Integration] GHL link failed (non-blocking):', ghlErr);
          }
        }

        // Push contact details back to GHL
        if (_ghlContactId && meta.client_name) {
          try {
            await cloud.ghl.updateContact(_ghlContactId, {
              name: meta.client_name,
              email: meta.client_email || '',
              phone: meta.client_phone || '',
              address: meta.site_address || '',
              suburb: meta.site_suburb || ''
            });
          } catch(ghlErr) {
            console.warn('[Integration] GHL contact update failed (non-blocking):', ghlErr);
          }
        }

        cloud.ui.showSaveStatus('saved');
        updateUI();

      } catch(e) {
        console.error('[Integration] Save failed:', e);
        cloud.ui.showSaveStatus('error');
        alert('Save failed: ' + e.message);
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
          _ghlOpportunityId = opp.id;
          _ghlContactId = opp.contactId || null;

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

          // Check if a Supabase job already exists for this opportunity
          var existingJob = null;
          try {
            existingJob = await cloud.ghl.findJobByOpportunity(opp.id);
            console.log('[Integration] Existing job:', existingJob ? existingJob.id : 'none');
          } catch(e) {
            console.warn('[Integration] findJobByOpportunity failed:', e);
          }

          if (existingJob) {
            _jobId = existingJob.id;
            console.log('[Integration] Found existing job:', _jobId);
            if (existingJob.scope_json && Object.keys(existingJob.scope_json).length > 0) {
              _loadStateFn(existingJob.scope_json);
            }
            // Load photos/videos from cloud
            try { await _loadCloudMedia(_jobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
          } else {
            // Create a new Supabase job linked to this GHL opportunity (via edge function)
            var contactForJob = contact || { name: opp.contactName, phone: opp.contactPhone, email: opp.contactEmail };
            console.log('[Integration] Creating job for:', contactForJob.name || opp.name);
            var job = await cloud.ghl.createJobForOpportunity(opp.id, _toolType, contactForJob);
            _jobId = job.id;
            console.log('[Integration] Job created:', _jobId);
          }

          // Pre-fill contact fields in the tool
          if (contact) _prefillContact(contact);

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
          console.log('[Integration] Job loaded, URL updated:', newUrl);
          updateUI();
          cloud.startAutoSave(_jobId, _getStateFn, 30000);

        } catch(e) {
          console.error('[Integration] GHL load error:', e);
          alert('Error loading opportunity: ' + e.message);
        }
      });
    },

    // Legacy: load from Supabase job list directly
    loadFromSupabase: function() {
      if (!cloud || !cloud.auth.isLoggedIn()) {
        cloud.ui.showLoginModal();
        return;
      }

      cloud.ui.showJobPicker(_toolType, async function(jobId) {
        try {
          var job = await cloud.jobs.loadJob(jobId);
          if (job.scope_json && Object.keys(job.scope_json).length > 0) {
            var loaded = _loadStateFn(job.scope_json);
            if (loaded) {
              _jobId = jobId;
              _ghlOpportunityId = job.ghl_opportunity_id || null;
              var newUrl = window.location.pathname + '?jobId=' + _jobId;
              window.history.replaceState({}, '', newUrl);
              updateUI();
              cloud.ui.showSaveStatus('saved');
              cloud.startAutoSave(_jobId, _getStateFn, 30000);
            } else {
              alert('Failed to load job data into the tool.');
            }
          } else {
            _jobId = jobId;
            _ghlOpportunityId = job.ghl_opportunity_id || null;
            var newUrl = window.location.pathname + '?jobId=' + _jobId;
            window.history.replaceState({}, '', newUrl);
            updateUI();

            if (job.client_name) {
              var nameFields = document.querySelectorAll('#clientName, #customerName, [name="clientName"]');
              nameFields.forEach(function(f) { f.value = job.client_name; });
            }

            cloud.startAutoSave(_jobId, _getStateFn, 30000);
          }
        } catch(e) {
          alert('Error loading job: ' + e.message);
        }
      });
    },

    openDashboard: function() {
      window.location.href = '../dashboard/index.html';
    }
  };

  window._swIntegration = integration;

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════

  function init() {
    console.log('[Integration] init() called');
    cloud = window.SECUREWORKS_CLOUD;
    _toolType = detectToolType();
    console.log('[Integration] Tool type:', _toolType, '| Cloud:', !!cloud);

    if (_toolType === 'fencing') {
      _getStateFn = getFencingState;
      _loadStateFn = loadFencingState;
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
      var urlJobId = getJobIdFromURL();
      if (urlJobId) {
        _jobId = urlJobId;
        // Load job via edge function (bypasses RLS)
        cloud.ghl.loadJob(urlJobId).then(async function(job) {
          if (job.scope_json && Object.keys(job.scope_json).length > 0) {
            _loadStateFn(job.scope_json);
          }
          _ghlOpportunityId = job.ghl_opportunity_id || null;

          // Load photos/videos from cloud into the tool
          try {
            await _loadCloudMedia(urlJobId);
          } catch(e) {
            console.warn('[Integration] Media load failed:', e);
          }

          cloud.startAutoSave(_jobId, _getStateFn, 30000);
          updateUI();
        }).catch(function(e) {
          console.warn('[Integration] Failed to auto-load job:', e);
        });
      }
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
    cloud.on('autosave:error', function() {
      cloud.ui.showSaveStatus('error');
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

    if (cloud.auth.isLoggedIn()) {
      var urlJobId = getJobIdFromURL();
      if (urlJobId) {
        _jobId = urlJobId;
        cloud.ghl.loadJob(urlJobId).then(async function(job) {
          if (job.scope_json && Object.keys(job.scope_json).length > 0) {
            _loadStateFn(job.scope_json);
          }
          _ghlOpportunityId = job.ghl_opportunity_id || null;
          try { await _loadCloudMedia(urlJobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
          cloud.startAutoSave(_jobId, _getStateFn, 30000);
          updateUI();
        }).catch(function(e) { console.warn('[Integration] Failed to load job:', e); });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 200); });
  } else {
    setTimeout(init, 200);
  }

})();

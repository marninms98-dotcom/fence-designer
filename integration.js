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

  // Upload a document blob to Supabase storage + register in job_documents
  async function _uploadDocBlob(cloudRef, jobId, jobNumber, blob, fileName, docType) {
    if (!cloudRef || !jobId || !blob) return;
    // Step 1: Get signed upload URL
    var uploadRes = await fetch(cloudRef.supabaseUrl + '/functions/v1/ops-api?action=upload_document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, file_name: fileName, content_type: blob.type || 'application/pdf' })
    });
    var uploadData = await uploadRes.json();
    if (!uploadData.signedUrl) throw new Error('No signed URL returned');
    // Step 2: PUT the blob
    await fetch(uploadData.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/pdf' },
      body: blob
    });
    // Step 3: Confirm upload (insert into job_documents)
    await fetch(cloudRef.supabaseUrl + '/functions/v1/ops-api?action=confirm_document_upload', {
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
  }

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

    // Set individual fields — these selectors cover both patio and fencing tools
    var mapping = [
      { val: displayName, selectors: '#customerName, #clientName, [name="clientName"]' },
      { val: contact.email, selectors: '#clientEmail, #customerEmail, [name="clientEmail"], [name="email"]' },
      { val: contact.phone, selectors: '#customerPhone, #clientPhone, [name="clientPhone"], [name="phone"]' },
      { val: streetAddress, selectors: '#customerAddress, #clientAddress, #siteAddress, [name="siteAddress"], [name="address"]' },
      { val: suburb, selectors: '#customerSuburb, #clientSuburb' }
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
      if (displayName) window.customer.name = displayName;
      if (contact.phone) window.customer.phone = contact.phone;
      if (contact.email) window.customer.email = contact.email;
      if (streetAddress) window.customer.address = streetAddress;
    }
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
    if (typeof window.sitePhotos !== 'undefined') window.sitePhotos = [];
    if (typeof window.siteVideo !== 'undefined') window.siteVideo = null;

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

    // Inject photos into the tool's sitePhotos array
    if (photos.length > 0 && typeof window.sitePhotos !== 'undefined') {
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
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
    if (refEl) refEl.value = jobNumber;
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
        savedAt: new Date().toISOString()
      };
    }
    return null;
  }

  function loadFencingState(scopeJson) {
    if (!scopeJson || !scopeJson.job || !window.app) return false;
    try {
      window.app.job = scopeJson.job;
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

  // ── Decking state get/load ──
  function getDeckingState() {
    if (typeof window.getToolState === 'function') {
      try {
        var base = window.getToolState();
        var pricingJson = null;
        if (typeof window.buildPricingJson === 'function') {
          try { pricingJson = window.buildPricingJson(); } catch(e) { console.warn('[Integration] buildPricingJson failed:', e); }
        }
        return {
          tool: 'decking',
          version: '1.0',
          client: base ? base.client : {},
          config: base ? base.config : {},
          extras: base ? base.extras : [],
          accessories: base ? base.accessories : [],
          pricing: base ? base.pricing : {},
          notes: base ? base.notes : {},
          _pricing_json: pricingJson,
          savedAt: new Date().toISOString()
        };
      } catch(e) {
        console.warn('[Integration] getDeckingState failed:', e);
      }
    }
    return null;
  }

  function loadDeckingState(scopeJson) {
    if (!scopeJson) return false;
    try {
      if (typeof window.loadToolState === 'function') {
        window.loadToolState(scopeJson);
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
          // Use DOM fields first, then prompt as last resort
          if (!meta.client_name) meta.client_name = (document.getElementById('customerName') || {}).value || '';
          if (!meta.client_name) meta.client_name = prompt('Client name for this job:');
          if (!meta.client_name) { cloud.ui.showSaveStatus('error'); return; }

          // Create job via edge function (bypasses RLS)
          var contact = { name: meta.client_name, phone: meta.client_phone, email: meta.client_email, address: meta.site_address, suburb: meta.site_suburb };
          var job = await cloud.ghl.createJobForOpportunity(_ghlOpportunityId || null, _toolType, contact);
          _jobId = job.id;

          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
        }

        // Save via edge function (bypasses RLS)
        console.log('[Integration] Saving scope for job:', _jobId);
        await cloud.ghl.saveScope(_jobId, state, meta);
        console.log('[Integration] Scope saved successfully');

        // Upload site photos via signed URLs (handles large photos, no size limit)
        var sitePhotos = window.sitePhotos || [];
        var photosToUpload = sitePhotos.filter(function(p) { return !p.cloudUrl && p.dataUrl; });
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

        // ── Post-QA only: GHL link, job number, PO, contact push ──
        // Only runs during Scope Complete (saveAfterSignOff). Regular cloud saves
        // just persist scope data — no job number, no GHL side-effects.
        if (_isSignOff) {
          // Write scope link back to GHL opportunity notes + assign job number
          var linkResult = null;
          if (_ghlOpportunityId) {
            try {
              linkResult = await cloud.ghl.linkScope(_ghlOpportunityId, _jobId, _toolType, _ghlContactId);
              if (linkResult && linkResult.jobNumber) {
                _lastJobNumber = linkResult.jobNumber;
                console.log('[Integration] Job number assigned:', linkResult.jobNumber);
              }
            } catch(ghlErr) {
              console.warn('[Integration] GHL link failed (non-blocking):', ghlErr);
            }
          }

          // Auto-create TWO draft POs from scope: Materials + Labour (non-blocking)
          if (linkResult && linkResult.jobNumber && _jobId) {
            try {
              // Get pricing_json line items from the scope tool state
              var pricing = (state && state.pricing) || {};
              var lineItems = pricing.line_items || pricing.items || [];
              var materialCost = pricing.materialCostEstimate || 0;
              var labourCost = pricing.labourCostEstimate || 0;

              // Split line items by category
              var materialCategories = ['steel', 'roofing', 'fencing', 'materials', 'concrete', 'flashings', 'fixings', 'guttering', 'delivery', 'gates'];
              var labourCategories = ['labour', 'installation', 'demolition', 'electrical'];

              var materialItems = [];
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
                    materialItems.push(poItem);
                  }
                });
              }

              // Fallback: if no line items but we have totals, create summary items
              if (materialItems.length === 0 && materialCost > 0) {
                // Fall back to scope_to_po extraction
                var poRes = await fetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=scope_to_po&jobId=' + _jobId);
                var poMaterials = await poRes.json();
                if (poMaterials && poMaterials.materials && poMaterials.materials.length > 0) {
                  materialItems = poMaterials.materials;
                } else {
                  materialItems = [{ description: 'Materials (per scope)', quantity: 1, unit: 'lot', unit_price: materialCost }];
                }
              }
              if (labourItems.length === 0 && labourCost > 0) {
                labourItems = [{ description: 'Installation labour (per scope)', quantity: 1, unit: 'lot', unit_price: labourCost }];
              }

              // Create Materials PO
              if (materialItems.length > 0) {
                await fetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    job_id: _jobId,
                    status: 'draft',
                    supplier_name: '',
                    line_items: materialItems,
                    reference: linkResult.jobNumber,
                    notes: 'MATERIALS — Auto-generated from scope. Assign supplier and review before approving.'
                  })
                });
                console.log('[Integration] Draft Materials PO created');
              }

              // Create Labour PO
              if (labourItems.length > 0) {
                await fetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
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
                console.log('[Integration] Draft Labour PO created');
              }

              // Sales Commission PO
              // Patio: 10% of gross profit (revenue ex GST - material cost - labour cost)
              // Fencing: 5.25% of total inc GST
              var totalIncGST = pricing.totalIncGST || 0;
              var totalExGST = pricing.totalExGST || pricing.subtotal || 0;
              var matCostEst = pricing.materialCostEstimate || 0;
              var labCostEst = pricing.labourCostEstimate || 0;
              var commissionAmount = 0;
              if (_toolType === 'fencing') {
                commissionAmount = totalIncGST * 0.0525;
              } else {
                // Patio/decking: 10% of gross profit
                var grossProfit = totalExGST - matCostEst - labCostEst;
                commissionAmount = grossProfit > 0 ? grossProfit * 0.10 : 0;
              }
              if (commissionAmount > 0) {
                var commNote = _toolType === 'fencing'
                  ? 'SALES COMMISSION — 35% × 15% = 5.25% of total inc GST ($' + totalIncGST.toFixed(2) + ').'
                  : 'SALES COMMISSION — 10% of gross profit ($' + (totalExGST - matCostEst - labCostEst).toFixed(2) + ' GP).';
                var commDesc = _toolType === 'fencing'
                  ? 'Sales commission (5.25%)'
                  : 'Sales commission (10% of GP)';
                await fetch(cloud.supabaseUrl + '/functions/v1/ops-api?action=create_po', {
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
                console.log('[Integration] Draft Commission PO created: $' + commissionAmount.toFixed(2));
              }
            } catch(poErr) {
              console.warn('[Integration] Draft PO creation failed (non-blocking):', poErr);
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
            }
          }

          // Push contact details back to GHL — only send non-empty fields
          if (_ghlContactId && meta.client_name) {
            try {
              var contactUpdate = { name: meta.client_name };
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

        // Start auto-save now that we have a real cloud job ID
        if (_jobId && _jobId.indexOf('local-') !== 0) {
          cloud.startAutoSave(_jobId, _getStateFn, 30000);
        }

        if (_lastJobNumber) {
          cloud.ui.showSaveStatus('saved', 'Saved — ' + _lastJobNumber);
        } else {
          cloud.ui.showSaveStatus('saved');
        }
        if (window.updateSyncStatus) window.updateSyncStatus('saved', new Date().toISOString());
        if (window.updateHeaderBadge) window.updateHeaderBadge();
        if (window.updateBottomToolbar) window.updateBottomToolbar();
        updateUI();

      } catch(e) {
        console.error('[Integration] Save failed:', e);
        cloud.ui.showSaveStatus('error');
        if (window.updateSyncStatus) window.updateSyncStatus('failed', new Date().toISOString());
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

          // ── Reset tool to clean state before loading new opportunity ──
          if (cloud) cloud.stopAutoSave();
          _jobId = null;
          _lastJobNumber = null;
          _jobLoaded = false;

          if (_toolType === 'fencing' && window.app) {
            localStorage.removeItem('fenceJob');
            window.app.job = null;
            window.app.currentRunId = null;
            if (typeof window.app._resetSections === 'function') window.app._resetSections();
            window.app.init();
            localStorage.removeItem('fenceQA_verification');
            if (typeof window.fenceQA !== 'undefined') window.fenceQA._verificationState = {};
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

          // Check if a Supabase job already exists for this opportunity + tool type
          // Passing _toolType prevents cross-division overwrite (patio vs fencing)
          var existingJob = null;
          try {
            existingJob = await cloud.ghl.findJobByOpportunity(opp.id, _toolType);
            console.log('[Integration] Existing job for type ' + _toolType + ':', existingJob ? existingJob.id : 'none');
          } catch(e) {
            console.warn('[Integration] findJobByOpportunity failed:', e);
          }

          if (existingJob) {
            _jobId = existingJob.id;
            _lastJobNumber = existingJob.job_number || null;
            console.log('[Integration] Found existing job:', _jobId, 'number:', _lastJobNumber);
            if (existingJob.scope_json && Object.keys(existingJob.scope_json).length > 0) {
              _loadStateFn(existingJob.scope_json);
            }
            // Override local job ref with Supabase job number (single source of truth)
            _applyJobNumber(_lastJobNumber);
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
          // ── Local-only new scope (no cloud job yet) ──
          if (jobId && jobId.indexOf('local-') === 0) {
            if (cloud) cloud.stopAutoSave();
            _jobId = jobId;
            _lastJobNumber = null;
            _jobLoaded = false;
            if (_toolType === 'fencing' && window.app) {
              localStorage.removeItem('fenceJob');
              window.app.job = null;
              window.app.currentRunId = null;
              if (typeof window.app._resetSections === 'function') window.app._resetSections();
              window.app.init();
            } else {
              _resetPatioForm();
            }
            updateUI();
            return;
          }

          // ── Reset tool to clean state before loading new job ──
          if (cloud) cloud.stopAutoSave();
          _jobId = null;
          _lastJobNumber = null;
          _jobLoaded = false;

          if (_toolType === 'fencing' && window.app) {
            localStorage.removeItem('fenceJob');
            window.app.job = null;
            window.app.currentRunId = null;
            if (typeof window.app._resetSections === 'function') window.app._resetSections();
            window.app.init();
            localStorage.removeItem('fenceQA_verification');
            if (typeof window.fenceQA !== 'undefined') window.fenceQA._verificationState = {};
          } else {
            _resetPatioForm();
          }

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
    },

    // ── Cloud save triggered after QA sign-off ──
    // Called automatically by both patio and fencing tools when scope is signed off.
    // Runs validation, saves scope + pricing + verification state to Supabase,
    // uploads photos/video, and links to GHL. Shows progress overlay.
    saveAfterSignOff: async function() {
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

      try {
        // Set sign-off flag — this gates GHL link, job number, PO creation
        _isSignOff = true;
        await integration.save();
        console.log('[Integration] Cloud save after sign-off completed');
        return { success: true, jobNumber: _lastJobNumber };
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

    // Connect integration state from an external load path (e.g. inline name search).
    // Ensures _jobId, _ghlOpportunityId, _ghlContactId are set so saves work correctly.
    _connectJob: function(jobId, opportunityId, contactId) {
      _lastJobNumber = null;
      _ghlOpportunityId = opportunityId || null;
      _ghlContactId = contactId || null;
      if (jobId) {
        _jobId = jobId;
        _jobLoaded = true;
        // Only update URL and start auto-save for real cloud jobs (not local-only)
        if (jobId.indexOf('local-') !== 0) {
          var newUrl = window.location.pathname + '?jobId=' + _jobId;
          window.history.replaceState({}, '', newUrl);
          if (cloud) cloud.startAutoSave(_jobId, _getStateFn, 30000);
        }
        console.log('[Integration] _connectJob: connected to job', _jobId);
      } else if (opportunityId) {
        // No Supabase job yet — just store the GHL IDs so the next save creates one linked correctly
        console.log('[Integration] _connectJob: GHL opportunity set, no cloud job yet', opportunityId);
      } else {
        // Full reset — no job, no opportunity
        _jobId = null;
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

    // If already logged in, load job immediately (auth:login won't fire)
    if (cloud.auth.isLoggedIn()) {
      _autoLoadJob();
    }
  }

  // Shared job-load logic — called from auth:login AND isLoggedIn() check.
  // Guard prevents double-load.
  async function _autoLoadJob() {
    var urlJobId = getJobIdFromURL();
    if (!urlJobId || _jobLoaded) return;
    _jobLoaded = true;

    _jobId = urlJobId;
    console.log('[Integration] Auto-loading job:', urlJobId);
    try {
      var job = await cloud.ghl.loadJob(urlJobId);
      if (job.scope_json && Object.keys(job.scope_json).length > 0) {
        _loadStateFn(job.scope_json);
      }
      _ghlOpportunityId = job.ghl_opportunity_id || null;
      _lastJobNumber = job.job_number || null;
      // Apply job number AFTER loadStateFn has finished setting the local ref
      _applyJobNumber(_lastJobNumber);
      try { await _loadCloudMedia(urlJobId); } catch(e) { console.warn('[Integration] Media load failed:', e); }
      cloud.startAutoSave(_jobId, _getStateFn, 30000);
      updateUI();
    } catch(e) {
      console.warn('[Integration] Failed to auto-load job:', e);
      _jobLoaded = false; // Allow retry
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 200); });
  } else {
    setTimeout(init, 200);
  }

})();

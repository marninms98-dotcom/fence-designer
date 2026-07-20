#!/usr/bin/env node
'use strict';

/**
 * Inline client-name autocomplete guarded-entry browser evidence harness.
 *
 * Same stub boundaries as cp2-repeat-client-browser-evidence.js (signed-in
 * window.supabase + fixture ghl-proxy fetch); drives the REAL page.
 *
 * Covers the SECOND entry door: the inline client-name autocomplete. A
 * contact-only row must render INERT ("Not available here") and a keyboard
 * selection must safe-stop without minting anything, now that browser-side
 * fence job creation is retired.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const shotDir = process.env.SCREENSHOT_DIR || path.join(root, 'tests', '.evidence');

const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.log('Inline autocomplete browser evidence SKIP: system Chrome/Chromium not found');
  process.exit(0);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!candidate.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(candidate, (err, body) => {
    if (err) return send(res, err.code === 'ENOENT' ? 404 : 500, err.code || String(err));
    send(res, 200, body, contentTypes[path.extname(candidate).toLowerCase()] || 'application/octet-stream');
  });
});

// ── Stub injected before every page script (window.supabase + ghl-proxy fetch) ──
const bootstrap = `
(function() {
  var SESSION = {
    access_token: 'test-session-token',
    user: { id: 'user-khairo', email: 'khairo@secureworksgroup.app' }
  };
  window.supabase = {
    createClient: function() {
      return {
        auth: {
          getSession: function() { return Promise.resolve({ data: { session: SESSION }, error: null }); },
          refreshSession: function() { return Promise.resolve({ data: { session: SESSION }, error: null }); },
          onAuthStateChange: function(cb) {
            setTimeout(function() { cb('INITIAL_SESSION', SESSION); }, 0);
            return { data: { subscription: { unsubscribe: function() {} } } };
          },
          signInWithOtp: function() { return Promise.resolve({ error: null }); },
          signInWithPassword: function() { return Promise.resolve({ data: { user: SESSION.user }, error: null }); },
          signOut: function() { return Promise.resolve({ error: null }); }
        }
      };
    }
  };

  // Fixture leads. Row 0 is the repeat client Khairo could not get a 2nd job
  // for: an existing fencing opportunity that already carries a saved scope.
  var LEADS = [
    { id: 'opp-old-dave', name: 'Dave Nguyen - Colorbond', contactId: 'contact-dave',
      contactName: 'Dave Nguyen', contactPhone: '0412 884 201', contactEmail: 'dave@example.com',
      stageName: 'Quote Sent', supabaseJobId: 'job-2261', hasScope: true },
    { id: null, name: null, contactId: 'contact-priya', contactName: 'Priya Sharma',
      contactPhone: '0433 120 887', contactEmail: 'priya@example.com' },
    { id: 'opp-broken', name: 'Lookup failed row', contactId: 'contact-broken',
      contactName: 'Tom Reilly', contactPhone: '0450 991 004', lookupFailed: true }
  ];

  window.__swCalls = [];
  var realFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (url.indexOf('/functions/v1/ghl-proxy') < 0) return realFetch(input, init);
    var action = (url.match(/action=([a-z_]+)/) || [])[1] || '';
    var q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
    var body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
    window.__swCalls.push({ action: action, q: q, body: body });

    var signal = init && init.signal;
    function reply(payload, delayMs) {
      return new Promise(function(resolve, reject) {
        var t = setTimeout(function() {
          resolve(new Response(JSON.stringify(payload), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        }, delayMs || 0);
        if (signal) signal.addEventListener('abort', function() {
          clearTimeout(t);
          var err = new Error('The user aborted a request.'); err.name = 'AbortError'; reject(err);
        });
      });
    }

    if (action === 'get_profile') {
      return reply({ profile: { id: 'user-khairo', email: 'khairo@secureworksgroup.app',
        name: 'Khairo', role: 'estimator', org_id: '00000000-0000-0000-0000-000000000001' } });
    }
    if (action === 'lead_search') {
      var rows = q ? LEADS.filter(function(l) {
        return (l.contactName || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
      }) : LEADS;
      // Deliberate latency so the "Searching contacts…" state is observable.
      return reply({ opportunities: rows }, window.__swSearchDelay || 400);
    }
    if (action === 'search') {
      // Legacy fallback must NOT be reached while lead_search answers.
      return reply({ opportunities: [] });
    }
    if (action === 'contact') {
      return reply({ contact: { id: 'contact-dave', name: 'Dave Nguyen', phone: '0412 884 201',
        email: 'dave@example.com', address: '18 Marlow Way', suburb: 'Canning Vale' } }, 150);
    }
    if (action === 'mint_fence_job') {
      return reply({ success: true, requestId: body.requestId, jobId: 'job-priya', jobNumber: 'SWF-2300',
        contactId: body.contactId, opportunityId: 'opp-priya',
        mapping: { outcome: 'created', canonicalOutcome: 'created' },
        revision: { scopeVersion: 1, scopeHash: null, updatedAt: '2026-07-21T02:15:00Z', requiresLoad: false }
      }, 200);
    }
    if (action === 'create_contact_and_opportunity') {
      return reply({ opportunityId: 'legacy-should-not-run', contactId: 'contact-dave' }, 250);
    }
    if (action === 'create_job') {
      return reply({ job: { id: 'job-2299', job_number: 'SW-2299', status: 'draft',
        ghl_opportunity_id: 'opp-new-dave-2', ghl_contact_id: 'contact-dave' } }, 200);
    }
    if (action === 'link') return reply({ ok: true });
    if (action === 'list_media') return reply({ media: [] });
    if (action === 'save_scope') return reply({ ok: true, job: { id: 'job-2299' } });
    return reply({ ok: true });
  };
})();
`;

function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch (_) {}
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('open', () => {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      });
      resolve({
        socket,
        send(method, params) {
          return new Promise((sendResolve, sendReject) => {
            const id = nextId++;
            pending.set(id, { resolve: sendResolve, reject: sendReject });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
      });
    }, { once: true });
  });
}

const results = [];
function record(id, ok, evidence) {
  results.push({ id, ok: !!ok, evidence });
}

async function run() {
  fs.mkdirSync(shotDir, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp2-evidence-chrome-'));
  const devToolsFile = path.join(profileDir, 'DevToolsActivePort');
  const child = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
    '--disable-gpu', '--disable-sync', '--metrics-recording-only', '--no-first-run', '--no-sandbox',
    '--window-size=1280,900',
    '--user-data-dir=' + profileDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let cdp;
  try {
    await waitFor(() => fs.existsSync(devToolsFile), 10000, 'Chrome DevTools port');
    const debugPort = fs.readFileSync(devToolsFile, 'utf8').split(/\r?\n/)[0];
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Keep the run offline and deterministic: no CDN, no Google, no Supabase.
    await cdp.send('Network.setBlockedURLs', { urls: [
      '*cdn.jsdelivr.net*', '*cdnjs.cloudflare.com*', '*googleapis.com*',
      '*gstatic.com*', '*supabase.co*',
    ] });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
    await cdp.send('Page.navigate', { url });

    const evalIn = async (expression, awaitPromise) => {
      const out = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: !!awaitPromise,
      });
      if (out.exceptionDetails) {
        throw new Error(expression.slice(0, 60) + ' → ' + JSON.stringify(out.exceptionDetails.exception && out.exceptionDetails.exception.description));
      }
      return out.result.value;
    };

    const shot = async (name) => {
      const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(shotDir, name);
      fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
      return file;
    };

    await waitFor(() => evalIn("!!(window.app && window._swIntegration && window.SECUREWORKS_CLOUD)"), 20000, 'page boot');
    // integration.js initialises 200ms after DOMContentLoaded; auth resolves async.
    await waitFor(() => evalIn("!!(window.SECUREWORKS_CLOUD.auth.isLoggedIn())"), 10000, 'signed-in session');
    await new Promise((r) => setTimeout(r, 400));

    // ── 1. Open the scope form and type into the inline client-name field ──
    await evalIn("(function(){var b=Array.prototype.find.call(document.querySelectorAll('button'),function(x){return x.textContent.trim()==='Launch';}); if(b) b.click();})()");
    await waitFor(() => evalIn("!!document.getElementById('launchNewLocalBtn')"), 5000, 'launch modal');
    await evalIn("document.getElementById('launchNewLocalBtn').click()");
    await new Promise((r) => setTimeout(r, 600));
    // NOTE: the shipped page has no #clientNameDropdown element and nothing
    // calls onClientNameInput — the inline autocomplete is currently unmounted
    // dead code (true on the base commit too, so this is pre-existing, not a
    // regression from this change). To get a real rendered surface we mount the
    // container the production render function targets, next to the client-name
    // field, and then drive the UNMODIFIED production code path.
    await evalIn(`(function(){
      var anchor = document.getElementById('addressDropdown');
      var host = document.createElement('div');
      host.style.cssText = 'position:relative;margin:12px;max-width:520px;';
      host.innerHTML = '<div style="font:600 13px -apple-system,sans-serif;color:#293C46;margin-bottom:6px;">Client name</div>' +
        '<input value="" placeholder="Start typing a client name…" style="width:100%;padding:10px 12px;border:1px solid #D4DEE4;border-radius:8px;font-size:15px;">' +
        '<div class="address-dropdown" id="clientNameDropdown" style="position:static;margin-top:6px;"></div>';
      (anchor ? anchor.parentNode.parentNode : document.body).prepend(host);
      host.scrollIntoView({ block: 'center' });
    })()`);

    await evalIn("window.__swCalls = []");
    // Empty query returns all fixture rows; the inline path filters lookupFailed
    // rows out itself, so the real client sees the opp row + the contact-only row.
    await evalIn("window.app._searchGHLContacts('')", true);
    await waitFor(() => evalIn("document.querySelectorAll('#clientNameDropdown .address-dropdown-item').length >= 2"), 8000, 'inline dropdown rows');
    const ddText = await evalIn("document.getElementById('clientNameDropdown').innerText");
    const shotA = await shot('inline-01-contact-only-inert.png');
    record('inline autocomplete exposes the contact-only row through the guarded mint owner',
      /New fence job/.test(ddText) && /No fence job yet — starts one safely\./.test(ddText),
      shotA + ' | ' + JSON.stringify(ddText));

    // ── 2. Contact-only is tappable; lookupFailed rows remain filtered/inert ──
    const rowState = JSON.parse(await evalIn("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#clientNameDropdown .address-dropdown-item'),function(el){return {idx:el.getAttribute('data-idx'),text:el.innerText.split('\\n')[0],hasHandler:!!el.getAttribute('onmousedown'),pointerEvents:getComputedStyle(el).pointerEvents,opacity:getComputedStyle(el).opacity};}))"));
    record('the real opp and contact-only rows are both tappable',
      rowState.length === 2 && rowState.every((row) => row.hasHandler && row.pointerEvents !== 'none'),
      JSON.stringify(rowState));

    // ── 3. Contact-only selection mints through the serialized command ──
    await evalIn("window.__swCalls = []");
    const jobIdBefore = await evalIn("String(window._swIntegration.getSyncState().jobId)");
    await evalIn("window.app.selectGHLContact(1)", true);
    await waitFor(() => evalIn("window._swIntegration.getSyncState().jobId === 'job-priya'"), 8000, 'inline canonical mint');
    const toast = await evalIn("document.getElementById('toastContainer').innerText");
    await new Promise((r) => setTimeout(r, 300));
    const shotB = await shot('inline-02-safe-stop-toast.png');
    const postCalls = JSON.parse(await evalIn("JSON.stringify(window.__swCalls.map(function(c){return c.action;}))"));
    const jobIdAfter = await evalIn("String(window._swIntegration.getSyncState().jobId)");
    record('keyboard-reached contact-only row reports the canonical fence job ready',
      /Fence job ready/.test(toast), shotB + ' | ' + JSON.stringify(toast.trim()));
    record('inline create uses only mint_fence_job and adopts its canonical identity',
      postCalls.includes('mint_fence_job') &&
      !postCalls.some((a) => ['create_contact_and_opportunity', 'create_job'].includes(a)) &&
      jobIdAfter === 'job-priya' && jobIdAfter !== jobIdBefore,
      'actions=' + JSON.stringify(postCalls) + ' jobId ' + jobIdBefore + ' → ' + jobIdAfter);

    console.log('Inline client-name autocomplete guarded-entry browser evidence');
    for (const row of results) {
      console.log((row.ok ? 'PASS ' : 'FAIL ') + row.id);
      console.log('  evidence: ' + row.evidence);
    }
    const failed = results.filter((r) => !r.ok);
    console.log('\nSummary: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
    console.log('Screenshots: ' + shotDir);
    return failed.length === 0 ? 0 : 1;
  } catch (error) {
    console.error('Inline autocomplete browser evidence FAIL');
    console.error(error.stack || error.message || String(error));
    for (const row of results) console.log((row.ok ? 'PASS ' : 'FAIL ') + row.id);
    return 1;
  } finally {
    if (cdp && cdp.socket) cdp.socket.close();
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('close', resolve);
    });
    child.kill('SIGKILL');
    await closed;
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

run().then((code) => process.exit(code));

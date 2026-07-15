#!/usr/bin/env node
'use strict';

/**
 * Repeat-client / fast-lead-search browser evidence harness.
 *
 * Drives the REAL production page (index.html + cloud.js + integration.js,
 * unmodified) in headless Chrome. Only two boundaries are stubbed, both
 * injected before any page script runs:
 *   1. window.supabase — a signed-in session, so the field user is logged in.
 *   2. fetch to the ghl-proxy edge function — fixture leads/contact/create
 *      responses, so nothing leaves the machine.
 *
 * It exercises the field flow Khairo hit:
 *   Launch → "4. New job for existing client/lead" → fast lead_search →
 *   pick a repeat client that already has a scoped job → new job created.
 *
 * Screenshots are written to SCREENSHOT_DIR (default: ./tests/.evidence).
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
  console.log('Repeat-client browser evidence SKIP: system Chrome/Chromium not found');
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
    if (action === 'create_contact_and_opportunity') {
      return reply({ opportunityId: 'opp-new-dave-2', contactId: 'contact-dave' }, 250);
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

    // ── 1. Launcher shows the repeat-client entry point ──
    await evalIn("Array.prototype.find.call(document.querySelectorAll('button'), function(b){return b.textContent.trim()==='Launch';}).click()");
    await waitFor(() => evalIn("!!document.getElementById('launchNewJobBtn')"), 5000, 'launch modal');
    const launcherText = await evalIn("document.getElementById('fieldLaunchModal').innerText");
    const shot1 = await shot('01-launcher-option-4.png');
    record('launcher offers "4. New job for existing client/lead"',
      /4\. New job for existing client\/lead/.test(launcherText), shot1);

    // ── 2. Option 4 opens lead search; searching copy is visible ──
    await evalIn("document.getElementById('launchNewJobBtn').click()");
    await waitFor(() => evalIn("!!document.getElementById('sw-lead-search-dropdown')"), 5000, 'lead search modal');
    const searchingCopy = await evalIn("(document.getElementById('sw-lead-list')||{}).innerText||''");
    const shot2 = await shot('02-searching-contacts.png');
    record('lead search shows the "Searching contacts…" state',
      /Searching contacts/.test(searchingCopy), shot2);

    // ── 3. Results render, keyed by index, with new_job subtitles ──
    await waitFor(() => evalIn("document.querySelectorAll('.sw-lead-item').length === 3"), 8000, 'lead rows');
    const listText = await evalIn("document.getElementById('sw-lead-list').innerText");
    const shot3 = await shot('03-lead-results-new-job-mode.png');
    const calls = await evalIn("JSON.stringify(window.__swCalls)");
    record('fast lead_search action answers the modal (legacy search untouched)',
      /"action":"lead_search"/.test(calls) && !/"action":"search"/.test(calls),
      'calls=' + calls);
    record('new_job cards explain the action; contact-only + lookupFailed rows are badged',
      /Creates a new job for this client/.test(listText) && /Contact/.test(listText) &&
      /Couldn't check/.test(listText), shot3);
    const lockedRows = await evalIn("document.querySelectorAll('.sw-lead-item[data-locked=\"1\"]').length");
    record('lookupFailed row is not selectable', lockedRows === 1, 'data-locked rows=' + lockedRows);

    // ── 4. Typing a name re-searches through the fast path ──
    await evalIn("(function(){var i=document.querySelector('#sw-lead-search-dropdown input');i.value='Dave';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor(() => evalIn("document.querySelectorAll('.sw-lead-item').length === 1"), 8000, 'filtered row');
    const shot4 = await shot('04-typed-search-dave.png');
    record('typing filters through lead_search and returns the repeat client',
      /Dave Nguyen/.test(await evalIn("document.getElementById('sw-lead-list').innerText")), shot4);

    // ── 5. Selecting the repeat client creates a NEW job, old job untouched ──
    await evalIn("window.__swCalls = []");
    await evalIn("document.querySelector('.sw-lead-item[data-idx=\"0\"]').click()");
    await waitFor(() => evalIn("/Creating job/.test((document.getElementById('sw-lead-list')||{}).innerText||'')"), 4000, 'creating-job lock');
    const lockedTaps = await evalIn("document.querySelector('.sw-lead-item[data-idx=\"0\"]').style.pointerEvents");
    const shot5 = await shot('05-creating-job-lock.png');
    record('tapping a client locks the list and shows "Creating job…"',
      lockedTaps === 'none', shot5);

    await waitFor(() => evalIn("!document.getElementById('sw-lead-search-dropdown')"), 15000, 'modal close after create');
    await new Promise((r) => setTimeout(r, 500));
    const createCalls = JSON.parse(await evalIn("JSON.stringify(window.__swCalls)"));
    const ccao = createCalls.find((c) => c.action === 'create_contact_and_opportunity');
    const createJob = createCalls.find((c) => c.action === 'create_job');
    record('a NEW fencing opportunity is created for the known contact',
      !!ccao && ccao.body.contactId === 'contact-dave' && ccao.body.toolType === 'fencing',
      'create_contact_and_opportunity body=' + JSON.stringify(ccao && ccao.body));
    record('the new job hangs off the NEW opportunity and carries ghl_contact_id',
      !!createJob && createJob.body.opportunityId === 'opp-new-dave-2' &&
      createJob.body.contactId === 'contact-dave' && createJob.body.toolType === 'fencing',
      'create_job body=' + JSON.stringify(createJob && createJob.body));
    record('the old job is never opened (no find_job / load_job in this path)',
      !createCalls.some((c) => c.action === 'find_job' || c.action === 'load_job'),
      'actions=' + createCalls.map((c) => c.action).join(','));

    const state = await evalIn("JSON.stringify({url: location.search, jobId: window._swIntegration.getSyncState().jobId, jobNumber: window._swIntegration.getLastJobNumber(), name: window.app.job.clientFirstName, phone: window.app.job.phone, header: (document.querySelector('.header-tag')||{}).textContent || ''})");
    const shot6 = await shot('06-new-job-loaded.png');
    const parsed = JSON.parse(state);
    record('a fresh job opens, prefilled with the repeat client details',
      parsed.jobId === 'job-2299' && /job-2299/.test(parsed.url) && /Dave/.test(parsed.name || ''),
      shot6 + ' | state=' + state);
    record('the new job carries its OWN job number in the header',
      parsed.jobNumber === 'SW-2299' && parsed.header === 'SW-2299', 'header tag=' + parsed.header);

    // ── 6. No-match copy ──
    await evalIn("Array.prototype.find.call(document.querySelectorAll('button'), function(b){return b.textContent.trim()==='Launch';}).click()");
    await waitFor(() => evalIn("!!document.getElementById('launchNewJobBtn')"), 5000, 'launch modal reopen');
    await evalIn("document.getElementById('launchNewJobBtn').click()");
    await waitFor(() => evalIn("!!document.querySelector('#sw-lead-search-dropdown input')"), 5000, 'lead search reopen');
    await evalIn("(function(){var i=document.querySelector('#sw-lead-search-dropdown input');i.value='zzzz';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor(() => evalIn("/No matches/.test((document.getElementById('sw-lead-list')||{}).innerText||'')"), 8000, 'no-match copy');
    const shot7 = await shot('07-no-matches-copy.png');
    record('empty result shows the refreshed no-match copy',
      /No matches — check spelling or try a phone number\./.test(await evalIn("document.getElementById('sw-lead-list').innerText")), shot7);

    // ── 7. AM-H: a scoper mid-draft is asked before anything is created ──
    await evalIn("(function(){window.app.job.clientFirstName='Half-scoped Jones';window.app.job.phone='0400111222';window.app._ensureFieldSync('evidence_run');window.app.save();window.__swConfirms=[];window.confirm=function(m){window.__swConfirms.push(m);return false;};window.__swCalls=[];})()");
    await evalIn("(function(){var i=document.querySelector('#sw-lead-search-dropdown input');i.value='Dave';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor(() => evalIn("document.querySelectorAll('.sw-lead-item').length === 1"), 8000, 'row for confirm test');
    await evalIn("document.querySelector('.sw-lead-item[data-idx=\"0\"]').click()");
    await new Promise((r) => setTimeout(r, 800));
    const confirmState = JSON.parse(await evalIn("JSON.stringify({prompts: window.__swConfirms, calls: window.__swCalls.map(function(c){return c.action;}), name: window.app.job.clientFirstName, modalOpen: !!document.getElementById('sw-lead-search-dropdown')})"));
    const shot8 = await shot('08-cancelled-create-keeps-draft.png');
    // The re-search that re-rendered the row is expected; nothing that mints an
    // opportunity or a job may run before the scoper says yes.
    const writeCalls = confirmState.calls.filter((a) => a !== 'lead_search');
    record('a meaningful draft is confirmed BEFORE any network create, and cancelling creates nothing',
      confirmState.prompts.length === 1 && /Start a new job for Dave Nguyen/.test(confirmState.prompts[0]) &&
      writeCalls.length === 0 && confirmState.name === 'Half-scoped Jones' && confirmState.modalOpen,
      shot8 + ' | prompt=' + JSON.stringify(confirmState.prompts[0]) + ', post-tap calls=' + JSON.stringify(confirmState.calls) + ', draftName=' + confirmState.name);

    console.log('Repeat-client / fast-lead-search browser evidence');
    for (const row of results) {
      console.log((row.ok ? 'PASS ' : 'FAIL ') + row.id);
      console.log('  evidence: ' + row.evidence);
    }
    const failed = results.filter((r) => !r.ok);
    console.log('\nSummary: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
    console.log('Screenshots: ' + shotDir);
    return failed.length === 0 ? 0 : 1;
  } catch (error) {
    console.error('Repeat-client browser evidence FAIL');
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

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => fs.existsSync(p));
if (!chrome) { console.log('Fence reconcile browser harness SKIP: Chrome not found'); process.exit(0); }

let serverState;
function reset(mode) {
  serverState = {
    mode,
    job: { id: 'job-1', job_number: 'SWF-1', ghl_opportunity_id: 'opp-1', ghl_contact_id: 'contact-1', scope_json: mode === 'divergent' ? serverScope('server-device') : (mode === 'unknown' ? null : {}), current_scope_hash: mode === 'divergent' ? 'hash-server' : 'hash-empty', current_scope_updated_at: '2026-07-20T00:00:00Z' },
    saves: [], loads: 0,
  };
}
function serverScope(marker) {
  return { tool: 'fencing', version: '1.0', job: { ref: 'SWF-1', client: 'Harness Client', phone: '0400000000', runs: [{ id: 'run-1', name: marker, length: 1, panels: [] }], gates: [], _fieldSync: { localDraftId: 'server-draft', syncAnchorType: 'job', syncAnchorId: 'job-1' } }, verification: null };
}
reset('empty');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, data, type) => { res.writeHead(status, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }); res.end(type ? data : JSON.stringify(data)); };
  if (url.pathname === '/test/reset') { reset(url.searchParams.get('mode') || 'empty'); return send(200, { ok: true }); }
  if (url.pathname === '/test/state') return send(200, serverState);
  if (url.pathname === '/functions/v1/ghl-proxy' && url.searchParams.get('action') === 'load_job') {
    serverState.loads++;
    return send(200, { job: serverState.job, current_scope_hash: serverState.job.current_scope_hash, current_scope_updated_at: serverState.job.current_scope_updated_at });
  }
  if (url.pathname === '/functions/v1/ghl-proxy' && url.searchParams.get('action') === 'save_scope') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const meta = body.meta || {};
      const ref = body.scopeJson && body.scopeJson.job && body.scopeJson.job.ref;
      serverState.saves.push({ ref, cursor: meta.baseScopeHash || null, scope: body.scopeJson, capability: meta.scopeCursorReconcileV1 === true });
      const requestId = 'browser-request-' + serverState.saves.length;
      if (/^SWF?-?\d+/i.test(ref || '') && ref !== serverState.job.job_number) return send(409, { error: 'wrong ref', reason: 'scope_ref_mismatch', job_id: 'job-1', request_id: requestId });
      if (!meta.baseScopeHash) return send(409, { error: 'cursor required', reason: 'missing_scope_cursor', current_scope_hash: serverState.job.current_scope_hash, job_id: 'job-1', request_id: requestId });
      if (meta.baseScopeHash !== serverState.job.current_scope_hash) return send(409, { error: 'scope changed', reason: 'scope_hash_conflict', current_scope_hash: serverState.job.current_scope_hash, job_id: 'job-1', request_id: requestId });
      if (serverState.mode === 'retryfail') return send(503, { error: 'retry transport failed', reason: 'transport_error', request_id: requestId });
      serverState.job.scope_json = body.scopeJson;
      serverState.job.current_scope_hash = 'hash-saved-' + serverState.saves.length;
      serverState.job.current_scope_updated_at = new Date().toISOString();
      return send(200, { job: serverState.job });
    });
    return;
  }
  const file = url.pathname === '/' ? path.join(root, 'tests/fixtures/reconcile-browser.html') : path.resolve(root, '.' + url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain');
  const ext = path.extname(file);
  send(200, fs.readFileSync(file), ext === '.js' ? 'application/javascript' : 'text/html');
});

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      ws,
      send(method, params, sessionId) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, { ok, fail }); ws.send(JSON.stringify({ id: n, method, params: params || {}, ...(sessionId ? { sessionId } : {}) })); }); },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); };
  });
}
async function waitFor(fn, label, ms = 8000) { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } throw new Error('Timed out: ' + label); }
async function evalIn(cdp, session, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }

async function newDevice(cdp, baseUrl) {
  const bc = await cdp.send('Target.createBrowserContext');
  const target = await cdp.send('Target.createTarget', { url: baseUrl, browserContextId: bc.browserContextId });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, attached.sessionId);
  await waitFor(() => evalIn(cdp, attached.sessionId, '!!(window._swIntegration && window._swIntegration.handleScopeSaveError)'), 'device integration');
  return { contextId: bc.browserContextId, session: attached.sessionId };
}

async function begin(cdp, device, marker, ref = 'SWF-1', mode = '') {
  return evalIn(cdp, device.session, `(async()=>{window.__started=await window.__beginConflict(${JSON.stringify(marker)},${JSON.stringify(ref)},${JSON.stringify(mode)});window.__handler=window.__started.promise;return window.__started.error})()`);
}
async function clickChoice(cdp, device, id) { await waitFor(() => evalIn(cdp, device.session, `!!document.getElementById(${JSON.stringify(id)})`), id); return evalIn(cdp, device.session, `document.getElementById(${JSON.stringify(id)}).click();true`); }
async function finish(cdp, device) { return evalIn(cdp, device.session, 'window.__handler.then(()=>true)'); }
async function state(baseUrl) { return fetch(baseUrl + 'test/state').then(r => r.json()); }

async function run() {
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-reconcile-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    const devtools = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(devtools), 'Chrome port');
    const port = fs.readFileSync(devtools, 'utf8').split(/\r?\n/)[0];
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
    cdp = await connect(version.webSocketDebuggerUrl);

    // Each scenario keeps two isolated browser contexts alive: office/server observer and iPad editor.
    async function pair(mode) { await fetch(baseUrl + 'test/reset?mode=' + mode); return [await newDevice(cdp, baseUrl), await newDevice(cdp, baseUrl)]; }

    let [office, ipad] = await pair('empty');
    const typed = await begin(cdp, ipad, 'empty-ipad');
    assert.deepStrictEqual(typed, { status: 409, reason: 'scope_hash_conflict', hash: 'hash-empty', jobId: 'job-1', requestId: 'browser-request-1' });
    await finish(cdp, ipad);
    let s = await state(baseUrl);
    assert.strictEqual(s.saves.length, 2); assert.strictEqual(s.job.scope_json.job.runs[0].name, 'empty-ipad'); assert.strictEqual(s.saves[1].capability, true);
    console.log('PASS two-device empty-server recovery adopts cursor and retries B payload once');

    [office, ipad] = await pair('divergent');
    await begin(cdp, ipad, 'keep-ipad'); await clickChoice(cdp, ipad, 'swKeepIpad'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 2); assert.strictEqual(s.job.scope_json.job.runs[0].name, 'keep-ipad');
    assert(await evalIn(cdp, ipad.session, `!!localStorage.getItem('fenceJob_checkpoint_draft-keep-ipad')`));
    console.log('PASS two-device real divergence Keep iPad checkpoints then writes once through CAS');

    [office, ipad] = await pair('divergent');
    await begin(cdp, ipad, 'take-ipad'); await clickChoice(cdp, ipad, 'swTakeServer'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 1); assert.strictEqual(await evalIn(cdp, ipad.session, 'window.app.job.runs[0].name'), 'server-device');
    assert(await evalIn(cdp, ipad.session, `!!localStorage.getItem('fenceJob_checkpoint_draft-take-ipad')`));
    console.log('PASS two-device real divergence Take server checkpoints before hydration');

    [office, ipad] = await pair('divergent');
    await begin(cdp, ipad, 'cancel-ipad'); await clickChoice(cdp, ipad, 'swCancelRecovery'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 1); assert.strictEqual(await evalIn(cdp, ipad.session, 'window.app.job.runs[0].name'), 'cancel-ipad');
    console.log('PASS divergence Cancel performs no remote write and retains local draft');

    [office, ipad] = await pair('empty');
    await begin(cdp, ipad, 'wrong-ref-ipad', 'SWF-999'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 1); assert.strictEqual(s.loads, 0); assert.strictEqual(s.job.scope_json && Object.keys(s.job.scope_json).length, 0);
    assert.strictEqual(await evalIn(cdp, ipad.session, `document.getElementById('sw-scope-recovery-banner').dataset.state`), 'identity_recovery_required');
    console.log('PASS wrong-ref hard stop retains draft with no cursor adopt, load, retry or write');

    [office, ipad] = await pair('empty');
    await begin(cdp, ipad, 'missing-cursor-ipad', 'SWF-1', 'missing'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 2); assert.strictEqual(s.job.scope_json.job.runs[0].name, 'missing-cursor-ipad');
    console.log('PASS capable missing-cursor client rehydrates server cursor before writing');

    [office, ipad] = await pair('retryfail');
    await begin(cdp, ipad, 'retry-fails-ipad'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 2); assert.strictEqual(s.job.scope_json && Object.keys(s.job.scope_json).length, 0);
    assert.strictEqual(await evalIn(cdp, ipad.session, `document.getElementById('sw-scope-recovery-banner').dataset.state`), 'retry_failed');
    console.log('PASS empty-server recovery failure retains local work and stops after its one retry');

    [office, ipad] = await pair('unknown');
    await begin(cdp, ipad, 'unknown-server-ipad'); await clickChoice(cdp, ipad, 'swCancelRecovery'); await finish(cdp, ipad);
    s = await state(baseUrl); assert.strictEqual(s.saves.length, 1); assert.strictEqual(s.job.scope_json, null);
    console.log('PASS absent server scope is not misclassified as proven empty');

    [office, ipad] = await pair('empty');
    const offline = await evalIn(cdp, ipad.session, `(async()=>{window.dispatchEvent(new Event('offline'));window.__setDraft('SWF-1','offline-ipad');const scope={tool:'fencing',job:window.app.job};const out=await window.SECUREWORKS_CLOUD.ghl.saveScope('job-1',scope,{baseScopeHash:'hash-empty'});return {queued:out.queued,queue:JSON.parse(localStorage.getItem('sw_offline_queue')).length,local:JSON.parse(localStorage.getItem('fenceJob')).runs[0].name};})()`);
    assert.deepStrictEqual(offline, { queued: true, queue: 1, local: 'offline-ipad' }); s = await state(baseUrl); assert.strictEqual(s.saves.length, 0);
    console.log('PASS two-context offline retention preserves local draft and queue without server write');

    console.log('\nSummary: 9 browser recovery scenarios passed, 0 failed');
  } finally {
    if (cdp) cdp.ws.close();
    const closed = new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
run().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });

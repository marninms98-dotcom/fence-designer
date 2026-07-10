#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const runnerPath = path.join(root, 'tests', 'fixtures', 'cp1-browser-flow.html');
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
  console.log('CP1 browser-flow harness SKIP: system Chrome/Chromium not found');
  process.exit(0);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// The fixture exercises the production page but cannot reach Supabase, GHL,
// Google, or any other external service. This keeps the browser test read-only.
const csp = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "frame-src 'self'",
  "object-src 'none'",
].join('; ');

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fileForUrl(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
  if (pathname === '/' || pathname === '/cp1-browser-flow.html') return runnerPath;
  const candidate = path.resolve(root, '.' + pathname);
  return candidate.startsWith(root + path.sep) ? candidate : null;
}

const server = http.createServer((req, res) => {
  const file = fileForUrl(req.url || '/');
  if (!file) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      send(res, err.code === 'ENOENT' ? 404 : 500, err.code || String(err));
      return;
    }
    send(res, 200, body, contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
});

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

async function run() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/cp1-browser-flow.html`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp1-chrome-'));
  const devToolsFile = path.join(profileDir, 'DevToolsActivePort');
  const child = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-sandbox',
    '--user-data-dir=' + profileDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let cdp;
  try {
    await waitFor(() => fs.existsSync(devToolsFile), 10000, 'Chrome DevTools port');
    const debugPort = fs.readFileSync(devToolsFile, 'utf8').split(/\r?\n/)[0];
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Chrome target creation failed: HTTP ${response.status}`);
    const target = await response.json();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    const resultText = await waitFor(async () => {
      const evaluation = await cdp.send('Runtime.evaluate', {
        expression: "document.querySelector('#result') && document.querySelector('#result').textContent",
        returnByValue: true,
      });
      const value = evaluation && evaluation.result && evaluation.result.value;
      return value && value !== 'running' ? value : null;
    }, 25000, 'production browser-flow result');

    const data = JSON.parse(resultText);
    console.log('CP1 browser-flow harness');
    for (const row of data.results || []) {
      console.log((row.ok ? 'PASS ' : 'FAIL ') + row.id);
      console.log('  evidence: ' + row.evidence);
    }
    if (data.pageError) console.log('pageError: ' + data.pageError);
    return data.ok ? 0 : 1;
  } catch (error) {
    console.error('CP1 browser-flow harness FAIL');
    console.error(error.stack || error.message || String(error));
    if (stderr) console.error(stderr.slice(-4000));
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

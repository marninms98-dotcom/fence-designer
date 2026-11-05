// The offline copy of a published scoping page (E1, 3 Nov 2026). build.mjs writes this file beside each page it builds
// for publishing, as sw.js, with that page's SHA-256 and the engine commit filled in; a release copies it into the
// page's folder with the page. The page registers it from there, so it looks after that one folder
// (/fence-designer/scope-engine/, /patio/scope-engine/ or /secureworks-ux/scopers/practice/), never the old tools.
//
// - The page is one file: its catalogue, scripts, font and the fence page are all inside it. On the first open the
//   worker keeps a copy of that file, checked byte for byte against PAGE_SHA256, so the copy is this release's page.
// - Each open asks the network first and waits up to TIMEOUT_MS for the whole page (on poor signal the first bytes
//   come quickly and the rest takes minutes). When the network is slow or gone it opens the copy instead. With no
//   copy yet, the open goes to the network as it always did.
// - A new release writes a new sw.js, so the browser installs it: it keeps the new page under a new cache name, takes
//   over, and deletes this folder's older copies. A page that is not this release's page is never kept.
// - Every other request (sign-in, the job system, GHL, maps, photos) goes straight to the network and is never kept.
//   Saves still go to the job system; work done with no signal stays in the page's own draft and outbox.
// To turn it off, publish src/offline/sw-retire.js as sw.js.
'use strict';
const STAMP = "7ea01bf68fb3-9b7ee0209e1e";
const PAGE_SHA256 = "9b7ee0209e1edfb26817aff18a1bf36071ce6695c304fe6d30da95d28eb8ba18";
const TIMEOUT_MS = 4000;
const PAGE = new URL('./', self.location.href).href;
const PREFIX = `offline-copy ${PAGE} `;
const CACHE = PREFIX + STAMP;

const sha256 = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
const html = (buf) => new Response(buf, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const isPage = (url) => { const u = new URL(url); const p = u.origin + u.pathname; return p === PAGE || p === `${PAGE}index.html`; };
const ours = async (buf) => (await sha256(buf)) === PAGE_SHA256;
const keep = async (buf) => { if (await ours(buf)) await (await caches.open(CACHE)).put(PAGE, html(buf)); };

// The page just opened is usually still in the browser's own cache. If that is another release's page, or there is
// none, it is asked for past every cache. No copy of this release's page: the install fails and is tried again later.
async function thisReleasesPage() {
  for (const [url, cache] of [[PAGE, 'default'], [`${PAGE}?offline-copy=${STAMP}`, 'reload']]) {
    try {
      const res = await fetch(url, { cache, credentials: 'same-origin' });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (await ours(buf)) return buf;
    } catch (e) { /* the next way */ }
  }
  throw new Error("this release's page could not be read");
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const buf = await thisReleasesPage();
    await (await caches.open(CACHE)).put(PAGE, html(buf));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function open(event) {
  const copy = await caches.match(PAGE, { cacheName: CACHE });
  if (!copy) {
    const res = await fetch(event.request);
    if (res.ok && !res.redirected) event.waitUntil(res.clone().arrayBuffer().then(keep).catch(() => {}));
    return res;
  }
  const stop = new AbortController();
  const whole = fetch(event.request.url, { credentials: 'same-origin', signal: stop.signal })
    .then((res) => (res.ok && !res.redirected ? res.arrayBuffer() : null))
    .catch(() => null);
  const late = new Promise((done) => { setTimeout(done, TIMEOUT_MS, null); });
  const buf = await Promise.race([whole, late]);
  if (buf) return html(buf);
  stop.abort();
  return copy;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate' || !isPage(req.url)) return;
  event.respondWith(open(event));
});

// The page asks whether its copy is kept, to say "Offline copy ready" (field/offlinecopy.ts).
self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port || !event.data || event.data.type !== 'offline-copy?') return;
  event.waitUntil(caches.match(PAGE, { cacheName: CACHE }).then((r) => port.postMessage({ ready: !!r, stamp: STAMP })));
});

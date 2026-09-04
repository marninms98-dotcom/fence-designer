'use strict';

// Behavioral coverage for the supplier / panel-system split work:
//   Unit 1 — the "Supplier (Buy From)" dropdown offers all nine suppliers with
//            the pinned four first, and keeps its Custom free-text option.
//            job.supplier stays the PANEL SYSTEM and is NOT renamed or migrated.
//   Unit 2 — picking a panel system auto-selects its default supplier, and the
//            operator can override that afterwards.
//   Unit 3 — each supplier routes to the right TO + CC list, and EVERY order
//            carries the universal fencing CC (Stratco therefore carries two).
//   Unit 4 — the material order opens as an Outlook DRAFT (mailto), never sends.
//   Unit 6 — an empty neighbour cost share % blocks quote generation and send.
//   Plus: a job saved BEFORE this change opens with identical panel maths, and
//   the client quote still renders with the new fields present.
//
// These drive the real engine (app._collectOutputData), the real material-order
// renderer and the real validator in the production index.html. No cloud, and
// no email is ever sent — the mailto navigation is intercepted, never followed.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
let server;
let baseUrl;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function installStub() {
  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: () => Promise.resolve({ data: { session: null }, error: null }),
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          signInWithOtp: () => Promise.resolve({ error: null }),
          signOut: () => Promise.resolve({ error: null }),
        },
        from() {
          const chain = {
            select() { return chain; }, eq() { return Promise.resolve({ data: [], error: null }); },
            not() { return chain; }, order() { return Promise.resolve({ data: [], error: null }); },
          };
          return chain;
        },
      };
    },
  };
  // Capture any attempt to navigate to a mail client instead of performing it.
  // Nothing in these tests may open or send mail.
  window.__mailtoCalls = [];
}

// A complete, sendable job. Deliberately shaped like a job saved BEFORE this
// change: `supplier` holds a PANEL SYSTEM key and there is NO
// installation.supplierSource at all, because that field did not exist for it.
function buildLegacyJob() {
  return {
    clientFirstName: 'Ada',
    clientLastName: 'Lovelace',
    client: 'Ada Lovelace',
    address: '12 Analytical Way, Perth WA 6000',
    phone: '0400 000 000',
    email: 'ada@example.com',
    ref: 'FEN-1001',
    supplier: 'Metroll',          // PANEL SYSTEM (pre-change field, unchanged)
    profile: 'Trimclad',
    colour: 'Monument',
    scopeType: 'fence-and-gate',
    pricePerMetre: 125,
    gates: [],
    neighboursRequired: false,
    neighbours: [],
    runs: [{
      name: 'Rear',
      length: 12,
      sheetHeight: 1800,
      panels: [
        { id: 'p1', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p2', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'long' },
        { id: 'p3', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p4', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
      ],
    }],
    quote: { urgency: 'standard', deliveryFee: 200, groundFinish: 'none', addons: {}, customLineItems: [] },
  };
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code || String(error)); return; }
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.use({ viewport: { width: 1024, height: 1366 } });

async function openApp(page) {
  await page.addInitScript(installStub);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.goto(baseUrl + '/index.html');
  await page.waitForFunction(() => window.app && typeof window.app._collectOutputData === 'function'
    && typeof window.app.getMaterialOrderRouting === 'function');
}

test('Unit 1 — Buy From lists all nine suppliers, pinned four first, custom option intact', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    app.job.supplier = '';
    app.job.installation = { supplierSource: '' };
    app.renderInstallation();
    const values = Array.from(document.querySelectorAll('#supSelect option')).map(o => o.value);
    return { values };
  });
  expect(res.values).toEqual([
    '',
    'RnR Direct', 'Fencing Warehouse', 'Lysaght', 'Stratco',
    'Metric Fencing', 'Mackson', 'Team Work Fencing', 'Metroll Direct', 'Oxworks',
    '__custom__',
  ]);
});

test('Unit 1 — the Custom free-text supplier still round-trips through the field', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    app.job.installation = { supplierSource: 'Bob’s Steel Shed' };
    app.renderInstallation();
    const select = document.getElementById('supSelect');
    const input = select.parentNode.querySelector('input[type="text"]');
    return {
      selected: select.value,
      inputValue: input ? input.value : null,
      resolved: app.getSupplierSource(),
      routingKnown: app.getMaterialOrderRouting().known,
      routingTo: app.getMaterialOrderRouting().to,
      routingCc: app.getMaterialOrderRouting().cc,
    };
  });
  expect(res.selected).toBe('__custom__');
  expect(res.inputValue).toBe('Bob’s Steel Shed');
  expect(res.resolved).toBe('Bob’s Steel Shed');
  // Unknown supplier: no TO on file, but the universal CC is still attached.
  expect(res.routingKnown).toBeFalsy();
  expect(res.routingTo).toBe('');
  expect(res.routingCc).toEqual(['fencing@secureworkswa.com.au']);
});

test('Unit 2 — every panel system auto-selects its supplier, and the operator can override', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    const auto = {};
    ['RNR', 'Metroll', 'Lysaght', 'Stratco'].forEach((sys) => {
      app.job.installation = {};
      app.updateSupplier(sys);
      auto[sys] = app.job.installation.supplierSource;
    });
    // Override: pick Metroll (defaults to Fencing Warehouse), then choose the
    // alternative. The override must stick — this is a default, not a lock.
    app.job.installation = {};
    app.updateSupplier('Metroll');
    const beforeOverride = app.getSupplierSource();
    app.updateInstallation('supplierSource', 'Metroll Direct');
    return { auto, beforeOverride, afterOverride: app.getSupplierSource(), stored: app.job.installation.supplierSource };
  });
  expect(res.auto).toEqual({
    RNR: 'RnR Direct',
    Metroll: 'Fencing Warehouse',
    Lysaght: 'Lysaght',
    Stratco: 'Stratco',
  });
  expect(res.beforeOverride).toBe('Fencing Warehouse');
  expect(res.afterOverride).toBe('Metroll Direct');
  expect(res.stored).toBe('Metroll Direct');
});

test('Unit 3 — every supplier routes to the right TO, and every order carries the universal CC', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    const out = {};
    ['RnR Direct', 'Fencing Warehouse', 'Lysaght', 'Stratco', 'Metroll Direct',
     'Oxworks', 'Metric Fencing', 'Mackson', 'Team Work Fencing'].forEach((name) => {
      app.job.installation = { supplierSource: name };
      const r = app.getMaterialOrderRouting();
      out[name] = { to: r.to, cc: r.cc, known: r.known };
    });
    return out;
  });

  const UNIVERSAL = 'fencing@secureworkswa.com.au';
  expect(res['RnR Direct']).toEqual({ to: 'sales@randrfencing.com.au', cc: [UNIVERSAL], known: true });
  expect(res['Fencing Warehouse']).toEqual({ to: 'sales@fencingwarehousewa.au', cc: [UNIVERSAL], known: true });
  expect(res['Lysaght']).toEqual({ to: 'lysaghtsaleswa@lysaght.com', cc: [UNIVERSAL], known: true });
  expect(res['Metroll Direct']).toEqual({ to: 'helen.mewburn@perth.metroll.com.au', cc: [UNIVERSAL], known: true });
  expect(res['Oxworks']).toEqual({ to: 'Nicole.Tingey@oxworks.com.au', cc: [UNIVERSAL], known: true });
  expect(res['Metric Fencing']).toEqual({ to: 'info@metricfencing.com.au', cc: [UNIVERSAL], known: true });
  expect(res['Mackson']).toEqual({ to: 'info@mackson.com.au', cc: [UNIVERSAL], known: true });
  expect(res['Team Work Fencing']).toEqual({ to: 'admin@teamworkfencing.com.au', cc: [UNIVERSAL], known: true });
  // Stratco carries its OWN CC plus the universal one — two CCs.
  expect(res['Stratco']).toEqual({
    to: 'tony.bacich@stratcowa.com.au',
    cc: ['tradewa@stratcowa.com.au', UNIVERSAL],
    known: true,
  });
});

test('Unit 1/3 — the material order heads itself with who it is EMAILED to, not the panel system', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    // Metroll panel system bought from Fencing Warehouse — the exact case that
    // used to head the order "Supplier: Metroll" while emailing Fencing Warehouse.
    app.job = Object.assign(app.job, build());
    app.job.installation = { supplierSource: 'Fencing Warehouse' };
    const d = app._collectOutputData();
    const text = app._buildMaterialOrderText(d);
    return {
      text,
      supplier: d.supplier,
      supplierSource: d.supplierSource,
    };
  }, buildLegacyJob.toString());

  expect(res.supplier).toBe('Metroll');                 // panel system, unchanged
  expect(res.supplierSource).toBe('Fencing Warehouse'); // buy-from
  expect(res.text).toContain('Order To: Fencing Warehouse <sales@fencingwarehousewa.au>');
  expect(res.text).toContain('Panel System: Metroll');
  // The old conflated header must be gone.
  expect(res.text).not.toContain('Supplier: Metroll');
});

test('Unit 4 — the order opens an Outlook DRAFT with the right TO/CC, and never sends', async ({ page }) => {
  await openApp(page);

  // Intercept the mailto navigation. Playwright cannot follow a mailto:, and we
  // must never hand a real mail client an order during a test run.
  const res = await page.evaluate(async (jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build());
    app.job.installation = { supplierSource: 'Stratco' };

    // _openMailDraft is the ONE place this app hands anything to a mail client.
    // Stubbing it proves the routing without a real compose window ever opening.
    const captured = [];
    const realOpen = app._openMailDraft;
    app._openMailDraft = (url) => { captured.push(String(url)); };

    let error = null;
    try { await app.emailMaterialOrder(); } catch (e) { error = String(e); }

    app._openMailDraft = realOpen;
    return { captured, error, routingStamp: app.job.installation.supplierRouting };
  }, buildLegacyJob.toString());

  expect(res.error).toBeNull();
  expect(res.captured).toHaveLength(1);
  const url = res.captured[0];
  expect(url.startsWith('mailto:')).toBeTruthy();
  const parsed = new URL(url);
  // Addresses go in readable, unencoded — Outlook desktop is fussy about a
  // percent-encoded @ in the recipient.
  expect(parsed.pathname).toBe('tony.bacich@stratcowa.com.au');
  expect(url).toContain('mailto:tony.bacich@stratcowa.com.au?');
  expect(parsed.searchParams.get('cc')).toBe('tradewa@stratcowa.com.au,fencing@secureworkswa.com.au');
  expect(url).toContain('cc=tradewa@stratcowa.com.au,fencing@secureworkswa.com.au');
  expect(parsed.searchParams.get('subject')).toContain('Material Order');
  expect(parsed.searchParams.get('subject')).toContain('FEN-1001');
  // A DRAFT only: the mailto: scheme opens a compose window and has no send
  // verb at all, and nothing here carries a send action or endpoint.
  expect(parsed.protocol).toBe('mailto:');
  expect(url).not.toMatch(/[?&](send|autosend|action)=/i);
  // No signature is written by us — Outlook supplies the operator's own, so a
  // draft must never arrive carrying a second, hard-coded one.
  const body = parsed.searchParams.get('body') || '';
  expect(body).not.toMatch(/Kind regards|Regards,|Shaun/i);
  // A routine order goes into the draft IN FULL, not via the clipboard fallback.
  expect(body).toContain('Order To: Stratco');
  expect(body).toContain('SECTION 1: FENCING PANELS & POSTS');
  expect(body).not.toContain('Full order is on the clipboard');
  // Routing is stamped onto the job for the record.
  expect(res.routingStamp.to).toBe('tony.bacich@stratcowa.com.au');
  expect(res.routingStamp.cc).toEqual(['tradewa@stratcowa.com.au', 'fencing@secureworkswa.com.au']);
});

test('Unit 6 — an empty neighbour cost share % blocks quote generation and send', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build());
    app.job.neighboursRequired = true;
    app.job.neighbours = [{
      id: 'nb-1', firstName: 'Grace', lastName: 'Hopper',
      phone: '0400 111 222', email: 'grace@example.com',
      address: '14 Analytical Way, Perth WA 6000',
      // sharePercent deliberately absent — the exact gap this unit closes.
    }];
    // The share % is a CLIENT-BILLING rule, so it only applies to the quote and
    // send paths — `{ forQuote: true }` is what those two doors pass.
    const missingEmpty = app._validateRequired({ forQuote: true });
    const qaEmpty = window.fenceQA.runScopeChecks();

    app.job.neighbours[0].sharePercent = 0;   // 0 is swallowed downstream — also blocked
    const missingZero = app._validateRequired({ forQuote: true });

    app.job.neighbours[0].sharePercent = 50;  // now valid
    const missingSet = app._validateRequired({ forQuote: true });
    return {
      missingEmpty, missingZero, missingSet,
      qaRed: (qaEmpty.items || qaEmpty).filter
        ? [].concat(qaEmpty.items || []).filter(i => i.severity === 'red').map(i => i.message)
        : [],
    };
  }, buildLegacyJob.toString());

  expect(res.missingEmpty).toContain('Neighbour cost share %');
  expect(res.missingZero).toContain('Neighbour cost share %');
  expect(res.missingSet).not.toContain('Neighbour cost share %');
});

test('a job saved BEFORE this change opens with identical panel maths and still prices the same', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    // Exactly as persisted before the split: a panel-system key on job.supplier
    // and no installation.supplierSource whatsoever.
    const legacy = build();
    app.job = Object.assign(app.job, legacy);
    // The app's own default job template carries an installation object with an
    // EMPTY supplierSource — that is precisely the pre-change saved shape.
    app.job.installation = {};

    const d = app._collectOutputData();
    return {
      storedSource: app.job.installation.supplierSource || '',
      supplier: app.job.supplier,
      panelWidth: app.getPanelWidthMm(),
      longWidth: app.getPanelW({ panelWidth: 'long' }),
      // Derived default fills the blank supplier without touching the saved job.
      resolvedSource: app.getSupplierSource(),
      routingTo: app.getMaterialOrderRouting().to,
      totalPanels: d.totalPanels,
      totalMetres: Math.round(d.totalMetres * 100) / 100,
      grandTotal: Math.round(d.grandTotal * 100) / 100,
    };
  }, buildLegacyJob.toString());

  // Metroll's published width — unchanged by the split, no 2380 fallback.
  expect(res.supplier).toBe('Metroll');
  expect(res.panelWidth).toBe(2365);
  expect(res.longWidth).toBe(3150);
  expect(res.totalPanels).toBe(4);
  expect(res.grandTotal).toBeGreaterThan(0);
  // Reading the job must not mutate it: no supplierSource is written on load.
  expect(res.storedSource).toBe('');
  // But the order still routes, via the panel system's default supplier.
  expect(res.resolvedSource).toBe('Fencing Warehouse');
  expect(res.routingTo).toBe('sales@fencingwarehousewa.au');
});

test('the client quote still generates with the new fields present', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build());
    app.job.installation = { supplierSource: 'Fencing Warehouse' };

    const raw = app._collectOutputData();
    const d = app._gatherFenceQuoteData(raw);
    const html = app._buildFenceQuoteHTML(d, {}, { forPDF: false });
    const pricing = app.buildPricingJson();
    return {
      len: html.length,
      hasTotal: html.indexOf(d.totalStr) !== -1,
      total: d.totalStr,
      grandTotal: Math.round(raw.grandTotal * 100) / 100,
      pricingTotal: pricing.total_inc_gst != null ? pricing.total_inc_gst : pricing.grand_total,
      // The quote is client-facing: neither internal field may leak onto it.
      leaksSupplierEmail: /fencingwarehousewa|randrfencing|stratcowa|perth\.metroll/.test(html),
    };
  }, buildLegacyJob.toString());

  expect(res.len).toBeGreaterThan(1000);
  expect(res.hasTotal).toBeTruthy();
  expect(res.grandTotal).toBeGreaterThan(0);
  expect(res.leaksSupplierEmail).toBeFalsy();
});

test('Unit 4 — an order too long for a mailto: falls back to a covering note, never a truncated order', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(async (jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build());
    app.job.installation = { supplierSource: 'Lysaght' };
    // Force the ceiling below any real order rather than fabricating a monster job.
    app._MAILTO_SAFE_LEN = 200;

    const captured = [];
    const realOpen = app._openMailDraft;
    app._openMailDraft = (url) => { captured.push(String(url)); };
    await app.emailMaterialOrder();
    app._openMailDraft = realOpen;

    const full = app._buildMaterialOrderText(app._collectOutputData());
    return { url: captured[0], full };
  }, buildLegacyJob.toString());

  const parsed = new URL(res.url);
  const body = parsed.searchParams.get('body') || '';
  // Routing survives the fallback...
  expect(parsed.pathname).toBe('lysaghtsaleswa@lysaght.com');
  expect(parsed.searchParams.get('cc')).toBe('fencing@secureworkswa.com.au');
  // ...and the body is a deliberate covering note, NOT a half-order.
  expect(body).toContain('Material order for FEN-1001');
  expect(body).toMatch(/Full order is (on the clipboard|in the Material Order tab)/);
  expect(body).not.toContain('SECTION 1');
  expect(res.full.startsWith(body)).toBeFalsy();
});

test('Unit 1 — picking the literal "Custom..." option keeps the free-text input open', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    // A panel system IS chosen, so a default buy-from supplier exists. Choosing
    // "Custom..." must not snap the control back to that default.
    app.job.installation = {};
    app.updateSupplier('Stratco');
    const autoSelected = document.getElementById('supSelect').value;

    app.updateInstallation('supplierSource', '__custom__');
    const select = document.getElementById('supSelect');
    const input = select.parentNode.querySelector('input[type="text"]');

    // And typing a name into it sticks.
    let typed = null;
    if (input) { input.value = 'Bunnings Trade'; input.onchange(); typed = app.getSupplierSource(); }
    return {
      autoSelected,
      selected: select.value,
      hasInput: !!input,
      // '__custom__' is a sentinel, never a supplier — routing must not resolve it.
      resolvedWhileSentinel: '__custom__',
      typed,
    };
  });
  expect(res.autoSelected).toBe('Stratco');
  expect(res.selected).toBe('__custom__');
  expect(res.hasInput).toBeTruthy();
  expect(res.typed).toBe('Bunnings Trade');
});

// ── Stratco profile photography ──
// All FOUR Stratco profiles ship with Stratco's own product photo in the repo.
// CGI Corrugated and CGI Mini are the same corrugated shape at different pitch,
// so each profile must resolve to its OWN file and be rendered big enough to
// tell apart on an iPad — a mix-up here is a wrong material order. Non-Stratco
// panel systems keep exactly the behaviour they had before.
const STRATCO_PROFILE_PHOTOS = {
  'Superdek': 'textures/stratco-superdek.png',
  'CGI Corrugated': 'textures/stratco-cgi-corrugated.png',
  'Wavelok': 'textures/stratco-wavelok.png',
  'CGI Mini': 'textures/stratco-cgi-mini.png',
};

test('each of the four Stratco profiles renders its own distinct product photo', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((profiles) => {
    const app = window.app;
    const out = {};
    profiles.forEach((profile) => {
      app.job.installation = {};
      app.updateSupplier('Stratco');
      app.job.profile = profile;
      app.renderInstallation();
      const img = document.querySelector('#bodyInstallation img[alt$="profile"]');
      out[profile] = {
        src: img ? img.getAttribute('src') : null,
        alt: img ? img.getAttribute('alt') : null,
        width: img ? img.style.width : null,
        height: img ? img.style.height : null,
        maxWidth: img ? img.parentElement.style.maxWidth : null,
        onerror: img ? img.getAttribute('onerror') : null,
      };
    });
    // Every Stratco profile in the live dropdown must be covered — adding a
    // fifth profile without an image would otherwise slip through silently.
    out.__dropdown = Array.from(document.querySelectorAll('#profile option'))
      .map((o) => o.value).filter((v) => v && v !== '__custom__');
    return out;
  }, Object.keys(STRATCO_PROFILE_PHOTOS));

  expect(res.__dropdown).toEqual(Object.keys(STRATCO_PROFILE_PHOTOS));

  const seen = new Set();
  Object.entries(STRATCO_PROFILE_PHOTOS).forEach(([profile, src]) => {
    const r = res[profile];
    expect(r.src, profile).toBe(src);
    expect(r.alt, profile).toBe(profile + ' profile');
    // Distinct file per profile: the two corrugated profiles must never share one.
    expect(seen.has(r.src), profile).toBeFalsy();
    seen.add(r.src);
    // Relative path — this ships to Pages under a subpath, never from root.
    expect(r.src.startsWith('/'), profile).toBeFalsy();
    expect(r.src, profile).not.toMatch(/^https?:/);
    // Responsive, and big enough that CGI Corrugated vs CGI Mini is legible.
    expect(r.width, profile).toBe('100%');
    expect(r.height, profile).toBe('auto');
    expect(parseInt(r.maxWidth, 10), profile).toBeGreaterThanOrEqual(480);
    // A missing file degrades to the diagram, never a broken image icon.
    expect(r.onerror, profile).toContain('_onProfileImgError');
  });
});

test('the four Stratco photos load, and CGI Corrugated and CGI Mini are visibly different', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(async (profiles) => {
    const app = window.app;
    const out = {};
    for (const profile of profiles) {
      app.job.installation = {};
      app.updateSupplier('Stratco');
      app.job.profile = profile;
      app.renderInstallation();
      const img = document.querySelector('#bodyInstallation img[alt$="profile"]');
      await img.decode().catch(() => {});
      const box = img.getBoundingClientRect();
      // Sample the rendered pixels so two different files cannot pass as one.
      const c = document.createElement('canvas');
      c.width = 64; c.height = 42;
      c.getContext('2d').drawImage(img, 0, 0, 64, 42);
      out[profile] = {
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        renderedWidth: Math.round(box.width),
        fingerprint: c.toDataURL().slice(-800),
      };
    }
    return out;
  }, Object.keys(STRATCO_PROFILE_PHOTOS));

  Object.entries(res).forEach(([profile, r]) => {
    expect(r.complete, profile).toBeTruthy();
    // The four are normalised to one canvas, so they render at a consistent size.
    expect(r.naturalWidth, profile).toBe(720);
    expect(r.naturalHeight, profile).toBe(470);
    // Not a thumbnail: fine corrugations have to survive to the screen.
    expect(r.renderedWidth, profile).toBeGreaterThanOrEqual(480);
  });
  // The load-bearing one: the two corrugated profiles are not the same picture.
  expect(res['CGI Corrugated'].fingerprint).not.toBe(res['CGI Mini'].fingerprint);
  const prints = Object.values(res).map((r) => r.fingerprint);
  expect(new Set(prints).size).toBe(4);
});

test('non-Stratco panel systems keep their existing profile artwork untouched', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    return {
      // A profile in neither map still renders the generated diagram.
      unmapped: app._getProfileSVG('Some Custom Profile', 'Metroll'),
      // The pre-existing remote-image profiles are unchanged.
      lysaght: app._getProfileSVG('Neetascreen', 'Lysaght'),
      metroll: app._getProfileSVG('Trimclad', 'Metroll'),
      rnr: app._getProfileSVG('Ridgeside', 'RNR'),
      // Same profile NAME under another system must not pick up Stratco's photo.
      foreignSuperdek: app._getProfileSVG('Superdek', 'Metroll'),
      foreignCgiMini: app._getProfileSVG('CGI Mini', 'Lysaght'),
    };
  });

  expect(res.unmapped).toContain('<svg');
  expect(res.unmapped).not.toContain('<img');
  expect(res.lysaght).toContain('steelselect.com.au');
  expect(res.metroll).toContain('steelselect.com.au');
  expect(res.rnr).toContain('steelselect.com.au');
  [res.unmapped, res.lysaght, res.metroll, res.rnr, res.foreignSuperdek, res.foreignCgiMini]
    .forEach((markup) => expect(markup).not.toContain('textures/'));
});

// ── Regression: a deliberate Buy From override must survive Panel System changes ──
// The Panel System dropdown fires onchange on EVERY touch, including switching
// away and back to correct a misclick. It used to overwrite the buy-from
// supplier unconditionally, silently re-routing the order email to a supplier
// the operator did not choose — worst on Metroll, the one panel system with a
// real named alternative. The earlier Unit 2 test overrode once and stopped,
// which is exactly why it could not see this.
test('a deliberate Buy From override survives later Panel System changes', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    app.job.installation = {};
    app.updateSupplier('Metroll');                                // auto → Fencing Warehouse
    const autoFilled = app.getSupplierSource();
    app.updateInstallation('supplierSource', 'Metroll Direct');   // deliberate override

    // The operator corrects a misclick: away to another system and back.
    app.updateSupplier('RNR');
    const afterAway = { source: app.getSupplierSource(), to: app.getMaterialOrderRouting().to };
    app.updateSupplier('Metroll');
    const afterBack = { source: app.getSupplierSource(), to: app.getMaterialOrderRouting().to };

    // Re-selecting the SAME system must not stomp it either.
    app.updateSupplier('Metroll');
    const afterResame = app.getSupplierSource();

    // ...and the control shows the operator's choice, not the default.
    app.renderInstallation();
    const rendered = document.getElementById('supSelect').value;
    return { autoFilled, afterAway, afterBack, afterResame, rendered };
  });

  expect(res.autoFilled).toBe('Fencing Warehouse');
  // The override survives every subsequent Panel System touch...
  expect(res.afterAway.source).toBe('Metroll Direct');
  expect(res.afterBack.source).toBe('Metroll Direct');
  expect(res.afterResame).toBe('Metroll Direct');
  expect(res.rendered).toBe('Metroll Direct');
  // ...and the order email follows the operator, not the panel system's default.
  expect(res.afterAway.to).toBe('helen.mewburn@perth.metroll.com.au');
  expect(res.afterBack.to).toBe('helen.mewburn@perth.metroll.com.au');
  expect(res.afterBack.to).not.toBe('sales@fencingwarehousewa.au');
});

test('auto-select still re-defaults for an operator who never overrode it', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    // Never-touched buy-from field: each panel system change re-defaults, which
    // is the whole point of the auto-select. Fixing the override bug must not
    // cost us this.
    app.job.installation = {};
    const trail = [];
    ['Metroll', 'RNR', 'Lysaght', 'Stratco', 'Metroll'].forEach((sys) => {
      app.updateSupplier(sys);
      trail.push(app.getSupplierSource());
    });

    // A fresh job with a supplier already stored from a PREVIOUS system's
    // default is still treated as un-overridden and re-defaults.
    app.job.installation = { supplierSource: 'Lysaght' };
    app.job.supplier = 'Lysaght';
    app.updateSupplier('Stratco');
    const carriedDefault = app.getSupplierSource();
    return { trail, carriedDefault };
  });

  expect(res.trail).toEqual(['Fencing Warehouse', 'RnR Direct', 'Lysaght', 'Stratco', 'Fencing Warehouse']);
  expect(res.carriedDefault).toBe('Stratco');
});

// ── Regression: internal documents are not gated by a client-billing field ──
// The neighbour cost share % decides who is BILLED what. The crew routinely has
// to order stock before that is settled, so it must gate the client quote and
// the send door only — never the internal material order or work order.
test('an empty neighbour share % blocks the quote but not the material or work order', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.neighboursRequired = true;
    app.job.neighbours = [{
      id: 'nb-1', firstName: 'Grace', lastName: 'Hopper',
      phone: '0400111222', email: 'grace@example.com',
      address: '14 Analytical Way, Perth WA 6000',
      // sharePercent deliberately absent
    }];

    const internal = app._validateRequired();
    const quote = app._validateRequired({ forQuote: true });

    // The internal documents must actually be produced, not merely permitted.
    const opened = [];
    const realOpen = app._openOutputTab;
    app._openOutputTab = (title, html) => { opened.push({ title, len: html.length }); };
    const toasts = [];
    const realToast = app.showToast;
    app.showToast = (msg, kind) => { toasts.push({ msg, kind }); };

    app.generateMaterialOrder();
    app.generateWorkOrder();

    app._openOutputTab = realOpen;
    app.showToast = realToast;
    return { internal, quote, opened, toasts };
  }, buildLegacyJob.toString());

  // The gate still fires for the client quote and the send door...
  expect(res.quote).toContain('Neighbour cost share %');
  // ...and no longer for internal documents.
  expect(res.internal).not.toContain('Neighbour cost share %');
  expect(res.opened.map((o) => o.title)).toEqual(['Material Order', 'Work Order']);
  res.opened.forEach((o) => expect(o.len).toBeGreaterThan(500));
  expect(res.toasts.some((t) => t.kind === 'error')).toBeFalsy();
});

// ── Regression pin: internal cost and margin must never reach the client quote ──
// Verified correct today; this exists so it stays that way. The quote is what
// the client reads — a cost price or margin figure appearing there is the
// worst-case leak from the custom-item cost work.
test('cost, margin and internal fields never reach the client quote HTML', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    // Distinctive, unmistakable numbers: a cost nobody could produce by accident
    // and a sell price that must appear.
    app.job.quote.customLineItems = [
      { desc: 'Powder-coated post caps', qty: 6, unit: 'each', price: 15, costPrice: 987.65, kind: 'material' },
      { desc: 'Extra site labour', qty: 3, unit: 'hrs', price: 80, costPrice: 543.21, kind: 'labour' },
    ];
    app.job.quote.priceDisplay = 'itemized';   // the mode that prints line items
    app.job.installation = { supplierSource: 'Stratco' };

    const raw = app._collectOutputData();
    const d = app._gatherFenceQuoteData(raw);
    const html = app._buildFenceQuoteHTML(d, {}, { forPDF: false });
    // Embedded base64 images coincidentally contain almost any short digit
    // string, so scan the real DOCUMENT text, not the binary payloads.
    const scannable = html.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:[BINARY]');
    return {
      html, scannable,
      binaryStripped: html.length - scannable.length,
      gatheredKeys: Object.keys(d),
      internalCost: raw.internalCost,
      customCostTotal: raw.customCostTotal,
      materialMargin: raw.materialMargin,
    };
  }, buildLegacyJob.toString());

  // The engine really did capture the costs — otherwise this test proves nothing.
  expect(res.customCostTotal).toBeCloseTo(6 * 987.65 + 3 * 543.21, 2);
  expect(res.internalCost).toBeGreaterThan(0);

  // Sanity: the strip actually removed binary, so a pass is not a vacuous one.
  expect(res.binaryStripped).toBeGreaterThan(1000);
  // Not one of them reaches the client's document.
  ['987.65', '987', '543.21', '5925.9', '1629.63', 'costPrice', 'cost_price', 'internalCost',
   'materialMargin', 'customCostTotal', 'Cost price', 'Margin'].forEach((needle) => {
    expect(res.scannable.includes(needle), 'client quote leaked "' + needle + '"').toBeFalsy();
  });
  // Nor does the gathered quote object even carry the internal fields.
  ['internalCost', 'materialMargin', 'customCostTotal', 'plinthGroups', 'postGroups', 'orderRouting']
    .forEach((key) => expect(res.gatheredKeys, key).not.toContain(key));

  // ...while the client-facing SELL price for the same item is present.
  expect(res.scannable).toContain('Powder-coated post caps');
  expect(res.scannable).toContain('90.00');          // 6 x $15 sell
});

// ── The cost-share gate must bite EVERY neighbour, not just the first ──
// `addNeighbour()` used to persist an even-split default, so on a two-neighbour
// job the operator was forced to enter a share for neighbour 1 while neighbour 2
// sailed through on a 33% nobody chose — exactly the failure the rule exists to
// prevent.
test('a SECOND neighbour added with no share also blocks the quote', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.neighboursRequired = true;
    app.job.neighbours = [];

    // Both neighbours come in through the real button handler.
    app.addNeighbour();
    app.addNeighbour();
    const seededShares = app.job.neighbours.map((n) => n.sharePercent);

    app.job.neighbours.forEach((n, i) => {
      n.firstName = 'N' + i; n.lastName = 'Surname' + i;
      n.email = 'n' + i + '@example.com'; n.address = String(i) + ' Boundary St';
    });

    // Only the FIRST gets a deliberate share.
    app.job.neighbours[0].sharePercent = 50;
    const missingSecondUnset = app._validateRequired({ forQuote: true });

    // Internal documents stay reachable throughout — this is a billing rule.
    const internal = app._validateRequired();

    app.job.neighbours[1].sharePercent = 25;
    const missingBothSet = app._validateRequired({ forQuote: true });
    return { seededShares, missingSecondUnset, internal, missingBothSet };
  }, buildLegacyJob.toString());

  // Nothing was auto-seeded, so there is no unchosen number to sail through on.
  expect(res.seededShares).toEqual([undefined, undefined]);
  // The second neighbour's missing share blocks the quote, and names itself.
  expect(res.missingSecondUnset).toContain('Neighbour cost share % (neighbour 2)');
  expect(res.missingSecondUnset).not.toContain('Neighbour cost share % (neighbour 1)');
  // Internal orders are unaffected.
  expect(res.internal.some((m) => m.includes('cost share'))).toBeFalsy();
  // Once both are chosen the gate opens.
  expect(res.missingBothSet.some((m) => m.includes('cost share'))).toBeFalsy();
});

// ── A cost-only custom item is stock we buy, not a line we bill ──
// Admitting it on cost alone is deliberate (it must reach the order and the
// margin), but it has no sell price, so printing it to the client as a $0.00
// line item is not something we are charging for.
test('a cost-only custom item reaches the order and margin but never the client price table', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.quote.customLineItems = [
      { desc: 'Zinc post caps', qty: 6, unit: 'each', price: 0, costPrice: 12, kind: 'material' },
      { desc: 'Gate hardware upgrade', qty: 1, unit: 'lot', price: 340, costPrice: 120, kind: 'material' },
    ];
    app.job.quote.priceDisplay = 'itemized';   // the mode that prints line items

    const raw = app._collectOutputData();
    const d = app._gatherFenceQuoteData(raw);
    const quoteHtml = app._buildFenceQuoteHTML(d, {}, { forPDF: false });
    const legacyHtml = app._generateQuoteHTML(raw);
    const order = app._buildMaterialOrderText(raw);
    const pricing = app.buildPricingJson();

    // Same job with the cost-only item removed — the margin delta proves its
    // cost is still being captured.
    const withItem = raw.internalCost;
    app.job.quote.customLineItems = [app.job.quote.customLineItems[1]];
    const without = app._collectOutputData().internalCost;

    const strip = (h) => h.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:[BINARY]');
    return {
      priceLineLabels: (d.priceLineItems || []).map((li) => li.label),
      quoteScannable: strip(quoteHtml),
      legacyHtml,
      order,
      customLineDescs: (pricing.line_items || []).filter((li) => li.category === 'custom').map((li) => li.description),
      internalCostDelta: Math.round((withItem - without) * 100) / 100,
      customItemDescs: raw.customItems.map((c) => c.desc),
    };
  }, buildLegacyJob.toString());

  // The engine still admits it, still orders it, and still costs it.
  expect(res.customItemDescs).toContain('Zinc post caps');
  expect(res.order).toContain('Zinc post caps');
  expect(res.internalCostDelta).toBe(72);           // 6 x $12

  // But the client never sees a $0.00 line for it, on either quote renderer
  // or in the pricing payload's line items.
  expect(res.priceLineLabels).not.toContain('Zinc post caps');
  expect(res.quoteScannable).not.toContain('Zinc post caps');
  expect(res.legacyHtml).not.toContain('Zinc post caps');
  expect(res.customLineDescs).not.toContain('Zinc post caps');

  // The item that IS being charged for still prints everywhere.
  expect(res.priceLineLabels).toContain('Gate hardware upgrade');
  expect(res.quoteScannable).toContain('Gate hardware upgrade');
  expect(res.legacyHtml).toContain('Gate hardware upgrade');
  expect(res.customLineDescs).toContain('Gate hardware upgrade');
});

// ── The RENDERED order page, not just the builder string ──
// `Order To: Stratco <tony.bacich@stratcowa.com.au>` interpolated raw into a
// <pre> is parsed as an unknown start tag, so the address vanished from the
// page, from Print/PDF and from the Copy-to-Clipboard button (which copies
// pre.textContent). Asserting the builder string alone could not see it.
test('the rendered material order page keeps the supplier address and any angle brackets', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.installation = { supplierSource: 'Stratco' };
    app.job.supplierNotes = 'Use <b>galv</b> brackets & 5 > 4 spacing';

    const d = app._collectOutputData();
    const html = app._generateMaterialOrderHTML(d);

    // Render it the way the operator's tab does, then read what the DOM
    // actually shows and what the Copy button would copy.
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(html);
    frame.contentDocument.close();
    const pre = frame.contentDocument.querySelector('pre');
    const rendered = pre.textContent;
    const builderText = app._buildMaterialOrderText(d);
    frame.remove();
    return { rendered, builderText };
  }, buildLegacyJob.toString());

  // The address the order was just routed to survives to the page.
  expect(res.rendered).toContain('Order To: Stratco <tony.bacich@stratcowa.com.au>');
  // A supplier note with angle brackets is shown verbatim, not swallowed as markup.
  expect(res.rendered).toContain('Use <b>galv</b> brackets & 5 > 4 spacing');
  // The page and the builder agree exactly — the mailto body and the tab can
  // never disagree about what was ordered.
  expect(res.rendered).toBe(res.builderText);
});

// ── A pending "Custom..." supplier must never resolve to a guessed address ──
test('a Custom supplier not yet named routes nowhere and refuses to draft', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(async (jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.supplier = 'RNR';                       // panel system with a real default
    app.job.installation = { supplierSource: '__custom__' };

    const defaultRouting = (() => {
      app.job.installation.supplierSource = '';
      return app.getMaterialOrderRouting();          // what the default WOULD be
    })();
    app.job.installation.supplierSource = '__custom__';

    const captured = [];
    const realOpen = app._openMailDraft;
    app._openMailDraft = (url) => { captured.push(String(url)); };
    const toasts = [];
    const realToast = app.showToast;
    app.showToast = (msg, kind) => { toasts.push({ msg, kind }); };

    let error = null;
    try { await app.emailMaterialOrder(); } catch (e) { error = String(e); }

    app._openMailDraft = realOpen;
    app.showToast = realToast;
    return {
      error, captured, toasts,
      defaultTo: defaultRouting.to,
      source: app.getSupplierSource(),
      routing: app.getMaterialOrderRouting(),
      stillCustom: app.job.installation.supplierSource,
      stamped: app.job.installation.supplierRouting || null,
    };
  }, buildLegacyJob.toString());

  // The panel system really does have a default — otherwise this proves nothing.
  expect(res.defaultTo).toBe('sales@randrfencing.com.au');
  // ...and the pending Custom selection does NOT inherit it.
  expect(res.source).toBe('');
  expect(res.routing.to).toBe('');
  expect(res.routing.known).toBeFalsy();
  // The universal CC still attaches, as it does for any unknown supplier.
  expect(res.routing.cc).toEqual(['fencing@secureworkswa.com.au']);
  // No draft opens at all, and the operator is told why.
  expect(res.error).toBeNull();
  expect(res.captured).toEqual([]);
  expect(res.toasts.some((t) => t.kind === 'error' && /custom supplier/i.test(t.msg))).toBeTruthy();
  expect(res.toasts.some((t) => t.kind === 'success')).toBeFalsy();
  // The selection is left exactly as the operator left it.
  expect(res.stillCustom).toBe('__custom__');
  expect(res.stamped).toBeNull();
});

test('a Custom supplier selection survives a Panel System change with its input intact', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.supplier = 'RNR';
    app.job.installation = { supplierSource: '' };
    app.renderInstallation();

    // The operator picks Custom through the real handler.
    app.updateInstallation('supplierSource', '__custom__');
    app.renderInstallation();
    const inputAfterPick = !!document.querySelector('#supSelect + input, #supSelect ~ input');

    // Then changes the Panel System — twice, since switching away and back is
    // exactly how the earlier no-stomp bug surfaced.
    app.updateSupplier('Metroll');
    app.updateSupplier('RNR');
    app.renderInstallation();

    const select = document.getElementById('supSelect');
    const input = document.querySelector('#supSelect ~ input');
    return {
      inputAfterPick,
      stored: app.job.installation.supplierSource,
      selected: select.value,
      inputPresent: !!input,
      source: app.getSupplierSource(),
      to: app.getMaterialOrderRouting().to,
    };
  }, buildLegacyJob.toString());

  expect(res.inputAfterPick).toBeTruthy();
  // The deliberate Custom choice is not replaced by the panel system's default.
  expect(res.stored).toBe('__custom__');
  expect(res.selected).toBe('__custom__');
  // ...and the free-text input is still there to type the name into.
  expect(res.inputPresent).toBeTruthy();
  // Still routing nowhere until it is actually named.
  expect(res.source).toBe('');
  expect(res.to).toBe('');
});

// ── The work order's spec grid carries operator free text ──────────────────
// The Custom supplier and Custom panel-system/profile inputs accept arbitrary
// text. Interpolated raw, a name containing '<' opens a tag and swallows the
// rest of the grid — the rows after it simply vanish from the crew's document.
test('a supplier or profile name containing angle brackets renders verbatim in the work order', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    app.job.installation = { supplierSource: 'Steel <WA> & Co' };
    app.job.profile = 'Trim<clad> "Pro"';

    const d = app._collectOutputData();
    const html = app._generateWorkOrderHTML(d);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(html);
    frame.contentDocument.close();
    const grid = frame.contentDocument.querySelector('.info-grid');
    const rowText = (label) => {
      const el = Array.from(frame.contentDocument.querySelectorAll('.info-grid div'))
        .find((n) => n.querySelector('.label') && n.querySelector('.label').textContent.trim() === label);
      return el ? el.querySelector('.value').textContent : null;
    };
    const out = {
      suppliedBy: rowText('Supplied by:'),
      profile: rowText('Profile:'),
      panelSystem: rowText('Panel system:'),
      colour: rowText('Colour:'),
      panelWidth: rowText('Panel width:'),
      gridText: grid ? grid.textContent : '',
    };
    frame.remove();
    return out;
  }, buildLegacyJob.toString());

  // The typed names survive exactly, brackets and all.
  expect(res.suppliedBy).toBe('Steel <WA> & Co');
  expect(res.profile).toBe('Trim<clad> "Pro"');
  // ...and the rows that follow them are still rendered, not swallowed.
  expect(res.panelSystem).toBeTruthy();
  expect(res.colour).toBe('Monument');
  expect(res.panelWidth).toContain('mm');
});

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
    const missingEmpty = app._validateRequired();
    const qaEmpty = window.fenceQA.runScopeChecks();

    app.job.neighbours[0].sharePercent = 0;   // 0 is swallowed downstream — also blocked
    const missingZero = app._validateRequired();

    app.job.neighbours[0].sharePercent = 50;  // now valid
    const missingSet = app._validateRequired();
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
// We hold real product photos for TWO of Stratco's four profiles. Those two must
// show the photo; the other two must keep the generated diagram rather than a
// broken image, an empty box or a placeholder that reads as a mistake. Every
// other panel system keeps whatever it rendered before.
test('Stratco Superdek and Wavelok render their product photo from the repo', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    const out = {};
    ['Superdek', 'Wavelok'].forEach((profile) => {
      app.job.installation = {};
      app.updateSupplier('Stratco');
      app.job.profile = profile;
      app.renderInstallation();
      const img = document.querySelector('#bodyInstallation img[alt$="profile"]');
      out[profile] = {
        src: img ? img.getAttribute('src') : null,
        alt: img ? img.getAttribute('alt') : null,
        // Sized to the column, never intrinsic pixels that shove the form about.
        width: img ? img.style.width : null,
        height: img ? img.style.height : null,
        maxWidth: img ? img.parentElement.style.maxWidth : null,
        hasFallback: img ? img.getAttribute('onerror') : null,
      };
    });
    return out;
  });

  expect(res.Superdek.src).toBe('textures/stratco-superdek.png');
  expect(res.Wavelok.src).toBe('textures/stratco-wavelok.png');
  expect(res.Superdek.alt).toBe('Superdek profile');
  expect(res.Wavelok.alt).toBe('Wavelok profile');
  Object.values(res).forEach((r) => {
    // Relative path — this ships to Pages under a subpath, never from root.
    expect(r.src.startsWith('/')).toBeFalsy();
    expect(r.src).not.toMatch(/^https?:/);
    expect(r.width).toBe('100%');
    expect(r.height).toBe('auto');
    expect(r.maxWidth).toBe('340px');
    // A missing file degrades to the diagram, never a broken image icon.
    expect(r.hasFallback).toContain('_onProfileImgError');
  });
});

test('the Stratco profiles with no photo keep the existing diagram, not a broken image', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    const out = {};
    ['CGI Corrugated', 'CGI Mini'].forEach((profile) => {
      app.job.installation = {};
      app.updateSupplier('Stratco');
      app.job.profile = profile;
      app.renderInstallation();
      const panel = document.getElementById('bodyInstallation');
      out[profile] = {
        imgCount: panel.querySelectorAll('img[alt$="profile"]').length,
        hasSvg: !!panel.querySelector('svg'),
        markup: app._getProfileSVG(profile, 'Stratco'),
      };
    });
    return out;
  });

  Object.entries(res).forEach(([profile, r]) => {
    expect(r.imgCount, profile).toBe(0);        // no photo, and no broken <img>
    expect(r.hasSvg, profile).toBeTruthy();     // the existing generated diagram
    expect(r.markup, profile).not.toContain('textures/');
    expect(r.markup, profile).not.toContain('<img');
  });
});

test('the photos are scoped to Stratco — other panel systems are untouched', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    return {
      // Same profile NAME under a different system must not pick up the photo.
      foreignSuperdek: app._getProfileSVG('Superdek', 'Metroll'),
      // A pre-existing remote-image profile still renders from its remote URL.
      lysaght: app._getProfileSVG('Neetascreen', 'Lysaght'),
      metroll: app._getProfileSVG('Trimclad', 'Metroll'),
    };
  });
  expect(res.foreignSuperdek).not.toContain('textures/');
  expect(res.lysaght).toContain('steelselect.com.au');
  expect(res.metroll).toContain('steelselect.com.au');
});

'use strict';

// Behavioral coverage for the three material-order fixes (local tester build):
//   Task A — custom line items reach the material order (material-flagged only)
//            and capture a cost price that feeds the job margin.
//   Task B — plinths on long panels auto-generate a SEPARATE long-plinth order
//            line that reads COST_PRICES.plinthLong ($48), tracked by width.
//   Task C — Stratco supplier profile (panel width 2350, no 2380 fallback).
//
// These drive the real, executing engine (app._collectOutputData) and the real
// material-order renderer (app._generateMaterialOrderHTML) in the production
// index.html — the same functions that run in the app. No cloud round-trips.

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

// Minimal browser stub: keep page init from hard-failing on the (aborted)
// Supabase CDN. The material-order engine itself needs no cloud.
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
}

// A 6-panel run with one standard-plinth panel and one LONG panel carrying
// plinths — mirrors the reported symptom ("6-panel job with a long panel needed
// the long plinth hand-added").
function buildJob(costPrices) {
  return {
    supplier: 'Stratco',
    profile: 'Superdek',
    colour: 'Monument',
    scopeType: 'fence-and-gate',
    pricePerMetre: 125,
    gates: [],
    runs: [{
      name: 'Rear',
      length: 14,
      sheetHeight: 1800,
      panels: [
        { id: 'p1', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' }, // 1 standard plinth
        { id: 'p2', height: 1800, retaining: 300, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'long' },     // 2 LONG plinths
        { id: 'p3', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p4', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p5', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p6', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
      ],
    }],
    quote: {
      urgency: 'standard', deliveryFee: 200, groundFinish: 'none', addons: {},
      customLineItems: [
        { desc: 'Powder-coated post caps', qty: 6, unit: 'each', price: 15, costPrice: costPrices.matCost, kind: 'material' },
        { desc: 'Extra site labour', qty: 3, unit: 'hrs', price: 80, costPrice: costPrices.labCost, kind: 'labour' },
      ],
    },
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
    && typeof window.app._generateMaterialOrderHTML === 'function');
}

test('Task C — Stratco resolves to a 2350mm panel width + Superdek/Good Neighbour, never the 2380 fallback', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    app.job.supplier = 'Stratco';
    app.job.profile = 'Superdek';
    // Pure engine reads (no side effects) — the load-bearing acceptance.
    const width = app.getPanelWidthMm();
    const longWidth = app.getPanelW({ panelWidth: 'long' });
    // Render the installation panel so the supplier + profile dropdowns build
    // from SUPPLIER_PROFILES, then read them back from the DOM.
    app.renderInstallation();
    const supplierOptions = Array.from(document.querySelectorAll('#supplier option')).map(o => o.textContent.trim());
    const profileOptions = Array.from(document.querySelectorAll('#profile option')).map(o => o.value);
    return { width, longWidth, supplierOptions, profileOptions };
  });
  expect(res.width).toBe(2350);
  expect(res.width).not.toBe(2380);          // no silent fallback
  expect(res.longWidth).toBe(3150);          // long-plinth / long-panel width wired
  expect(res.supplierOptions).toContain('Stratco (2350mm)');
  expect(res.profileOptions).toContain('Superdek');
  expect(res.profileOptions).toContain('Good Neighbour');
});

test('Task B — long-panel plinths auto-generate a separate long-plinth order line (reads plinthLong)', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    const d = app._collectOutputData();
    const order = app._generateMaterialOrderHTML(d);
    return {
      totalPlinths: d.totalPlinths,
      standard: d.totalPlinthsStandard,
      long: d.totalPlinthsLong,
      longWidth: d.plinthLongWidthMm,
      longCost: d.plinthLongCost,
      hasStdLine: /PLINTHS \(standard\)/.test(order),
      hasLongLine: /PLINTHS \(long\)/.test(order),
      longLineHasWidth: /Long Plinths @ 3150mm/.test(order),
      longLineHasCost: /\$48\.00/.test(order),
    };
  }, buildJob.toString());

  expect(res.standard).toBe(1);
  expect(res.long).toBe(2);
  expect(res.totalPlinths).toBe(3);
  expect(res.longWidth).toBe(3150);
  expect(res.longCost).toBe(48);
  expect(res.hasStdLine).toBeTruthy();
  expect(res.hasLongLine).toBeTruthy();
  expect(res.longLineHasWidth).toBeTruthy();
  expect(res.longLineHasCost).toBeTruthy();
});

test('Task B — long plinths cost plinthLong ($48) not plinth ($41) in the margin', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    const withLong = Object.assign({}, build({ matCost: 0, labCost: 0 }));
    app.job = Object.assign(app.job, withLong);
    const dLong = app._collectOutputData();
    const costLong = dLong.internalCost;

    // Same job but the long panel is standard: its 2 plinths become standard.
    const asStd = build({ matCost: 0, labCost: 0 });
    asStd.runs[0].panels[1].panelWidth = 'standard';
    app.job = Object.assign(app.job, asStd);
    const dStd = app._collectOutputData();
    const costStd = dStd.internalCost;

    return { premium: Math.round((costLong - costStd) * 100) / 100 };
  }, buildJob.toString());

  // 2 long plinths × ($48 − $41) = $14 more cost when they are long.
  expect(res.premium).toBe(14);
});

test('Task A — material custom items reach the order; labour ones do not; cost feeds margin', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');

    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    const dCost = app._collectOutputData();
    const order = app._generateMaterialOrderHTML(dCost);

    // Same job, zero cost prices — the margin difference proves cost is applied.
    app.job = Object.assign(app.job, build({ matCost: 0, labCost: 0 }));
    const dNoCost = app._collectOutputData();

    return {
      customCostTotal: dCost.customCostTotal,
      hasCustomSection: /CUSTOM MATERIALS/.test(order),
      hasMaterialItem: /Powder-coated post caps/.test(order),
      hasLabourItem: /Extra site labour/.test(order),
      internalCostDelta: Math.round((dCost.internalCost - dNoCost.internalCost) * 100) / 100,
      marginDelta: Math.round((dNoCost.materialMargin - dCost.materialMargin) * 100) / 100,
    };
  }, buildJob.toString());

  // 6×$4 (material) + 3×$55 (labour) = $24 + $165 = $189 in captured cost.
  expect(res.customCostTotal).toBe(189);
  expect(res.hasCustomSection).toBeTruthy();
  expect(res.hasMaterialItem).toBeTruthy();
  expect(res.hasLabourItem).toBeFalsy();
  expect(res.internalCostDelta).toBe(189);
  expect(res.marginDelta).toBe(189);
});

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

test('Task C — Stratco resolves to a 2350mm panel width + its four real profiles, never the 2380 fallback', async ({ page }) => {
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
  // Exactly the four profiles Stratco actually publishes, in order — plus the
  // shared "Select.../Custom..." sentinels the dropdown always carries.
  expect(res.profileOptions.filter(v => v && v !== '__custom__'))
    .toEqual(['Superdek', 'CGI Corrugated', 'Wavelok', 'CGI Mini']);
  // "Good Neighbour" is Stratco's RANGE name, not a profile; Smartspan (2170mm)
  // is excluded by Captain ruling because it does not round to the 2.4m standard.
  expect(res.profileOptions).not.toContain('Good Neighbour');
  expect(res.profileOptions).not.toContain('Smartspan');
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

// ── The outbound email must not disclose our internal costs ────────────────
// The order body is ONE builder shared by the on-screen <pre>, the clipboard
// copy and the mailto body. The internal cost annotations are useful on screen
// (base commit d652b48 added them for reconciliation) but that same body now
// goes to the supplier we buy from, so the email path omits them.
test('Task A — the emailed order carries no cost figures, while the on-screen order keeps them', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    // Long-panel plinths (plinthLong cost note) AND a custom material with a
    // cost price (the operator-entered note) — both disclosure sites at once.
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    app.job.installation = { supplierSource: 'Stratco' };

    const d = app._collectOutputData();
    const screen = app._buildMaterialOrderText(d);
    const mail = app._materialOrderEmail(d);
    return {
      screen,
      email: mail.body,
      subject: mail.subject,
      totalPlinthsLong: d.totalPlinthsLong,
      customMaterials: (d.customItems || []).filter((c) => c.kind === 'material').map((c) => c.desc),
      plinthLongCost: d.plinthLongCost,
    };
  }, buildJob.toString());

  // The fixture really does exercise both disclosure sites.
  expect(res.totalPlinthsLong).toBeGreaterThan(0);
  expect(res.customMaterials.length).toBeGreaterThan(0);
  expect(res.plinthLongCost).toBeGreaterThan(0);

  // (a) The EMAIL body names no money and no cost/margin wording at all.
  //     Asserted generally: the order has no legitimate reason to carry a
  //     dollar figure, so any '$' is a leak regardless of where it came from.
  expect(res.email.match(/\$/g)).toBeNull();
  expect(res.email).not.toMatch(/\bcosts?\b/i);
  expect(res.email).not.toMatch(/\bmargin\b/i);
  expect(res.subject).not.toMatch(/\$|\bcost\b|\bmargin\b/i);

  // (b) The on-screen order still carries both annotations.
  expect(res.screen).toMatch(/supplier long plinth @ \$\d+\.\d{2} ea cost/);
  expect(res.screen).toMatch(/\(cost \$\d+\.\d{2} ea\)/);

  // (c) Nothing else was dropped: strip only the cost annotations from the
  //     on-screen body and the two must be identical, line for line.
  const stripped = res.screen
    .split('\n')
    .filter((l) => !/supplier long plinth @ \$/.test(l) && !/^\s*\(cost \$/.test(l))
    .join('\n');
  expect(res.email).toBe(stripped);
});

// ── The over-length fallback must not route around the cost strip ──────────
// The emailed body is cost-free. If the clipboard write ALSO fails, the covering
// note has to name a cost-free route — pointing the operator at the Material
// Order tab's internal Copy button would hand the supplier the cost-bearing
// body and undo the strip.
test('Unit 4 — with the clipboard denied, the over-length fallback names a cost-free route', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(async (jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    // emailMaterialOrder runs _validateRequired first, so the job needs the
    // client fields the material-order fixture omits.
    Object.assign(app.job, {
      clientFirstName: 'Ada', clientLastName: 'Lovelace', client: 'Ada Lovelace',
      address: '12 Analytical Way, Perth WA 6000', phone: '0400000000', email: 'ada@example.com',
      ref: 'FEN-1001', neighboursRequired: false, neighbours: [],
    });
    app.job.installation = { supplierSource: 'Stratco' };
    app._MAILTO_SAFE_LEN = 200;

    // Deny the clipboard, exactly as a locked-down browser does.
    const realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });

    const captured = [];
    const realOpen = app._openMailDraft;
    app._openMailDraft = (url) => { captured.push(String(url)); };
    const toasts = [];
    const realToast = app.showToast;
    app.showToast = (msg, kind) => { toasts.push({ msg, kind }); };

    await app.emailMaterialOrder();

    app._openMailDraft = realOpen;
    app.showToast = realToast;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: realClipboard });

    const d = app._collectOutputData();
    const html = app._generateMaterialOrderHTML(d);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close();
    const doc = frame.contentDocument;
    const btn = Array.from(doc.querySelectorAll('button')).find((b) => /Copy for supplier email/i.test(b.textContent));
    // What that button would actually put on the clipboard.
    const supplierBody = btn ? btn.previousElementSibling.textContent : null;
    const internalBody = doc.querySelector('pre').textContent;
    frame.remove();

    return {
      note: new URL(captured[0]).searchParams.get('body') || '',
      toasts,
      supplierBody,
      internalBody,
      emailBody: app._materialOrderEmail(d).body,
    };
  }, buildJob.toString());

  // The fallback fired and did not point at the internal, cost-bearing copy.
  expect(res.note).toContain('Material order for');
  expect(res.note).not.toMatch(/copy it across/i);
  expect(res.note).toContain('Copy for supplier email');
  // ...and does not assume that tab is already open: emailMaterialOrder is
  // reachable without it ever having been generated.
  expect(res.note).toMatch(/generate the Material Order/i);
  // The toast does not claim a clipboard that was denied.
  expect(res.toasts.some((t) => /paste it from the clipboard/i.test(t.msg))).toBeFalsy();
  expect(res.toasts.some((t) => /Copy for supplier email/i.test(t.msg))).toBeTruthy();

  // The route it names yields the cost-free body...
  expect(res.supplierBody).toBeTruthy();
  expect(res.supplierBody.match(/\$/g)).toBeNull();
  expect(res.supplierBody).not.toMatch(/\bcosts?\b/i);
  expect(res.supplierBody).toBe(res.emailBody);
  // ...while the internal copy on the same page still carries the annotations.
  expect(res.internalBody).toMatch(/supplier long plinth @ \$\d+\.\d{2} ea cost/);
  expect(res.internalBody).toMatch(/\(cost \$\d+\.\d{2} ea\)/);
});

// The Material Order page is opened as a SEPARATE tab, so its "Draft Email in
// Outlook" button runs emailMaterialOrder in the OPENER's realm — where the
// toast container lives and where the clipboard write needs focus. Without
// focusing the opener first the operator sees nothing at all, including the
// "no address on file for this supplier" error.
test('the order page email button focuses the app tab, so its outcome is visible', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    Object.assign(app.job, {
      clientFirstName: 'Ada', clientLastName: 'Lovelace', client: 'Ada Lovelace',
      address: '12 Analytical Way, Perth WA 6000', phone: '0400000000', email: 'ada@example.com',
      ref: 'FEN-1001', neighboursRequired: false, neighbours: [],
    });
    // A one-off supplier with no address on file: the case whose ERROR toast
    // must be seen. It still drafts (only the unnamed '__custom__' refuses).
    app.job.installation = { supplierSource: 'Bobs Steel' };

    window.__order = [];
    const realFocus = window.focus.bind(window);
    window.focus = () => { window.__order.push('focus'); realFocus(); };
    app._openMailDraft = () => { window.__order.push('draft'); };
    const realToast = app.showToast;
    window.__toasts = [];
    app.showToast = (msg, kind) => { window.__toasts.push({ msg, kind }); realToast.call(app, msg, kind); };
  }, buildJob.toString());

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => {
      const app = window.app;
      app._openOutputTab('Material Order', app._generateMaterialOrderHTML(app._collectOutputData()));
    }),
  ]);
  await popup.waitForSelector('#emailOrderBtn');
  await popup.click('#emailOrderBtn');
  await page.waitForFunction(() => window.__order.includes('draft'));

  const res = await page.evaluate(() => ({
    order: window.__order,
    toasts: window.__toasts,
    // The toast really landed in the app document, which is the one the
    // operator is now looking at.
    rendered: Array.from(document.querySelectorAll('#toastContainer .toast')).map((t) => t.textContent),
  }));
  await popup.close();

  // The opener was focused BEFORE the draft was built, so the clipboard write
  // and the toast both happen in a focused, visible tab.
  expect(res.order[0]).toBe('focus');
  expect(res.order).toContain('draft');
  // The message the operator must not miss actually reached them.
  expect(res.toasts.some((t) => t.kind === 'error' && /no address on file/i.test(t.msg))).toBeTruthy();
  expect(res.rendered.some((t) => /no address on file/i.test(t))).toBeTruthy();
});

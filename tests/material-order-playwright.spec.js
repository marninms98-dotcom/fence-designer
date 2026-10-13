'use strict';

// Behavioral coverage for the three material-order fixes (local tester build):
//   Task A — custom line items reach the material order (material-flagged only)
//            and capture a cost price that feeds the job margin; labour-flagged
//            lines carry hours and $/hr and count as LABOUR, not materials.
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

test('Task A — material custom items reach the order; labour ones do not; cost feeds margin and the right lane', async ({ page }) => {
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
      internalLabourDelta: Math.round((dCost.internalLabour - dNoCost.internalLabour) * 100) / 100,
      marginDelta: Math.round((dNoCost.materialMargin - dCost.materialMargin) * 100) / 100,
    };
  }, buildJob.toString());

  // 6×$4 (material) + 3×$55 (labour) = $24 + $165 = $189 in captured cost.
  expect(res.customCostTotal).toBe(189);
  expect(res.hasCustomSection).toBeTruthy();
  expect(res.hasMaterialItem).toBeTruthy();
  expect(res.hasLabourItem).toBeFalsy();
  // The material cost is materials; the labour line's cost is labour.
  expect(res.internalCostDelta).toBe(24);
  expect(res.internalLabourDelta).toBe(165);
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

// ── A custom item reaches a SUPPLIER only when it says so ──────────────────
// main carries no `kind` field and no CUSTOM MATERIALS block, so a custom line
// item saved before this branch could not reach a supplier by any path. A
// missing `kind` is therefore evidence the item predates the feature — and the
// old input prompted for "Extra labour, skip bin, etc.". Defaulting it to
// material emailed the panel supplier a request to supply labour.
test('a legacy custom item with no kind never reaches the supplier order', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');

    const read = () => {
      const d = app._collectOutputData();
      return {
        order: app._buildMaterialOrderText(d),
        email: app._buildMaterialOrderText(d, { forEmail: true }),
        kinds: (d.customItems || []).map((c) => ({ desc: c.desc, kind: c.kind })),
        internalCost: Math.round(d.internalCost * 100) / 100,
        customTotal: Math.round(d.customTotal * 100) / 100,
        // Client-facing rows are filtered on sell price, never on kind.
        clientRows: (app._gatherFenceQuoteData(d).priceLineItems || []).map((li) => li.label),
      };
    };

    // A job exactly as it was saved before this branch: no `kind` anywhere.
    const legacyJob = build({ matCost: 4, labCost: 55 });
    legacyJob.quote.customLineItems = [
      { desc: 'Extra site labour', qty: 3, unit: 'hrs', price: 80, costPrice: 55 },
      { desc: 'Skip bin', qty: 1, unit: 'job', price: 500, costPrice: 300 },
    ];
    app.job = Object.assign(app.job, legacyJob);
    const legacy = read();

    // The same job once an operator explicitly marks one line Material.
    app.job.quote.customLineItems[1].kind = 'material';
    const oneMarkedMaterial = read();

    // And the explicit-labour case, which never went to the order.
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    const explicit = read();

    return { legacy, oneMarkedMaterial, explicit };
  }, buildJob.toString());

  // LEGACY: nothing a panel supplier is asked to supply — no block at all,
  // which is exactly what main produces for this job.
  expect(res.legacy.kinds).toEqual([
    { desc: 'Extra site labour', kind: 'labour' },
    { desc: 'Skip bin', kind: 'labour' },
  ]);
  expect(res.legacy.order).not.toContain('CUSTOM MATERIALS');
  expect(res.legacy.order).not.toContain('Extra site labour');
  expect(res.legacy.order).not.toContain('Skip bin');
  expect(res.legacy.email).not.toContain('CUSTOM MATERIALS');
  // ...while cost and margin still see them, and the client still bills them.
  expect(res.legacy.customTotal).toBe(3 * 80 + 500);
  expect(res.legacy.internalCost).toBeGreaterThan(0);
  expect(res.legacy.clientRows).toContain('Extra site labour');
  expect(res.legacy.clientRows).toContain('Skip bin');

  // EXPLICIT material still goes to the supplier, on one tap of the existing
  // control — so the fix costs the operator nothing.
  expect(res.oneMarkedMaterial.order).toContain('CUSTOM MATERIALS');
  expect(res.oneMarkedMaterial.order).toContain('Skip bin');
  expect(res.oneMarkedMaterial.order).not.toContain('Extra site labour');

  // EXPLICIT labour is unchanged: still off the order, material still on it.
  expect(res.explicit.kinds).toEqual([
    { desc: 'Powder-coated post caps', kind: 'material' },
    { desc: 'Extra site labour', kind: 'labour' },
  ]);
  expect(res.explicit.order).toContain('Powder-coated post caps');
  expect(res.explicit.order).not.toContain('Extra site labour');
});

// The kind picker must never claim Material for an item the order treats as
// labour — the same control-lies-about-stored-state class closed elsewhere.
test('the kind picker shows what the order will actually do with the item', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobFactory + ')')({ matCost: 4, labCost: 55 });
    job.quote.customLineItems = [
      { desc: 'Extra site labour', qty: 3, unit: 'hrs', price: 80 },
      { desc: 'Post caps', qty: 6, unit: 'each', price: 15, kind: 'material' },
      { desc: 'Skip bin', qty: 1, unit: 'job', price: 500, kind: 'labour' },
    ];
    app.job = Object.assign(app.job, job);
    if (!app._openSections.quote) app.toggleSection('quote');
    app.render();

    const picked = Array.from(document.querySelectorAll('#bodyQuote select'))
      .filter((s) => Array.from(s.options).map((o) => o.value).join(',') === 'unset,material,labour')
      .map((s) => s.options[s.selectedIndex].value);

    const d = app._collectOutputData();
    return { picked, engineKinds: (d.customItems || []).map((c) => c.kind) };
  }, buildJob.toString());

  // Legacy (no kind) reads Labour, and every picker agrees with the engine.
  expect(res.picked.slice(0, 3)).toEqual(['labour', 'material', 'labour']);
  expect(res.engineKinds).toEqual(res.picked.slice(0, 3));
});

// The legacy rule ("no kind means labour") only holds if a slot the app itself
// created carries an explicit kind. A fresh job seeds three custom-item slots,
// and they start UNCLASSIFIED: a silent default once sent labour ("Root
// removal, 2 hrs") to the panel supplier and counted it as materials. An
// operator who fills a slot without choosing must be stopped, never defaulted
// — the material order is blocked rather than silently short a material.
test('a fresh custom slot must be marked Labour or Material before any output', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    const job = build({ matCost: 4, labCost: 55 });
    Object.assign(job, { clientFirstName: 'Pat', clientLastName: 'Lee', address: '1 Test St', phone: '0400000000', neighboursRequired: false });
    // Keep the slots app.init() created for this fresh job; the fixture's own
    // explicitly-kinded items would hide the default entirely.
    const freshSlots = app.job.quote.customLineItems;
    app.job = Object.assign(app.job, job);
    app.job.quote.customLineItems = freshSlots;
    app.job.installation = { supplierSource: 'Stratco' };
    const blankKinds = freshSlots.map((c) => c.kind);
    const blankProblems = app._validateRequired();

    // The operator fills slot 1 through the real input path and never opens
    // the kind picker.
    app.updateCustomItem(0, 'desc', 'Powder-coated post caps');
    app.updateCustomItem(0, 'qty', '6');
    app.updateCustomItem(0, 'unit', 'each');
    app.updateCustomItem(0, 'price', '15');
    // ...and adds a fourth row with the + button, filling that one too.
    app.addCustomItem();
    app.updateCustomItem(3, 'desc', 'Gate drop bolt');
    app.updateCustomItem(3, 'qty', '1');
    app.updateCustomItem(3, 'unit', 'each');
    app.updateCustomItem(3, 'price', '40');

    if (!app._openSections.quote) app.toggleSection('quote');
    app.render();
    const pickedBefore = Array.from(document.querySelectorAll('#bodyQuote select'))
      .filter((s) => Array.from(s.options).map((o) => o.value).join(',') === 'unset,material,labour')
      .map((s) => s.options[s.selectedIndex].value);

    const dBefore = app._collectOutputData();
    const orderBefore = app._buildMaterialOrderText(dBefore);
    const missingBefore = app._validateRequired();
    const qaBefore = window.fenceQA.runScopeChecks().filter((f) => f.severity === 'red').map((f) => f.message);
    const toasts = [];
    const realToast = app.showToast;
    app.showToast = (msg, kind) => { toasts.push({ msg, kind }); };
    let opened = 0;
    const realOpen = app._openOutputTab;
    app._openOutputTab = () => { opened += 1; };
    app.generateMaterialOrder();
    app.generateWorkOrder();
    app.showToast = realToast;

    // One tap each on the picker, and both are ordered.
    app.updateCustomItem(0, 'kind', 'material');
    app.updateCustomItem(3, 'kind', 'material');
    const d = app._collectOutputData();
    const order = app._buildMaterialOrderText(d);
    const email = app._materialOrderEmail(d).body;
    const missingAfter = app._validateRequired();
    app.generateMaterialOrder();
    app._openOutputTab = realOpen;

    // The same job as it would have been SAVED before this branch: the slot
    // carries no kind at all.
    const legacy = JSON.parse(JSON.stringify(app.job));
    legacy.quote.customLineItems = legacy.quote.customLineItems.map((c) => {
      const copy = Object.assign({}, c);
      delete copy.kind;
      return copy;
    });
    app.job = legacy;
    const legacyOrder = app._buildMaterialOrderText(app._collectOutputData());

    return {
      blankKinds, blankProblems,
      pickedBefore: pickedBefore.slice(0, 4),
      kindsBefore: (dBefore.customItems || []).map((c) => ({ desc: c.desc, kind: c.kind })),
      orderBefore, missingBefore, qaBefore, toasts, opened,
      kinds: (d.customItems || []).map((c) => ({ desc: c.desc, kind: c.kind })),
      order, email, missingAfter, legacyOrder,
    };
  }, buildJob.toString());

  // Fresh slots are explicitly unclassified, and an empty slot asks nothing.
  expect(res.blankKinds).toEqual(['unset', 'unset', 'unset']);
  expect(res.blankProblems.filter((m) => /Custom line/.test(m))).toEqual([]);

  // (a) Filled but never classified: not ordered, and every output door stops.
  expect(res.pickedBefore).toEqual(['unset', 'unset', 'unset', 'unset']);
  expect(res.kindsBefore).toEqual([
    { desc: 'Powder-coated post caps', kind: 'unset' },
    { desc: 'Gate drop bolt', kind: 'unset' },
  ]);
  expect(res.orderBefore).not.toContain('Powder-coated post caps');
  expect(res.missingBefore).toContain('Custom line 1 (Powder-coated post caps): choose Labour or Material');
  expect(res.missingBefore).toContain('Custom line 4 (Gate drop bolt): choose Labour or Material');
  expect(res.qaBefore).toContain('Custom line 1 (Powder-coated post caps): choose Labour or Material');
  expect(res.toasts.filter((t) => t.kind === 'error').length).toBe(2);

  // (b) Once marked Material, both reach the order and the email.
  expect(res.kinds).toEqual([
    { desc: 'Powder-coated post caps', kind: 'material' },
    { desc: 'Gate drop bolt', kind: 'material' },
  ]);
  expect(res.missingAfter.filter((m) => /Custom line/.test(m))).toEqual([]);
  expect(res.opened).toBe(1);
  expect(res.order).toContain('CUSTOM MATERIALS');
  expect(res.order).toContain('Powder-coated post caps');
  expect(res.order).toContain('Gate drop bolt');
  expect(res.email).toContain('Powder-coated post caps');
  expect(res.email).toContain('Gate drop bolt');

  // (c) The legacy half still holds: strip the kind and the same items drop
  // off the supplier order.
  expect(res.legacyOrder).not.toContain('CUSTOM MATERIALS');
  expect(res.legacyOrder).not.toContain('Powder-coated post caps');
  expect(res.legacyOrder).not.toContain('Gate drop bolt');
});

// "Root removal — 1 job" tells a trade nothing about time. A labour line
// carries its hours and cost per hour; its cost is LABOUR, it never reaches the
// supplier, and the hours ride pricing_json so a work order can be built.
function labourJob() {
  return {
    clientFirstName: 'Pat', clientLastName: 'Lee', address: '1 Test St', phone: '0400000000',
    neighboursRequired: false,
    supplier: 'Stratco', profile: 'Superdek', colour: 'Monument', scopeType: 'fence-and-gate',
    pricePerMetre: 125,
    installation: { supplierSource: 'Stratco' },
    gatesRequired: true,
    gates: [{ id: 'g1', type: 'pedestrian', width: 900 }, { id: 'g2', type: 'double', width: 3000 }],
    runs: [{
      name: 'Rear', length: 10, sheetHeight: 1800,
      panels: [
        { id: 'p1', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p2', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p3', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p4', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
      ],
    }],
    quote: {
      urgency: 'standard', deliveryFee: 200, groundFinish: 'none', addons: {},
      customLineItems: [
        { desc: 'Root removal', qty: 1, unit: 'job', price: 260, kind: 'labour', hours: 2, costPerHour: 80 },
        { desc: 'Hard digging', qty: 3, unit: 'hrs', price: 130, kind: 'labour', costPerHour: 45 },
        { desc: 'Post caps', qty: 6, unit: 'each', price: 15, costPrice: 4, kind: 'material' },
        { desc: 'Spoil haul (absorbed)', qty: 1, unit: 'job', price: 0, kind: 'labour', hours: 1.5, costPerHour: 60 },
      ],
    },
  };
}

test('a labour line carries hours and $/hr into the labour figure, the work order and pricing_json', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobFactory + ')')());
    const d = app._collectOutputData();
    const pj = app.buildPricingJson();
    const order = app._buildMaterialOrderText(d);
    const wo = app._generateWorkOrderHTML(d);

    // The same job with no custom lines, for the labour delta.
    const bare = JSON.parse(JSON.stringify(app.job));
    bare.quote.customLineItems = [];
    app.job = bare;
    const d0 = app._collectOutputData();

    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      labourDelta: r2(d.internalLabour - d0.internalLabour),
      costDelta: r2(d.internalCost - d0.internalCost),
      subtotalDelta: r2(d.subtotal - d0.subtotal),
      order,
      wo,
      custom: pj.line_items.filter((li) => li.category === 'custom'),
      labourLines: pj.internal.labour_lines,
      labourLinesSum: r2(pj.internal.labour_lines.reduce((s, l) => s + l.total_cost, 0)),
      internalLabour: r2(pj.internal.labour),
      labourCostEstimate: r2(pj.labourCostEstimate),
    };
  }, labourJob.toString());

  // 2h × $80 + 3h × $45 + 1.5h × $60 = $160 + $135 + $90 = $385 of labour;
  // only the $24 of post caps is materials. Sell is untouched by kind.
  expect(res.labourDelta).toBe(385);
  expect(res.costDelta).toBe(24);
  expect(res.subtotalDelta).toBe(260 + 390 + 90);

  // Labour never reaches the supplier.
  expect(res.order).toContain('Post caps');
  expect(res.order).not.toContain('Root removal');
  expect(res.order).not.toContain('Hard digging');
  expect(res.order).not.toContain('Spoil haul');

  // The work order says how long each extra takes.
  expect(res.wo).toContain('Root removal (1 job, 2 hrs)');
  expect(res.wo).toContain('Hard digging (3 hrs)');
  expect(res.wo).toContain('Spoil haul (absorbed) (1 job, 1.5 hrs)');

  // pricing_json.line_items: sellable custom lines with kind, hours, $/hr.
  expect(res.custom).toEqual([
    expect.objectContaining({ description: 'Root removal', quantity: 1, unit: 'job', kind: 'labour', hours: 2, cost_per_hour: 80, total_cost: 160, cost_price: 160, total_sell: 260 }),
    expect.objectContaining({ description: 'Hard digging', quantity: 3, unit: 'hrs', kind: 'labour', hours: 3, cost_per_hour: 45, total_cost: 135, cost_price: 45 }),
    expect.objectContaining({ description: 'Post caps', kind: 'material', total_cost: 24, cost_price: 4 }),
  ]);
  expect(res.custom[2]).not.toHaveProperty('hours');

  // internal.labour_lines is the whole labour cost table, reconciling to the
  // labour figure, including the cost-only labour line the client never sees.
  expect(res.labourLinesSum).toBe(res.internalLabour);
  expect(res.labourCostEstimate).toBe(res.internalLabour);
  expect(res.labourLines.map((l) => l.source)).toEqual(['base', 'plinth', 'gate', 'gate', 'custom', 'custom', 'custom']);
  expect(res.labourLines[res.labourLines.length - 1]).toEqual(expect.objectContaining({ task: 'Spoil haul (absorbed)', hours: 1.5, cost_per_hour: 60, total_cost: 90 }));
});

test('a labour line without hours blocks the quote and send, but not the material or work order', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobFactory + ')')();
    job.quote.customLineItems = [{ desc: 'Root removal', qty: 1, unit: 'job', price: 260, kind: 'labour' }, { kind: 'unset' }, { kind: 'unset' }];
    app.job = Object.assign(app.job, job);
    if (!app._openSections.quote) app.toggleSection('quote');
    app.render();
    const hoursInputs = Array.from(document.querySelectorAll('#bodyQuote input[placeholder="Total hrs"]')).length;
    const out = {
      hoursInputs,
      bare: app._validateRequired().filter((m) => /Custom line/.test(m)),
      forQuote: app._validateRequired({ forQuote: true }).filter((m) => /Custom line/.test(m)),
      qa: window.fenceQA.runScopeChecks().filter((f) => f.severity === 'red' && /Custom line/.test(f.message)).map((f) => f.message),
    };
    app.updateCustomItem(0, 'hours', '2');
    app.updateCustomItem(0, 'costPerHour', '80');
    out.forQuoteAfter = app._validateRequired({ forQuote: true }).filter((m) => /Custom line/.test(m));
    // An 'hrs' line takes its hours from the quantity, so asks for no extra field.
    app.updateCustomItem(0, 'unit', 'hrs');
    out.hoursInputsOnHrs = Array.from(document.querySelectorAll('#bodyQuote input[placeholder="Total hrs"]')).length;
    return out;
  }, labourJob.toString());

  expect(res.hoursInputs).toBe(1);
  expect(res.bare).toEqual([]);
  expect(res.forQuote).toEqual([
    'Custom line 1 (Root removal): hours for this labour',
    'Custom line 1 (Root removal): labour cost per hour',
  ]);
  expect(res.qa).toEqual(res.forQuote);
  expect(res.forQuoteAfter).toEqual([]);
  expect(res.hoursInputsOnHrs).toBe(0);
});

// The Labour PO card used to add plinth and gate labour to a total that
// already contained them.
test('the Labour PO card totals the labour figure once, and its rows add up to it', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobFactory + ')')();
    job.removal = { removalRequired: false, access: 'moderate' };
    app.job = Object.assign(app.job, job);
    app.renderQuoteAndOrders();
    const d = app._collectOutputData();
    const card = Array.from(document.querySelectorAll('#bodyQuoteOrders .po-card'))
      .find((c) => /Draft Labour Purchase Order/.test(c.textContent));
    const money = (t) => Number(String(t).replace(/[^0-9.]/g, ''));
    const rows = Array.from(card.querySelectorAll('tbody tr'));
    const total = rows.find((r) => r.classList.contains('po-total'));
    return {
      internalLabour: Math.round(d.internalLabour * 100) / 100,
      accessRate: d.accessRate,
      total: money(total.querySelector('.r').textContent),
      rowSum: Math.round(rows.filter((r) => r !== total).reduce((s, r) => s + money(r.querySelector('.r').textContent), 0) * 100) / 100,
      text: card.textContent,
    };
  }, labourJob.toString());

  expect(res.total).toBe(res.internalLabour);
  expect(res.rowSum).toBe(res.internalLabour);
  expect(res.text).toContain('Root removal (2 hrs');
  expect(res.text).toContain('Pedestrian gate 1 install');
});

// A job saved before labour lines carried hours prices and costs exactly as it
// did: a labour line keeps qty × cost/ea, and a job with no custom labour has
// the identical labour figure.
test('a quote saved before hours existed loads and prices exactly as before', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobFactory + ')')();
    job.quote.customLineItems = [
      { desc: 'Root removal', qty: 1, unit: 'job', price: 260, costPrice: 250 },
      { desc: 'Hard digging', qty: 2, unit: 'hrs', price: 130, costPrice: 80, kind: 'material' },
      { desc: 'Extra labour', qty: 3, unit: 'hrs', price: 80, costPrice: 55, kind: 'labour' },
    ];
    app.job = Object.assign(app.job, job);
    const before = JSON.stringify(app.job.quote.customLineItems);
    const d = app._collectOutputData();
    const noCustom = JSON.parse(JSON.stringify(app.job));
    noCustom.quote.customLineItems = [];
    app.job = noCustom;
    const d0 = app._collectOutputData();
    // The pre-change labour formula, verbatim.
    const plinth = d0.totalPlinths * 10;
    const gates = 250 + 500;
    const oldLabour = (d0.totalMetres * 35 + plinth + gates) * (1 + d0.accessRate);
    return {
      untouched: before === JSON.stringify(job.quote.customLineItems),
      subtotal: d.subtotal, customTotal: d.customTotal,
      customCostTotal: d.customCostTotal,
      totalCost: Math.round((d.internalCost + d.internalLabour) * 100) / 100,
      totalCost0: Math.round((d0.internalCost + d0.internalLabour) * 100) / 100,
      labourMove: Math.round((d.internalLabour - d0.internalLabour) * 100) / 100,
      kinds: d.customItems.map((c) => c.kind),
      sameLabour: d0.internalLabour === oldLabour,
    };
  }, labourJob.toString());

  expect(res.untouched).toBe(true);
  expect(res.customTotal).toBe(260 + 260 + 240);
  // Every line costs what it did: 250 + 160 + 165.
  expect(res.customCostTotal).toBe(575);
  expect(Math.round((res.totalCost - res.totalCost0) * 100) / 100).toBe(575);
  // Only the labour lines' cost moved into the labour lane; the material
  // (even one that reads like labour) stays materials until someone re-marks it.
  expect(res.kinds).toEqual(['labour', 'material', 'labour']);
  expect(res.labourMove).toBe(250 + 165);
  expect(res.sameLabour).toBe(true);
});

// Two clipboard buttons sit side by side on the Material Order page and copy
// different bodies. The cost-bearing one must say so, or an operator drafting
// a supplier email presses the wrong one and pastes our costs to the vendor.
test('the material order page marks which copy button carries internal cost', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobFactory) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const build = eval('(' + jobFactory + ')');
    app.job = Object.assign(app.job, build({ matCost: 4, labCost: 55 }));
    app.job.installation = { supplierSource: 'Stratco' };

    const html = app._generateMaterialOrderHTML(app._collectOutputData());
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close();
    const buttons = Array.from(frame.contentDocument.querySelectorAll('button'))
      .filter((b) => /clipboard\.writeText/.test(b.getAttribute('onclick') || ''))
      .map((b) => ({
        label: b.textContent.trim(),
        // What that button would actually put on the clipboard.
        body: b.previousElementSibling.textContent,
      }));
    frame.remove();
    return { buttons };
  }, buildJob.toString());

  expect(res.buttons).toHaveLength(2);
  const carriesCost = (b) => /ea cost\)|\(cost \$/.test(b.body);
  const internal = res.buttons.filter(carriesCost);
  const supplier = res.buttons.filter((b) => !carriesCost(b));
  expect(internal).toHaveLength(1);
  expect(supplier).toHaveLength(1);
  // The cost-bearing button names its scope; the supplier one names its use.
  expect(internal[0].label).toMatch(/internal/i);
  expect(internal[0].label).toMatch(/cost/i);
  expect(supplier[0].label).toBe('Copy for supplier email');
});

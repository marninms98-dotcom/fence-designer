'use strict';

// Behavioral coverage for per-component fence colours (sheets / rails / posts /
// plinths). The rules being pinned:
//   • job.colour IS the sheet colour and is not rewired; rails/posts/plinths are
//     additive optional overrides that default to following it.
//   • A job where everything matches must behave EXACTLY as it did before — same
//     material order text, same quote, same totals, and none of the new fields
//     written to the job.
//   • Components of different colours are different stock, so they must never be
//     merged onto one material-order line.
//   • Rails and posts are usually the same but are independently selectable.
//   • Job level is the default a run inherits; a run can override it.
//   • Colour NEVER moves a total (Captain: "nah").
//
// These drive the real engine (app._collectOutputData), the real material-order
// renderer and the real quote gatherer in the production index.html.

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
}

// A job in EXACTLY the shape it had before per-component colours existed: one
// job-level `colour`, no `componentColours`, and runs with no `colours`. Two
// runs and a long panel, so grouping and plinth splitting have something to do.
function buildPreChangeJob() {
  const panels = (n, opts) => Array.from({ length: n }, (_, i) => Object.assign({
    id: 'p' + i, height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard',
  }, opts && opts[i] ? opts[i] : {}));
  return {
    clientFirstName: 'Ada', clientLastName: 'Lovelace', client: 'Ada Lovelace',
    address: '12 Analytical Way, Perth WA 6000', phone: '0400000000', email: 'ada@example.com',
    ref: 'FEN-2001',
    supplier: 'Metroll', profile: 'Trimclad',
    colour: 'Monument',
    scopeType: 'fence-and-gate', pricePerMetre: 125, gates: [],
    neighboursRequired: false, neighbours: [],
    installation: { supplierSource: 'Fencing Warehouse' },
    runs: [
      {
        id: 'run-a', name: 'Rear', length: 12, sheetHeight: 1800,
        panels: panels(4, { 0: { retaining: 150 }, 1: { panelWidth: 'long', retaining: 300 } }),
      },
      {
        id: 'run-b', name: 'Left', length: 9, sheetHeight: 1800,
        panels: panels(3, { 0: { retaining: 150 } }),
      },
    ],
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
  await page.waitForFunction(() => window.app && typeof window.app.getRunColourSet === 'function');
}

// Load the pre-change job, optionally mutate it, and return everything the
// downstream surfaces produce so two variants can be compared exactly.
function snapshotFactory() {
  return function snapshot(mutate) {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + window.__buildJob + ')')();
    if (mutate) mutate(app, job);
    app.job = Object.assign(app.job, job);
    const raw = app._collectOutputData();
    const quote = app._gatherFenceQuoteData(raw);
    return {
      order: app._buildMaterialOrderText(raw),
      workOrder: app._generateWorkOrderHTML(raw),
      specs: quote.specs,
      colourBreakdown: quote.colourBreakdown,
      grandTotal: Math.round(raw.grandTotal * 100) / 100,
      subtotal: Math.round(raw.subtotal * 100) / 100,
      internalCost: Math.round(raw.internalCost * 100) / 100,
      totalPanels: raw.totalPanels,
      totalPlinths: raw.totalPlinths,
      totalPlinthsStandard: raw.totalPlinthsStandard,
      totalPlinthsLong: raw.totalPlinthsLong,
      postGroupCount: Object.keys(raw.postGroups).length,
      postGroups: Object.values(raw.postGroups).map((g) => ({
        count: g.count, sheetH: g.sheetH, postH: g.postH, panelW: g.panelW,
        sheets: g.sheetColour, rails: g.railColour, posts: g.postColour,
      })),
      plinthGroups: Object.values(raw.plinthGroups || {}),
      componentColours: raw.componentColours,
      jobHasComponentColours: !!app.job.componentColours,
      runsHaveColours: (app.job.runs || []).map((r) => !!r.colours),
    };
  };
}

async function withApp(page, fn) {
  await page.evaluate((src) => { window.__buildJob = src; }, buildPreChangeJob.toString());
  await page.evaluate((src) => { window.__snapshot = eval('(' + src + ')')(); }, snapshotFactory.toString());
  return page.evaluate(fn);
}

test('a pre-change saved job opens, renders, orders and prices identically', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => {
    const base = window.__snapshot(null);
    return {
      base,
      // The resolver must not invent fields on a job that never had them.
      resolved: window.app.getRunColourSet(window.app.job.runs[0]),
    };
  });

  const b = res.base;
  // Nothing new written to the job.
  expect(b.jobHasComponentColours).toBeFalsy();
  expect(b.runsHaveColours).toEqual([false, false]);
  // Everything resolves to the one job colour, and the job reads as uniform.
  expect(res.resolved).toEqual({ sheets: 'Monument', rails: 'Monument', posts: 'Monument', plinths: 'Monument', uniform: true });
  expect(b.componentColours.uniform).toBeTruthy();
  // The order still prints the single `Colour:` line it always did — no
  // Sheets/Rails/Posts expansion, and no colour-split duplicate lines.
  expect(b.order).toContain('    Colour: Monument');
  expect(b.order).not.toContain('    Sheets:');
  expect(b.order).not.toContain('    Rails:');
  expect((b.order.match(/PLINTHS \(standard\)/g) || []).length).toBe(1);
  expect((b.order.match(/PLINTHS \(long\)/g) || []).length).toBe(1);
  expect(b.order).toContain('150mm Plinths @ 2365mm — Monument');
  expect(b.order).toContain('150mm Long Plinths @ 3150mm — Monument');
  // The quote reads exactly as before: one Colour row, no Trim Colours row.
  expect(b.colourBreakdown).toBe('');
  expect(b.specs).toContainEqual(['Colour', 'COLORBOND® Monument']);
  expect(b.specs.map((s) => s[0])).not.toContain('Trim Colours');
  // The work order keeps its single Colour row.
  expect(b.workOrder).toContain('<span class="label">Colour:</span> <span class="value">Monument</span>');
  expect(b.grandTotal).toBeGreaterThan(0);
});

test('rails and posts differing from the sheets split the material order lines', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => {
    const before = window.__snapshot(null);
    const after = window.__snapshot((app, job) => {
      job.componentColours = { rails: 'Surfmist', posts: 'Surfmist' };
    });
    return { before, after };
  });

  const a = res.after;
  // Same panels, same grouping count — a colour applied job-wide splits nothing.
  expect(a.totalPanels).toBe(res.before.totalPanels);
  expect(a.postGroupCount).toBe(res.before.postGroupCount);
  // But every panel line now names its three components separately.
  a.postGroups.forEach((g) => {
    expect(g.sheets).toBe('Monument');
    expect(g.rails).toBe('Surfmist');
    expect(g.posts).toBe('Surfmist');
  });
  expect(a.order).toContain('    Sheets: Monument');
  expect(a.order).toContain('    Rails: Surfmist');
  expect(a.order).toContain('    Posts: Surfmist');
  // The collapsed single-colour form must be gone, or we order the wrong stock.
  expect(a.order).not.toContain('    Colour: Monument');
  // Plinths were not overridden, so they still follow the sheets.
  expect(a.order).toContain('150mm Plinths @ 2365mm — Monument');
  // The quote states it, once.
  expect(a.colourBreakdown).toBe('Rails Surfmist · Posts Surfmist');
  expect(a.specs).toContainEqual(['Colour', 'COLORBOND® Monument (sheets)']);
  expect(a.specs).toContainEqual(['Trim Colours', 'Rails Surfmist · Posts Surfmist']);
});

test('rails and posts can differ from EACH OTHER, not just from the sheets', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => window.__snapshot((app, job) => {
    job.componentColours = { rails: 'Surfmist', posts: 'Basalt' };
  }));

  res.postGroups.forEach((g) => {
    expect(g.sheets).toBe('Monument');
    expect(g.rails).toBe('Surfmist');
    expect(g.posts).toBe('Basalt');
  });
  expect(res.order).toContain('    Sheets: Monument');
  expect(res.order).toContain('    Rails: Surfmist');
  expect(res.order).toContain('    Posts: Basalt');
  expect(res.colourBreakdown).toBe('Rails Surfmist · Posts Basalt');
});

test('a plinth colour override splits the plinth order lines by colour', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => window.__snapshot((app, job) => {
    job.componentColours = { plinths: 'Surfmist' };
  }));

  // Panels are untouched: only the plinths moved.
  expect(res.order).toContain('    Colour: Monument');
  expect(res.order).not.toContain('    Sheets:');
  // Both plinth lines now name the plinth colour, not the sheet colour.
  expect(res.order).toContain('150mm Plinths @ 2365mm — Surfmist');
  expect(res.order).toContain('150mm Long Plinths @ 3150mm — Surfmist');
  expect(res.order).not.toContain('Plinths @ 2365mm — Monument');
  expect(res.plinthGroups.every((g) => g.colour === 'Surfmist')).toBeTruthy();
  expect(res.colourBreakdown).toBe('Plinths Surfmist');
});

test('a per-run override beats the job default and splits the order by run', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => window.__snapshot((app, job) => {
    // Job-wide trim, then ONE run in an entirely different sheet colour.
    job.componentColours = { rails: 'Surfmist', posts: 'Surfmist' };
    job.runs[1].colours = { sheets: 'Basalt', plinths: 'Basalt' };
  }));

  const byColour = {};
  res.postGroups.forEach((g) => { byColour[g.sheets] = (byColour[g.sheets] || 0) + g.count; });
  // Run A's 4 panels stay Monument; run B's 3 panels are Basalt — split, never merged.
  expect(byColour.Monument).toBe(4);
  expect(byColour.Basalt).toBe(3);
  // An EXPLICIT job-level rail colour is not dragged away by a run's sheet
  // override: the run still gets the rails the operator deliberately chose.
  res.postGroups.forEach((g) => {
    expect(g.rails).toBe('Surfmist');
    expect(g.posts).toBe('Surfmist');
  });
  expect(res.order).toContain('    Sheets: Monument');
  expect(res.order).toContain('    Sheets: Basalt');
  // Plinths: run A follows the sheets (Monument), run B is explicitly Basalt.
  const plinthColours = res.plinthGroups.map((g) => g.colour).sort();
  expect(plinthColours).toContain('Monument');
  expect(plinthColours).toContain('Basalt');
  expect((res.order.match(/PLINTHS \(standard\)/g) || []).length).toBe(2);
  // The quote reports both sheet colours.
  expect(res.componentColours.sheets.sort()).toEqual(['Basalt', 'Monument']);
  // And RENDERS both on the Colour row. Asserting the raw array is not enough:
  // the row is what the client reads, and it must not name one colour while the
  // order buys two. Rails/posts still differ, so the row keeps its (sheets) tag
  // and the Trim Colours row still appears.
  expect(res.specs).toContainEqual(['Colour', 'COLORBOND® Monument / Basalt (sheets)']);
  expect(res.specs).toContainEqual(['Trim Colours', 'Rails Surfmist · Posts Surfmist']);
});

// The exact leak: only the SHEETS are overridden on one run. Every trim list
// then equals the sheet list, so the Trim Colours breakdown is legitimately
// empty — which used to leave the Colour row naming the job colour alone while
// the material order bought two.
test('a per-run SHEET override alone is still named on the quote Colour row', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => window.__snapshot((app, job) => {
    job.runs[1].colours = { sheets: 'Basalt' };
  }));

  // The order genuinely buys both.
  expect(res.order).toContain('    Colour: Monument');
  expect(res.order).toContain('    Colour: Basalt');
  // Nothing differs from the sheets, so there is no Trim Colours row...
  expect(res.colourBreakdown).toBe('');
  expect(res.specs.map((s) => s[0])).not.toContain('Trim Colours');
  // ...but the Colour row itself must name both, with no misleading "(sheets)"
  // qualifier pointing at a breakdown that is not there.
  expect(res.specs).toContainEqual(['Colour', 'COLORBOND® Monument / Basalt']);
  expect(res.specs).not.toContainEqual(['Colour', 'COLORBOND® Monument']);
});

test('a run override can be applied and then cleared back to the job colours', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + window.__buildJob + ')')());
    app.updateRunColour('run-b', 'sheets', 'Basalt');
    const overridden = {
      stored: JSON.parse(JSON.stringify(app.job.runs[1].colours)),
      hasOverride: app.runHasColourOverride(app.job.runs[1]),
      resolved: app.getRunColourSet(app.job.runs[1]).sheets,
      otherRun: app.getRunColourSet(app.job.runs[0]).sheets,
    };
    app.clearRunColours('run-b');
    return {
      overridden,
      clearedField: app.job.runs[1].colours,
      clearedResolved: app.getRunColourSet(app.job.runs[1]).sheets,
      clearedHasOverride: app.runHasColourOverride(app.job.runs[1]),
    };
  });

  expect(res.overridden.stored).toEqual({ sheets: 'Basalt' });
  expect(res.overridden.hasOverride).toBeTruthy();
  expect(res.overridden.resolved).toBe('Basalt');
  // The override is scoped to its own run.
  expect(res.overridden.otherRun).toBe('Monument');
  // Clearing DELETES the field, so the run is indistinguishable from untouched.
  expect(res.clearedField).toBeUndefined();
  expect(res.clearedHasOverride).toBeFalsy();
  expect(res.clearedResolved).toBe('Monument');
});

test('colour never moves a total', async ({ page }) => {
  await openApp(page);
  const res = await withApp(page, () => {
    const base = window.__snapshot(null);
    const trim = window.__snapshot((app, job) => {
      job.componentColours = { rails: 'Surfmist', posts: 'Basalt', plinths: 'Dune' };
    });
    const perRun = window.__snapshot((app, job) => {
      job.componentColours = { rails: 'Surfmist' };
      job.runs[1].colours = { sheets: 'Basalt', posts: 'Dune', plinths: 'Wollemi' };
    });
    // A special-order colour must not add a surcharge either.
    const special = window.__snapshot((app, job) => {
      job.componentColours = { rails: 'Manor Red', posts: 'Cottage Green' };
    });
    return { base, trim, perRun, special };
  });

  ['trim', 'perRun', 'special'].forEach((k) => {
    expect(res[k].grandTotal, k).toBe(res.base.grandTotal);
    expect(res[k].subtotal, k).toBe(res.base.subtotal);
    expect(res[k].internalCost, k).toBe(res.base.internalCost);
    expect(res[k].totalPanels, k).toBe(res.base.totalPanels);
    expect(res[k].totalPlinths, k).toBe(res.base.totalPlinths);
    expect(res[k].totalPlinthsStandard, k).toBe(res.base.totalPlinthsStandard);
    expect(res[k].totalPlinthsLong, k).toBe(res.base.totalPlinthsLong);
  });
});

test('the installation panel keeps the common case to one action', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    const app = window.app;
    app.job.colour = 'Monument';
    delete app.job.componentColours;
    app._componentColoursOpen = false;
    app.renderInstallation();
    const panel = document.getElementById('bodyInstallation');
    const labels = Array.from(panel.querySelectorAll('label')).map((l) => l.textContent.trim());
    const collapsed = {
      labels,
      selectCount: panel.querySelectorAll('select').length,
      text: panel.textContent.replace(/\s+/g, ' '),
    };

    app.toggleComponentColours();
    const openLabels = Array.from(document.querySelectorAll('#bodyInstallation label')).map((l) => l.textContent.trim());

    // Setting one keeps the block open and writes only that key.
    app.updateComponentColour('rails', 'Surfmist');
    const afterSet = JSON.parse(JSON.stringify(app.job.componentColours));
    // Choosing "Match sheet colour" removes it again, leaving no residue.
    app.updateComponentColour('rails', '');
    return { collapsed, openLabels, afterSet, afterClear: app.job.componentColours };
  });

  // Relabelled, and no extra pickers until asked for.
  expect(res.collapsed.labels).toContain('Sheet Colour *');
  expect(res.collapsed.labels).not.toContain('Colour *');
  expect(res.collapsed.labels).not.toContain('Rails Colour');
  expect(res.collapsed.text).toContain('Rails, posts and plinths match the sheet colour');
  // Opened: three INDEPENDENT pickers, one per component.
  expect(res.openLabels).toContain('Rails Colour');
  expect(res.openLabels).toContain('Posts Colour');
  expect(res.openLabels).toContain('Plinths Colour');
  expect(res.afterSet).toEqual({ rails: 'Surfmist' });
  // Back to matching: the field is deleted, not stored empty.
  expect(res.afterClear).toBeUndefined();
});

test('a run override names what each blank field will actually inherit', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    // Job says rails are Surfmist. A run overriding only its SHEETS still
    // inherits that explicit rail colour — so the blank option must say so
    // rather than claiming it will "match sheet colour".
    app.job.componentColours = { rails: 'Surfmist' };
    app.updateRunColour('run-a', 'sheets', 'Basalt');
    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();
    const selects = Array.from(document.querySelectorAll('#runContent select'));
    const byLabel = {};
    selects.forEach((sel) => {
      const label = sel.closest('.form-group') && sel.closest('.form-group').querySelector('label');
      if (label) byLabel[label.textContent.trim()] = Array.from(sel.options).map((o) => o.text)[0];
    });
    return {
      byLabel,
      resolved: app.getRunColourSet(app.job.runs[0]),
    };
  }, buildPreChangeJob.toString());

  // Rails inherit the JOB's explicit Surfmist, not the run's Basalt sheets.
  expect(res.byLabel.Rails).toBe('Follow job (Surfmist)');
  expect(res.resolved.rails).toBe('Surfmist');
  // Posts and plinths have no explicit job colour, so they follow this run's sheets.
  expect(res.byLabel.Posts).toBe('Follow job (Basalt)');
  expect(res.byLabel.Plinths).toBe('Follow job (Basalt)');
  expect(res.resolved.posts).toBe('Basalt');
  expect(res.resolved.plinths).toBe('Basalt');
  // Sheets fall back to the job colour.
  expect(res.byLabel.Sheets).toBe('Follow job (Monument)');
});

// ── Colour is part of the postGroups key, so every consumer that groups by it
// must say which colour, or two rows read identically. The Material
// Verification checklist is the one that matters: it is the confirm-before-order
// gate, and a Basalt group listed as Monument is a line ticked against stock we
// are not buying.
function readPostGroupLabels() {
  const app = window.app;
  const d = app._collectOutputData();
  app.renderQuoteAndOrders();
  app.renderCostBreakdown();
  const poCard = document.getElementById('bodyQuoteOrders').textContent;
  const costBreakdown = document.getElementById('bodyCostBreakdown').textContent;
  return {
    mvRows: app._materialVerifyPanelRows(d).map((r) => r.desc),
    poCard,
    costBreakdown,
    panelKitLabels: (costBreakdown.match(/Panel kit [^$\n]*/g) || []).map((s) => s.trim()),
  };
}

test('an all-one-colour job keeps every panel-group label exactly as it was', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, readSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    // eslint-disable-next-line no-eval
    return eval('(' + readSrc + ')')();
  }, [buildPreChangeJob.toString(), readPostGroupLabels.toString()]);

  // The checklist names the one job colour, plain — no Sheets/Rails/Posts form.
  res.mvRows.forEach((desc) => {
    expect(desc).toContain('| Monument');
    expect(desc).not.toContain('Sheets ');
  });
  // The cost breakdown and PO card labels carry NO colour at all, as before.
  res.panelKitLabels.forEach((label) => expect(label).not.toContain('Monument'));
  expect(res.costBreakdown).not.toContain('— Monument');
  expect(res.poCard).not.toContain('H posts — Monument');
});

test('a mixed-colour job never shows two panel rows that read identically', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, readSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    // Run B is Basalt throughout. Its panels are the same height/width/post as
    // run A's standard panels, so before this fix the two groups produced
    // byte-identical rows on every surface below.
    job.runs[1].colours = { sheets: 'Basalt', rails: 'Basalt', posts: 'Basalt', plinths: 'Basalt' };
    app.job = Object.assign(app.job, job);
    // eslint-disable-next-line no-eval
    return eval('(' + readSrc + ')')();
  }, [buildPreChangeJob.toString(), readPostGroupLabels.toString()]);

  // The engine really did split them, and no two checklist lines read alike.
  expect(res.mvRows.length).toBeGreaterThan(1);
  expect(new Set(res.mvRows).size).toBe(res.mvRows.length);
  expect(res.mvRows.some((d) => d.includes('| Monument'))).toBeTruthy();
  expect(res.mvRows.some((d) => d.includes('| Basalt'))).toBeTruthy();
  // The cost breakdown labels disambiguate too, and stay unique.
  expect(new Set(res.panelKitLabels).size).toBe(res.panelKitLabels.length);
  expect(res.panelKitLabels.some((l) => l.endsWith('Monument'))).toBeTruthy();
  expect(res.panelKitLabels.some((l) => l.endsWith('Basalt'))).toBeTruthy();
  // And so does the PO card.
  expect(res.poCard).toContain('H posts — Monument');
  expect(res.poCard).toContain('H posts — Basalt');
});

test('a job whose rails and posts differ names all three on the checklist line', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, readSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    job.componentColours = { rails: 'Surfmist', posts: 'Basalt' };
    app.job = Object.assign(app.job, job);
    // eslint-disable-next-line no-eval
    return eval('(' + readSrc + ')')();
  }, [buildPreChangeJob.toString(), readPostGroupLabels.toString()]);

  res.mvRows.forEach((desc) => {
    expect(desc).toContain('Sheets Monument / Rails Surfmist / Posts Basalt');
  });
  res.panelKitLabels.forEach((label) => {
    expect(label).toContain('Sheets Monument / Rails Surfmist / Posts Basalt');
  });
  expect(res.poCard).toContain('Sheets Monument / Rails Surfmist / Posts Basalt');
});

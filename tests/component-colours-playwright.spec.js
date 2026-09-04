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
  expect(res.specs).toContainEqual(['Trim Colours', 'Rails Surfmist · Posts Basalt']);
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
  expect(res.specs).toContainEqual(['Trim Colours', 'Plinths Surfmist']);
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

// ── Every run carrying the SAME sheet override collapses the summary to one
// entry and reads as uniform, so the "more than one colour" branch never fired
// and the quote fell back to the raw job colour while the order bought the
// override. Single-run jobs are the common shape of this.
function buildSingleRunJob() {
  return {
    clientFirstName: 'Ada', clientLastName: 'Lovelace', client: 'Ada Lovelace',
    address: '12 Analytical Way, Perth WA 6000', phone: '0400000000', email: 'ada@example.com',
    ref: 'FEN-3001',
    supplier: 'Metroll', profile: 'Trimclad',
    colour: 'Monument',
    scopeType: 'fence-and-gate', pricePerMetre: 125, gates: [],
    neighboursRequired: false, neighbours: [],
    installation: { supplierSource: 'Fencing Warehouse' },
    runs: [{
      id: 'run-a', name: 'Rear', length: 12, sheetHeight: 1800,
      panels: [
        { id: 'p1', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p2', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
      ],
    }],
    quote: { urgency: 'standard', deliveryFee: 200, groundFinish: 'none', addons: {}, customLineItems: [] },
  };
}

test('a sheet override on EVERY run is still the colour the quote and work order state', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    job.runs[0].colours = { sheets: 'Basalt' };
    app.job = Object.assign(app.job, job);
    const raw = app._collectOutputData();
    const quote = app._gatherFenceQuoteData(raw);
    return {
      uniform: raw.componentColours.uniform,
      sheets: raw.componentColours.sheets,
      jobColour: app.job.colour,
      specs: quote.specs,
      order: app._buildMaterialOrderText(raw),
      workOrder: app._generateWorkOrderHTML(raw),
    };
  }, buildSingleRunJob.toString());

  // The summary really does collapse to one entry and read as uniform — this is
  // the shape that used to slip through.
  expect(res.uniform).toBeTruthy();
  expect(res.sheets).toEqual(['Basalt']);
  expect(res.jobColour).toBe('Monument');
  // The order buys Basalt...
  expect(res.order).toContain('    Colour: Basalt');
  expect(res.order).not.toContain('    Colour: Monument');
  // ...so the quote and the work order must say Basalt, not the raw job colour.
  expect(res.specs).toContainEqual(['Colour', 'COLORBOND® Basalt']);
  expect(res.specs).not.toContainEqual(['Colour', 'COLORBOND® Monument']);
  expect(res.workOrder).toContain('<span class="label">Colour:</span> <span class="value">Basalt</span>');
  expect(res.workOrder).not.toContain('<span class="value">Monument</span>');
});

// ── The Material Verification plinth row is the same order gate as the panel
// rows: it must name the colour and width the order actually buys.
test('the checklist plinth rows mirror the order, colour by colour and width by width', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([preSrc, singleSrc]) => {
    const app = window.app;
    const load = (job) => {
      // Object.assign leaves stale keys behind, so a previous case's job-level
      // override would silently colour the next one.
      delete app.job.componentColours;
      app.job = Object.assign(app.job, job);
      const d = app._collectOutputData();
      return { rows: app._materialVerifyPlinthRows(d).map((r) => r.desc), order: app._buildMaterialOrderText(d) };
    };
    // eslint-disable-next-line no-eval
    const single = load(eval('(' + singleSrc + ')')());

    // eslint-disable-next-line no-eval
    const mixed = eval('(' + preSrc + ')')();
    mixed.componentColours = { plinths: 'Basalt' };
    const overridden = load(mixed);

    // eslint-disable-next-line no-eval
    const perRun = eval('(' + preSrc + ')')();
    perRun.runs[1].colours = { plinths: 'Surfmist' };
    const split = load(perRun);
    return { single, overridden, split };
  }, [buildPreChangeJob.toString(), buildSingleRunJob.toString()]);

  // One colour, one width class — exactly one row, reading as it always did.
  expect(res.single.rows).toEqual(['1 &times; 150mm Plinths &mdash; Monument']);

  // A plinth override is named on the checklist, matching what the order buys.
  expect(res.overridden.order).toContain('150mm Plinths @ 2365mm — Basalt');
  res.overridden.rows.forEach((r) => expect(r).toContain('Basalt'));
  res.overridden.rows.forEach((r) => expect(r).not.toContain('Monument'));
  // Standard and long are separate lines on the order, so separate rows here.
  expect(res.overridden.rows.some((r) => r.includes('Long Plinths @ 3150mm'))).toBeTruthy();
  expect(res.overridden.rows.some((r) => !r.includes('Long'))).toBeTruthy();

  // Two plinth colours across runs: one row each, none duplicated.
  expect(new Set(res.split.rows).size).toBe(res.split.rows.length);
  expect(res.split.rows.some((r) => r.includes('Monument'))).toBeTruthy();
  expect(res.split.rows.some((r) => r.includes('Surfmist'))).toBeTruthy();
  expect(res.split.order).toContain('— Surfmist');
});

// ── THE CLASS TEST ──────────────────────────────────────────────────────────
// `job.colour` is the job DEFAULT sheet colour; a run can override it. Three
// rounds of this defect all had the same shape: one more surface printing the
// default while the material order buys the override. Rather than assert one
// more site, this walks EVERY human-rendered surface at once and asserts that
// none of them names the job colour once a component colour applies.
//
// Not covered here, deliberately and explicitly: generateNeighbourPDF and
// generateRunQuotePDF draw into jsPDF, whose CDN script is blocked in these
// tests and whose output is a binary PDF, not assertable text. What those two
// paths READ is asserted instead — runDetails[].sheetColour and the
// pricing_json run's sheet_colour — which is the data they render from.
function collectEveryColourSurface() {
  const app = window.app;
  const raw = app._collectOutputData();
  const quote = app._gatherFenceQuoteData(raw);
  const nb = (app.job.neighbours || [])[0];

  app.renderQuoteAndOrders();
  app.renderCostBreakdown();

  // The confirm-before-order gate, rendered for real and read from the DOM.
  // Gate rows are pulled out first: gates are the documented job-level
  // exception, so they are asserted separately rather than blanket-scanned.
  window.showMaterialVerificationModal(raw);
  const modal = document.getElementById('materialVerifyModal');
  let mvText = '';
  let mvGateText = '';
  if (modal) {
    const gateEls = Array.from(modal.querySelectorAll('*')).filter((el) =>
      /gate kit \|/i.test(el.textContent)
      && !Array.from(el.children).some((c) => /gate kit \|/i.test(c.textContent)));
    mvGateText = gateEls.map((el) => el.textContent).join('\n');
    gateEls.forEach((el) => el.remove());
    mvText = modal.textContent;
    modal.remove();
  }

  const pricing = app.buildPricingJson();
  const stripB64 = (h) => h.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:[BINARY]');

  return {
    materialOrder: raw.job ? app._buildMaterialOrderText(raw) : '',
    workOrder: app._generateWorkOrderHTML(raw),
    clientQuote: stripB64(app._buildFenceQuoteHTML(quote, {}, { forPDF: false })),
    legacyQuote: stripB64(app._generateQuoteHTML(raw)),
    neighbourQuote: nb ? stripB64(app._generateNeighbourQuoteHTML(raw, nb, (raw.neighbourCosts || {})[nb.id] || { runs: [] })) : '',
    quoteScopeDesc: app._buildQuoteScopeDesc(raw),
    specs: quote.specs,
    lede: quote.lede,
    scopeText: JSON.stringify(quote.scopeGroups || []),
    priceLineLabels: (quote.priceLineItems || []).map((li) => li.label),
    poCard: document.getElementById('bodyQuoteOrders').textContent,
    costBreakdown: document.getElementById('bodyCostBreakdown').textContent,
    materialVerify: mvText,
    materialVerifyGate: mvGateText,
    pricingDescriptions: JSON.stringify([
      pricing.job_description,
      (pricing.line_items || []).map((li) => li.description),
      (pricing.runs || []).map((r) => [r.sheet_colour, (r.items || []).map((i) => i.description)]),
    ]),
    runDetailSheetColours: (raw.runDetails || []).map((r) => r.sheetColour),
    pricingRunSheetColours: (pricing.runs || []).map((r) => r.sheet_colour),
  };
}

// A shared-boundary job so the neighbour quote and the per-run pricing runs are
// both populated, with the sheet colour overridden on its only run.
function buildMixedColourJob() {
  return {
    clientFirstName: 'Ada', clientLastName: 'Lovelace', client: 'Ada Lovelace',
    address: '12 Analytical Way, Perth WA 6000', phone: '0400000000', email: 'ada@example.com',
    ref: 'FEN-4001',
    supplier: 'Metroll', profile: 'Trimclad',
    colour: 'Monument',
    scopeType: 'fence-and-gate', pricePerMetre: 125,
    gates: [{ id: 'g1', type: 'pedestrian', width: 900, height: 1800 }],
    neighboursRequired: true,
    neighbours: [{
      id: 'nb-1', firstName: 'Grace', lastName: 'Hopper', phone: '0400111222',
      email: 'grace@example.com', address: '14 Analytical Way, Perth WA 6000', sharePercent: 50,
    }],
    installation: { supplierSource: 'Fencing Warehouse' },
    runs: [{
      id: 'run-a', name: 'Rear', length: 12, sheetHeight: 1800, neighbourId: 'nb-1',
      colours: { sheets: 'Basalt' },
      panels: [
        { id: 'p1', height: 1800, retaining: 150, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
        { id: 'p2', height: 1800, retaining: 300, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'long' },
        { id: 'p3', height: 1800, retaining: 0, step: 'level', stepMm: 0, slopePlinths: 0, panelWidth: 'standard' },
      ],
    }],
    quote: { urgency: 'standard', deliveryFee: 200, groundFinish: 'none', addons: {}, priceDisplay: 'itemized', customLineItems: [] },
  };
}

test('no rendered surface names the job colour once a component colour overrides it', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, collectSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    // Job-level trim overrides on top of the run's sheet override, so every
    // component resolves away from the job colour.
    job.componentColours = { rails: 'Surfmist', posts: 'Surfmist', plinths: 'Basalt' };
    app.job = Object.assign(app.job, job);
    // eslint-disable-next-line no-eval
    return eval('(' + collectSrc + ')')();
  }, [buildMixedColourJob.toString(), collectEveryColourSurface.toString()]);

  // The order is the source of truth for what we buy: Basalt sheets.
  expect(res.materialOrder).toContain('Sheets: Basalt');
  expect(res.materialOrder).toContain('Pedestrian gate kit');

  // Every human-rendered surface. None may say Monument — nothing is bought in it.
  // Gates are the one documented exception: nothing attaches them to a run, so
  // they resolve to the job colour on purpose. They are scanned separately.
  const orderWithoutGates = res.materialOrder.split('\n').filter((l) => !/gate kit \|/i.test(l)).join('\n');
  const gateKitLines = res.materialOrder.split('\n').filter((l) => /gate kit \|/i.test(l));
  expect(gateKitLines.length).toBeGreaterThan(0);
  gateKitLines.forEach((l) => {
    expect(l).toContain('Monument');
    expect(l.includes('Basalt')).toBeFalsy();
  });
  expect(res.materialVerifyGate).toContain('Monument');
  expect(res.materialVerifyGate.includes('Basalt')).toBeFalsy();

  const surfaces = {
    materialOrder: orderWithoutGates,
    workOrder: res.workOrder,
    clientQuote: res.clientQuote,
    legacyQuote: res.legacyQuote,
    neighbourQuote: res.neighbourQuote,
    quoteScopeDesc: res.quoteScopeDesc,
    specs: JSON.stringify(res.specs),
    lede: res.lede,
    scopeText: res.scopeText,
    priceLineLabels: JSON.stringify(res.priceLineLabels),
    poCard: res.poCard,
    costBreakdown: res.costBreakdown,
    materialVerify: res.materialVerify,
    pricingDescriptions: res.pricingDescriptions,
  };
  Object.entries(surfaces).forEach(([name, text]) => {
    expect(text, name + ' is non-empty').toBeTruthy();
    expect(text.includes('Monument'), name + ' names the job colour "Monument"').toBeFalsy();
  });
  // ...and each names the colour actually being bought.
  ['clientQuote', 'legacyQuote', 'neighbourQuote', 'quoteScopeDesc', 'lede', 'scopeText',
   'priceLineLabels', 'poCard', 'materialVerify', 'pricingDescriptions', 'specs', 'workOrder']
    .forEach((name) => expect(surfaces[name].includes('Basalt'), name + ' should name Basalt').toBeTruthy());

  // The two jsPDF paths are not assertable as text; the data they read is.
  expect(res.runDetailSheetColours).toEqual(['Basalt']);
  expect(res.pricingRunSheetColours).toEqual(['Basalt']);
});

test('a job with no colour overrides still renders every surface as it does today', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, collectSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    delete job.runs[0].colours;            // no overrides anywhere
    app.job = Object.assign(app.job, job);
    // eslint-disable-next-line no-eval
    return eval('(' + collectSrc + ')')();
  }, [buildMixedColourJob.toString(), collectEveryColourSurface.toString()]);

  // Every surface reads the one job colour, exactly as before the feature.
  ['materialOrder', 'workOrder', 'clientQuote', 'legacyQuote', 'neighbourQuote', 'quoteScopeDesc',
   'lede', 'scopeText', 'poCard', 'materialVerify', 'pricingDescriptions']
    .forEach((name) => expect(res[name].includes('Monument'), name).toBeTruthy());
  expect(JSON.stringify(res.specs)).toContain('Monument');
  expect(JSON.stringify(res.priceLineLabels)).toContain('Monument');
  expect(res.specs).toContainEqual(['Colour', 'COLORBOND® Monument']);
  expect(res.specs.map((s) => s[0])).not.toContain('Trim Colours');
  expect(res.runDetailSheetColours).toEqual(['Monument']);
  expect(res.pricingRunSheetColours).toEqual(['Monument']);
  // And nothing accidentally names a colour nobody chose.
  expect(res.materialOrder.includes('Basalt')).toBeFalsy();
  expect(res.clientQuote.includes('Basalt')).toBeFalsy();
});

// ── An order line that names two colours cannot be filled ──────────────────
// Panel and plinth lines split per group precisely so one supplier line never
// carries two colours. This pins the FAILURE MODE generally rather than the one
// line that regressed: any order line joining two of the job's colours fails,
// including lines added in future.
test('no material order line ever names two colours at once', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    job.componentColours = { rails: 'Surfmist', posts: 'Surfmist', plinths: 'Basalt' };
    app.job = Object.assign(app.job, job);
    const raw = app._collectOutputData();
    const cc = raw.componentColours || {};
    const colours = Array.from(new Set(
      [].concat(cc.sheets || [], cc.rails || [], cc.posts || [], cc.plinths || []).filter(Boolean)
    ));
    const joined = [];
    colours.forEach((a) => colours.forEach((b) => { if (a !== b) joined.push(a + ' / ' + b); }));

    const order = app._buildMaterialOrderText(raw);
    const offending = order.split('\n').filter((line) => joined.some((p) => line.includes(p)));
    const gateLines = order.split('\n').filter((line) => /gate kit \|/i.test(line));
    return {
      colours, joinedCount: joined.length, offending, gateLines,
      jobColour: app.job.colour,
      mvGateRows: (function () {
        window.showMaterialVerificationModal(raw);
        const modal = document.getElementById('materialVerifyModal');
        const rows = modal
          ? Array.from(modal.querySelectorAll('*'))
              .map((el) => el.textContent)
              .filter((t) => /gate kit/i.test(t) && t.length < 200)
          : [];
        if (modal) modal.remove();
        return rows;
      })(),
    };
  }, buildMixedColourJob.toString());

  // The job genuinely carries several colours, so the scan has something to catch.
  expect(res.colours.length).toBeGreaterThan(1);
  expect(res.joinedCount).toBeGreaterThan(0);
  // No order line joins any two of them.
  expect(res.offending, 'order lines naming two colours: ' + JSON.stringify(res.offending)).toEqual([]);

  // The gate line exists and names exactly one colour — the job's.
  expect(res.gateLines.length).toBeGreaterThan(0);
  res.gateLines.forEach((line) => {
    expect(line).toContain(res.jobColour);
    expect(line.includes(' / ')).toBeFalsy();
  });
  // ...and so does the confirm-before-order gate row for it.
  expect(res.mvGateRows.length).toBeGreaterThan(0);
  res.mvGateRows.forEach((t) => expect(t.includes(' / ')).toBeFalsy());
});

// ── Operator free text reaches an inline handler ───────────────────────────
// The Custom Colour field writes arbitrary text to job.colour. An apostrophe in
// it used to close the JS string inside the onclick attribute, making the whole
// handler a syntax error and the button silently inert.
test('a custom colour containing an apostrophe still leaves the run override working', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    app.job = Object.assign(app.job, job);
    // Exactly what the Custom Colour input does with this typed in.
    app.updateColour("Bob's Grey");

    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();

    const btn = Array.from(document.querySelectorAll('#runContent button'))
      .find((b) => /Override for this run/i.test(b.textContent));
    const before = app.job.runs[0].colours;
    if (btn) btn.click();
    return {
      found: !!btn,
      before: before || null,
      after: app.job.runs[0].colours || null,
      resolved: app.getRunColourSet(app.job.runs[0]).sheets,
    };
  }, buildPreChangeJob.toString());

  expect(res.found).toBeTruthy();
  expect(res.before).toBeNull();
  // The click actually ran: the override was written, with the apostrophe intact.
  expect(res.after).toEqual({ sheets: "Bob's Grey" });
  expect(res.resolved).toBe("Bob's Grey");
});

// ── A control must be able to DISPLAY what is genuinely stored ─────────────
// The per-run colour selects only ever offered the two palettes, so a stored
// CUSTOM colour had no matching <option> and the browser fell back to showing
// the first one — "Follow job (…)" — while an override really was stored.
test('a run override on a custom colour is the selected option, not a fallback', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    // Exactly what the Custom Colour input does.
    app.updateColour("Bob's Grey");

    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();
    const btn = Array.from(document.querySelectorAll('#runContent button'))
      .find((b) => /Override for this run/i.test(b.textContent));
    if (btn) btn.click();

    // Now change the JOB colour. The run must keep — and keep showing — its own.
    app.updateColour('Monument');
    app.render();

    const sel = Array.from(document.querySelectorAll('#runContent select')).find((s) => {
      const label = s.closest('.form-group') && s.closest('.form-group').querySelector('label');
      return label && label.textContent.trim() === 'Sheets';
    });
    return {
      stored: app.job.runs[0].colours ? app.job.runs[0].colours.sheets : null,
      resolved: app.getRunColourSet(app.job.runs[0]).sheets,
      selectValue: sel ? sel.value : null,
      selectedText: sel ? (sel.options[sel.selectedIndex] || {}).text : null,
      selectedIndex: sel ? sel.selectedIndex : -1,
      optionValues: sel ? Array.from(sel.options).map((o) => o.value) : [],
    };
  }, buildPreChangeJob.toString());

  // The override really is stored, and the engine resolves the run to it.
  expect(res.stored).toBe("Bob's Grey");
  expect(res.resolved).toBe("Bob's Grey");
  // ...and the control says so, rather than falling back to the first option.
  expect(res.selectValue).toBe("Bob's Grey");
  expect(res.selectedText).toBe("Bob's Grey");
  expect(res.selectedIndex).toBeGreaterThan(0);
  // The custom colour appears exactly once — it is not in either palette.
  expect(res.optionValues.filter((v) => v === "Bob's Grey")).toHaveLength(1);
});

test('a palette-colour job renders the run colour options exactly as before', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    app.updateRunColour('run-a', 'sheets', 'Basalt');
    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();
    const sel = Array.from(document.querySelectorAll('#runContent select')).find((s) => {
      const label = s.closest('.form-group') && s.closest('.form-group').querySelector('label');
      return label && label.textContent.trim() === 'Sheets';
    });
    return {
      optionValues: Array.from(sel.options).map((o) => o.value),
      groupLabels: Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label),
      selectValue: sel.value,
      customColours: app._customColoursInPlay(),
    };
  }, buildPreChangeJob.toString());

  // Every colour is on a palette, so nothing extra is emitted.
  expect(res.customColours).toEqual([]);
  expect(res.groupLabels).toEqual(['── Stock ──', '── Special Order ──']);
  // No duplicates, and the stored palette colour is still selected.
  expect(new Set(res.optionValues).size).toBe(res.optionValues.length);
  expect(res.selectValue).toBe('Basalt');
});

// ── The override button must read the colour at CLICK time ─────────────────
// It used to bake the resolved colour into its onclick at render time, and
// nothing re-rendered the run block when the job colour changed. An operator
// who switched the job to Basalt and then tapped Override pinned that run to
// Monument — and the material order then bought Monument panels for it.
test('overriding a run after a job colour change stores the NEW colour, not the stale one', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();

    // Capture the button as it exists NOW, then change the job colour and click
    // that same node. A render-time snapshot writes the old colour; a
    // click-time resolution writes the new one, with no re-render required.
    const staleBtn = Array.from(document.querySelectorAll('#runContent button'))
      .find((b) => /Override for this run/i.test(b.textContent));
    app.updateColour('Basalt');
    staleBtn.click();

    const raw = app._collectOutputData();
    const runADetail = (raw.runDetails || []).find((r) => r.name === 'Rear');
    const liveLabel = (document.querySelector('#runContent') || {}).textContent || '';
    return {
      stored: app.job.runs[0].colours ? app.job.runs[0].colours.sheets : null,
      resolved: app.getRunColourSet(app.job.runs[0]).sheets,
      runASheetColour: runADetail ? runADetail.sheetColour : null,
      order: app._buildMaterialOrderText(raw),
      liveLabelMentionsBasalt: /follows the job \(Basalt\)/.test(liveLabel),
      liveLabelMentionsMonument: /follows the job \(Monument\)/.test(liveLabel),
    };
  }, buildPreChangeJob.toString());

  // The override pins the colour the job actually has now.
  expect(res.stored).toBe('Basalt');
  expect(res.resolved).toBe('Basalt');
  expect(res.runASheetColour).toBe('Basalt');
  // ...so the order buys Basalt, and never the abandoned colour.
  expect(res.order).toContain('Colour: Basalt');
  expect(res.order.includes('Monument')).toBeFalsy();
  // The still-mounted run block also describes the current job colour.
  expect(res.liveLabelMentionsMonument).toBeFalsy();
  expect(res.liveLabelMentionsBasalt).toBeFalsy();
});

// A job-level colour change must redraw the run block, or it keeps describing
// an inheritance that no longer holds and omits a newly typed custom colour.
test('a job colour change refreshes the run block without any explicit re-render', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    app.job = Object.assign(app.job, eval('(' + jobSrc + ')')());
    app.currentRunId = 'run-a';
    if (!app._openSections.runs) app.toggleSection('runs');
    app.render();

    app.updateColour("Bob's Grey");
    const label = document.querySelector('#runContent').textContent;

    app.updateRunColour('run-a', 'sheets', "Bob's Grey");
    const sel = Array.from(document.querySelectorAll('#runContent select')).find((s) => {
      const l = s.closest('.form-group') && s.closest('.form-group').querySelector('label');
      return l && l.textContent.trim() === 'Sheets';
    });
    return {
      label,
      optionValues: sel ? Array.from(sel.options).map((o) => o.value) : [],
      selectValue: sel ? sel.value : null,
    };
  }, buildPreChangeJob.toString());

  // The label follows the job's current colour, with no explicit render call.
  expect(res.label).toContain("follows the job (Bob's Grey)");
  expect(res.label.includes('follows the job (Monument)')).toBeFalsy();
  // ...and the newly typed custom colour is selectable in the run's own control.
  expect(res.optionValues).toContain("Bob's Grey");
  expect(res.selectValue).toBe("Bob's Grey");
});

// ── A run only earns a colour once it puts stock on the order ──────────────
// postGroups/plinthGroups are built inside run.panels.forEach, so a run with no
// panels drawn yet contributes nothing to the material order. Counting its
// colour in the job summary made every quote surface name a colour we are not
// buying — the same invariant the colour sweep exists to hold.
test('a run with no panels yet does not put its colour on any quote surface', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(([jobSrc, collectSrc]) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    // Exactly what '+ Add Run' then 'Override for this run' produces.
    job.runs.push({ id: 'run-future', name: 'Stage 2', length: 0, sheetHeight: 1800, panels: [], colours: { sheets: 'Basalt' } });
    // A neighbour so the neighbour quote is a real surface here too.
    job.neighboursRequired = true;
    job.neighbours = [{ id: 'nb-1', firstName: 'Grace', lastName: 'Hopper', phone: '0400111222',
      email: 'grace@example.com', address: '14 Analytical Way, Perth WA 6000', sharePercent: 50 }];
    job.runs[0].neighbourId = 'nb-1';
    app.job = Object.assign(app.job, job);
    // eslint-disable-next-line no-eval
    const out = eval('(' + collectSrc + ')')();
    const raw = app._collectOutputData();
    const pricing = app.buildPricingJson();
    out.summarySheets = raw.componentColours.sheets;
    out.resolved = app.resolvedSheetColour(raw);
    out.jobDescription = pricing.job_description;
    out.flatLineDescriptions = (pricing.line_items || []).map((li) => li.description).join(' | ');
    out.runItemDescriptions = (pricing.runs || [])
      .map((r) => (r.items || []).map((i) => i.description).join(' | ')).join(' | ');
    out.runSheetColours = (pricing.runs || []).map((r) => [r.run_name, r.sheet_colour]);
    return out;
  }, [buildPreChangeJob.toString(), collectEveryColourSurface.toString()]);

  // The order buys only Monument, because no Basalt panel exists.
  expect(res.materialOrder).toContain('Colour: Monument');
  expect(res.materialOrder.includes('Basalt')).toBeFalsy();
  // The summary is derived from the same runs, so it agrees.
  expect(res.summarySheets).toEqual(['Monument']);
  expect(res.resolved).toBe('Monument');
  // No rendered surface names the colour of the panel-less run.
  ['workOrder', 'clientQuote', 'legacyQuote', 'neighbourQuote', 'quoteScopeDesc',
   'lede', 'scopeText', 'poCard', 'costBreakdown', 'materialVerify',
   'jobDescription', 'flatLineDescriptions', 'runItemDescriptions']
    .forEach((name) => {
      expect(res[name], name + ' is non-empty').toBeTruthy();
      expect(res[name].includes('Basalt'), name + ' names the panel-less run colour').toBeFalsy();
    });
  expect(JSON.stringify(res.specs).includes('Basalt')).toBeFalsy();
  expect(JSON.stringify(res.priceLineLabels).includes('Basalt')).toBeFalsy();
  expect(res.specs).toContainEqual(['Colour', 'COLORBOND® Monument']);

  // The per-run pricing record is the ONE place the panel-less run's own colour
  // may appear: it is that run's setting, feeding only that run's own quote,
  // and it bills nothing because the run has no items.
  expect(res.runSheetColours).toContainEqual(['Stage 2', 'Basalt']);
  expect(res.runSheetColours).toContainEqual(['Rear', 'Monument']);
});

test('a gate-only job takes the job colour, ignoring any run overrides', async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate((jobSrc) => {
    const app = window.app;
    // eslint-disable-next-line no-eval
    const job = eval('(' + jobSrc + ')')();
    job.scopeType = 'gate-only';
    job.gates = [{ id: 'g1', type: 'pedestrian', width: 900, height: 1800 }];
    job.runs[0].colours = { sheets: 'Basalt' };
    app.job = Object.assign(app.job, job);
    const raw = app._collectOutputData();
    return {
      summarySheets: raw.componentColours.sheets,
      resolved: app.resolvedSheetColour(raw),
      order: app._buildMaterialOrderText(raw),
      specs: app._gatherFenceQuoteData(raw).specs,
    };
  }, buildPreChangeJob.toString());

  // The engine skips the runs loop entirely for gate-only, so the summary must too.
  expect(res.summarySheets).toEqual(['Monument']);
  expect(res.resolved).toBe('Monument');
  expect(res.order).toContain('gate kit');
  expect(res.order.includes('Basalt')).toBeFalsy();
  expect(JSON.stringify(res.specs).includes('Basalt')).toBeFalsy();
});

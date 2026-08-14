'use strict';

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

function installFixtureBrowser(pricingAvailable = true) {
  const SESSION = {
    access_token: 'test-session-token',
    user: { id: 'user-khairo', email: 'khairo@secureworksgroup.app' },
  };
  const PRICE_ROWS = pricingAvailable ? [{
    category: 'materials', item_key: 'panel-kit-1800-2400',
    item_description: 'Fixture panel kit', unit: 'each',
    default_price: 125, default_cost_rate: 79, default_sqm_rate: null,
    last_updated_at: '2026-07-23T00:00:00Z',
    default_supplier_name: null, default_supplier_id: null,
  }] : null;

  function tableQuery(table) {
    const chain = {
      select() { return chain; },
      eq() {
        if (table === 'scope_tool_defaults') {
          return Promise.resolve({ data: PRICE_ROWS, error: PRICE_ROWS ? null : { message: 'fixture unavailable' } });
        }
        return Promise.resolve({ data: [], error: null });
      },
      not() { return chain; },
      order() { return Promise.resolve({ data: [], error: null }); },
    };
    return chain;
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
          refreshSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
          onAuthStateChange(cb) {
            setTimeout(() => cb('INITIAL_SESSION', SESSION), 0);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithOtp: () => Promise.resolve({ error: null }),
          signInWithPassword: () => Promise.resolve({ data: { user: SESSION.user }, error: null }),
          signOut: () => Promise.resolve({ error: null }),
        },
        from: tableQuery,
      };
    },
  };

  window.__swCalls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('/functions/v1/ghl-proxy')) return realFetch(input, init);
    const action = (url.match(/action=([a-z_]+)/) || [])[1] || '';
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    window.__swCalls.push({ action, body });
    const reply = (payload, status = 200) => Promise.resolve(new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    }));

    if (action === 'get_profile') return reply({ profile: {
      id: 'user-khairo', email: 'khairo@secureworksgroup.app', name: 'Khairo',
      role: 'estimator', org_id: '10000000-0000-4000-8000-000000000001',
    } });
    if (action === 'lead_search') {
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '').toLowerCase();
      // A repeat client that already carries a Supabase job: selecting it in
      // new_job mode is a DELIBERATE_REPEAT and must collect a reason in-app.
      if (q.includes('repeat')) return reply({ opportunities: [{
        id: 'opp-repeat-zzz', contactId: 'contact-repeat-zzz', contactName: 'TEST-ZZZ Repeat Client',
        contactPhone: '0404777985', contactEmail: 'repeat-zzz@example.com',
        address: '2 Test Lab Way', suburb: 'Perth', stageName: 'Quote Sent',
        supabaseJobId: '20000000-0000-4000-8000-000000000009', hasScope: true,
      }] });
      return reply({ opportunities: [{
        id: null, contactId: 'contact-test-zzz', contactName: 'TEST-ZZZ Khairo Lead',
        contactPhone: '0404777984', contactEmail: 'test-zzz@example.com',
        address: '1 Test Lab Way', suburb: 'Perth',
      }] });
    }
    if (action === 'find_job') {
      // An opportunity that already maps to an EXISTING scoped Supabase job.
      // Selecting it via a local-draft promotion must NOT clobber that scope.
      const opp = decodeURIComponent((url.match(/[?&]opportunityId=([^&]*)/) || [])[1] || '');
      if (opp === 'opp-existing-scoped') return reply({ job: {
        id: '20000000-0000-4000-8000-000000000077', job_number: 'SWF-TEST-7700',
        status: 'draft', ghl_opportunity_id: 'opp-existing-scoped', ghl_contact_id: 'contact-existing',
        current_scope_hash: 'existing-cloud-scope-hash', updated_at: '2026-07-22T00:00:00Z',
        scope_json: { job: { runs: [{ lengthM: 30 }] } },
      } });
      return reply({ job: null });
    }
    if (action === 'load_job') {
      const jobId = decodeURIComponent((url.match(/[?&]jobId=([^&]*)/) || [])[1] || '');
      return reply({ job: {
        id: jobId, job_number: 'SWF-TEST-2301', status: 'draft',
        ghl_opportunity_id: 'opp-test-zzz', ghl_contact_id: 'contact-test-zzz',
        scope_json: {}, pricing_json: null,
      } });
    }
    if (action === 'mint_fence_job') return reply({
      success: true, requestId: body.requestId,
      jobId: '20000000-0000-4000-8000-000000000002', jobNumber: 'SWF-TEST-2301',
      contactId: body.contactId || 'contact-test-zzz',
      opportunityId: body.opportunityId || 'opp-test-zzz',
      mapping: { outcome: 'created', canonicalOutcome: 'created' },
      revision: { scopeVersion: 1, scopeHash: null, updatedAt: '2026-07-23T00:00:00Z', requiresLoad: false },
    });
    if (action === 'save_scope') return reply({
      ok: true,
      job: { id: body.jobId, current_scope_hash: 'fixture-scope-hash', scope_updated_at: '2026-07-23T00:00:01Z' },
      current_scope_hash: 'fixture-scope-hash', scope_updated_at: '2026-07-23T00:00:01Z',
    });
    if (action === 'list_media') return reply({ media: [] });
    if (action === 'contact') return reply({ contact: {
      id: 'contact-test-zzz', name: 'TEST-ZZZ Khairo Lead', phone: '0404777984',
      email: 'test-zzz@example.com', address: '1 Test Lab Way', suburb: 'Perth',
    } });
    if (action === 'create_contact_and_opportunity' || action === 'create_job') {
      return reply({ error: 'legacy browser mint must not run' }, 500);
    }
    return reply({ ok: true });
  };
}

async function openFixture(page, pricingAvailable = true) {
  await page.addInitScript(installFixtureBrowser, pricingAvailable);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.goto(baseUrl + '/index.html');
  await page.waitForFunction(() => window.app && window._swIntegration &&
    window.SECUREWORKS_CLOUD && window.SECUREWORKS_CLOUD.auth.isLoggedIn() &&
    window._swIntegration.isLoggedIn());
}

async function clickLaunch(page) {
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.locator('#fieldLaunchModal')).toBeVisible();
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

test('GHL lead load resolves through the server mint owner', async ({ page }) => {
  await openFixture(page);
  await clickLaunch(page);
  await page.locator('#launchGhlLeadBtn').click();
  await expect(page.locator('.sw-lead-item')).toHaveCount(1);
  await page.locator('.sw-lead-item').click();

  await expect.poll(() => page.evaluate(() => window._swIntegration.getSyncState().jobId))
    .toBe('20000000-0000-4000-8000-000000000002');
  const calls = await page.evaluate(() => window.__swCalls);
  expect(calls.filter((call) => call.action === 'mint_fence_job')).toHaveLength(1);
  expect(calls.some((call) => ['create_contact_and_opportunity', 'create_job'].includes(call.action))).toBeFalsy();
});

test('repeat-client mint collects its reason in-app, never via window.prompt', async ({ page }) => {
  // Prove the reason is never gathered via a blocking window.prompt: make it
  // throw. This init script runs before the page scripts on the first load.
  await page.addInitScript(() => {
    window.prompt = () => { throw new Error('window.prompt must not be used on iPad'); };
  });
  await openFixture(page);

  await clickLaunch(page);
  await page.locator('#launchNewJobBtn').click();
  await expect(page.locator('#sw-lead-search-dropdown')).toBeVisible();
  await page.locator('#sw-lead-search-dropdown input').fill('Repeat');
  // Wait for the re-search to land the repeat row specifically; the stale
  // contact-only row also has count 1, so gate on its text, not the count.
  const repeatRow = page.locator('.sw-lead-item', { hasText: 'Repeat Client' });
  await expect(repeatRow).toBeVisible();
  await repeatRow.click();

  const reasonInput = page.locator('#fenceRepeatReasonInput');
  await expect(reasonInput).toBeVisible();
  await expect(page.locator('#fenceRepeatReasonConfirm')).toBeDisabled();
  await reasonInput.fill('Second boundary fence');
  await expect(page.locator('#fenceRepeatReasonConfirm')).toBeEnabled();
  await page.locator('#fenceRepeatReasonConfirm').click();

  await expect.poll(() => page.evaluate(() => window._swIntegration.getSyncState().jobId))
    .toBe('20000000-0000-4000-8000-000000000002');
  const calls = await page.evaluate(() => window.__swCalls);
  const mint = calls.find((call) => call.action === 'mint_fence_job');
  expect(mint).toBeTruthy();
  expect(mint.body.intent).toBe('DELIBERATE_REPEAT');
  expect(mint.body.repeatReason).toBe('Second boundary fence');
  expect(calls.some((call) => ['create_contact_and_opportunity', 'create_job'].includes(call.action))).toBeFalsy();
});

test('local iPad draft promotes then cloud-saves against the canonical job', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    Object.assign(window.app.job, {
      clientFirstName: 'TEST-ZZZ', clientLastName: 'Local Draft',
      phone: '0404777984', email: 'test-zzz@example.com',
      address: '1 Test Lab Way', suburb: 'Perth',
    });
    const localDraftId = window.app.job._fieldSync.localDraftId;
    window.app._collectOutputData = () => ({ grandTotal: 2200, internalCost: 900, internalLabour: 500 });
    await window._swIntegration.save();
    return { localDraftId, sync: window._swIntegration.getSyncState(), calls: window.__swCalls };
  });

  expect(result.localDraftId).toMatch(/^local-fence-/);
  expect(result.sync.jobId).toBe('20000000-0000-4000-8000-000000000002');
  expect(result.calls.some((call) => call.action === 'mint_fence_job')).toBeTruthy();
  expect(result.calls.some((call) => call.action === 'save_scope')).toBeTruthy();
  expect(result.calls.some((call) => ['create_contact_and_opportunity', 'create_job'].includes(call.action))).toBeFalsy();
});

test('loadPicker consumes the minted job id, never a replication-sensitive re-resolve', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    const done = new Promise((resolve) => { window.__pickerDone = resolve; });
    // Drive loadPicker with an UNRESOLVED opportunity (no supabaseJobId). The
    // guarded entry owner mints a canonical job; loadPicker must load THAT id.
    window.SECUREWORKS_CLOUD.ui.showGHLPicker = function(_toolType, onSelect) {
      Promise.resolve(onSelect({
        id: 'opp-fresh-picker', contactId: 'contact-test-zzz', contactName: 'TEST-ZZZ Picker Lead',
        contactPhone: '0404777984', contactEmail: 'test-zzz@example.com',
      })).then(() => window.__pickerDone());
    };
    window._swIntegration.loadPicker();
    await done;
    return { sync: window._swIntegration.getSyncState(), calls: window.__swCalls };
  });

  expect(result.sync.jobId).toBe('20000000-0000-4000-8000-000000000002');
  // Exactly one find_job (inside the guarded preflight); the door consumes the
  // minted id via load_job rather than re-resolving after the mint.
  expect(result.calls.filter((call) => call.action === 'find_job')).toHaveLength(1);
  expect(result.calls.some((call) => call.action === 'load_job')).toBeTruthy();
  expect(result.calls.filter((call) => call.action === 'mint_fence_job')).toHaveLength(1);
  expect(result.calls.some((call) => ['create_contact_and_opportunity', 'create_job'].includes(call.action))).toBeFalsy();
});

test('online live prices and fallback states are labelled truthfully', async ({ browser }) => {
  const liveContext = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
  const livePage = await liveContext.newPage();
  await openFixture(livePage, true);
  await expect(livePage.locator('#priceSource')).toContainText('Live DB prices');
  await expect(livePage.locator('#priceSource')).not.toContainText('OFFLINE');
  await liveContext.close();

  const fallbackContext = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
  const fallbackPage = await fallbackContext.newPage();
  await openFixture(fallbackPage, false);
  await expect(fallbackPage.locator('#priceSource')).toContainText('Live price table unavailable');
  await expect(fallbackPage.locator('#priceSource')).not.toContainText('OFFLINE');
  await fallbackContext.setOffline(true);
  await fallbackPage.evaluate(() => setFencePriceSource(null));
  await expect(fallbackPage.locator('#priceSource')).toContainText('OFFLINE');
  await fallbackContext.close();
});

// fence-designer-qa-quote-zero, 2026-08-14: send-quote's server-side pricing
// gate (secureworks-backend supabase/functions/send-quote/index.ts) reads
// jobs.pricing_json straight from the database, not whatever this tab just
// computed. Material Verification's confirm step only calls app.save()
// (localStorage, never the network), and by the time an operator reaches
// Send Quote the job number is normally already assigned — which skips the
// one branch in showSendQuoteModal() that used to force a cloud save. The
// only thing that would otherwise push fresh pricing to the DB was the
// lagging 30s autosave tick, so an operator who reviews Material
// Verification and hits Send (a normal, fast interaction) could have the
// server refuse with "Quote total is zero or missing" even though the live
// quote in the browser was fully priced — everything really was "on there".
test('send-quote saves fresh pricing to the cloud before calling prepare_quote, even when the job number is already assigned', async ({ page }) => {
  await openFixture(page);

  const result = await page.evaluate(async () => {
    // A job that already has a real cloud id + assigned job number — the
    // exact condition that used to skip showSendQuoteModal()'s only cloud
    // save. Mirrors reopening/continuing a job past its initial mint.
    window._swIntegration._connectJob(
      '20000000-0000-4000-8000-000000000002', 'opp-test-zzz', 'contact-test-zzz', 'draft'
    );
    Object.assign(window.app.job, {
      clientFirstName: 'TEST-ZZZ', clientLastName: 'Khairo Repro',
      phone: '0404777984', email: 'test-zzz@example.com',
      address: '1 Test Lab Way', suburb: 'Perth', scoper: 'Khairo',
      ref: 'SWF-TEST-2301',
    });
    window.app.job.runs = [{
      name: 'Run 1', length: 25,
      panels: Array.from({ length: 8 }, () => ({ height: 1800, retaining: 0, slopePlinths: 0 })),
    }];
    window.fenceQA._verificationState = { scoper: { signedOff: true } };

    const liveTotal = window.app._collectOutputData().grandTotal;

    // Drive the real compose-modal + send code path (not a shortcut re-implementation).
    window._showSendQuoteModalInternal();
    window._sqLastTo = 'test-zzz@example.com';
    window._sqLastMessage = ''; window._sqLastCC = ''; window._sqLastSubject = '';
    window._sqLastLibPaths = []; window._sqNeighbourSend = null;
    try { await window.executeSendQuote(); } catch (_) { /* prepare_quote isn't mocked past this point — irrelevant to this test */ }

    const calls = window.__swCalls;
    const saveIdx = calls.findIndex((c) => c.action === 'save_scope');
    const prepIdx = calls.findIndex((c) => c.action === 'prepare_quote');
    const savedPricing = saveIdx >= 0 ? calls[saveIdx].body?.meta?.pricing_json : null;
    return { liveTotal, saveIdx, prepIdx, savedTotalIncGST: savedPricing?.totalIncGST };
  });

  expect(result.liveTotal).toBeGreaterThan(0);
  expect(result.saveIdx).toBeGreaterThanOrEqual(0);
  // The cloud save must land before the quote is prepared/sent, and it must
  // carry the same non-zero total the operator saw on screen.
  expect(result.prepIdx).toBeGreaterThan(result.saveIdx);
  expect(result.savedTotalIncGST).toBe(result.liveTotal);
});

// Fail-closed companion to the test above: when the forced pre-send save
// cannot actually reach the server (the 5xx/408/429/auth-downgrade family —
// cloud.js saveScope queues the scope locally instead of writing), the send
// must STOP with honest copy rather than proceed to prepare_quote against a
// stale or missing DB pricing_json — which would reproduce the very
// "Quote total is zero or missing" refusal the forced save exists to prevent.
test('send-quote fails closed when the pre-send pricing save only queues locally', async ({ page }) => {
  await openFixture(page);

  const result = await page.evaluate(async () => {
    window._swIntegration._connectJob(
      '20000000-0000-4000-8000-000000000002', 'opp-test-zzz', 'contact-test-zzz', 'draft'
    );
    Object.assign(window.app.job, {
      clientFirstName: 'TEST-ZZZ', clientLastName: 'Khairo Repro',
      phone: '0404777984', email: 'test-zzz@example.com',
      address: '1 Test Lab Way', suburb: 'Perth', scoper: 'Khairo',
      ref: 'SWF-TEST-2301',
    });
    window.app.job.runs = [{
      name: 'Run 1', length: 25,
      panels: Array.from({ length: 8 }, () => ({ height: 1800, retaining: 0, slopePlinths: 0 })),
    }];
    window.fenceQA._verificationState = { scoper: { signedOff: true } };

    const fixtureFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/functions/v1/ghl-proxy') && url.includes('action=save_scope')) {
        let body = null;
        try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
        window.__swCalls.push({ action: 'save_scope', body });
        return Promise.resolve(new Response(JSON.stringify({ error: 'db unavailable' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        }));
      }
      return fixtureFetch(input, init);
    };

    window._showSendQuoteModalInternal();
    window._sqLastTo = 'test-zzz@example.com';
    window._sqLastMessage = ''; window._sqLastCC = ''; window._sqLastSubject = '';
    window._sqLastLibPaths = []; window._sqNeighbourSend = null;
    try { await window.executeSendQuote(); } catch (_) { /* the send must fail — how it surfaces is asserted below */ }

    const overlay = document.getElementById('sendQuoteModal');
    return {
      saveAttempted: window.__swCalls.some((c) => c.action === 'save_scope'),
      prepared: window.__swCalls.some((c) => c.action === 'prepare_quote'),
      overlayText: overlay ? overlay.textContent : '',
    };
  });

  expect(result.saveAttempted).toBe(true);
  // The refusal must happen BEFORE any quote number is reserved or sent.
  expect(result.prepared).toBe(false);
  expect(result.overlayText).toContain('Send Failed');
  expect(result.overlayText).toContain('sync_required');
});

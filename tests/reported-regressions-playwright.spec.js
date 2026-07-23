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
    if (action === 'lead_search') return reply({ opportunities: [{
      id: null, contactId: 'contact-test-zzz', contactName: 'TEST-ZZZ Khairo Lead',
      contactPhone: '0404777984', contactEmail: 'test-zzz@example.com',
      address: '1 Test Lab Way', suburb: 'Perth',
    }] });
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

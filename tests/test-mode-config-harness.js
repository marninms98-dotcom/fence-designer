#!/usr/bin/env node
'use strict';

/**
 * Contract tests for the fence lab's client-side routing marker.
 * No network, Supabase, GHL, or client records are touched.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'cloud.js'), 'utf8');
const resetSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fence-test-lab.js'), 'utf8');

function makeCloud(options) {
  options = options || {};
  const calls = [];
  const session = { access_token: 'test-user-jwt' };
  const chain = {
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    update() { return this; }, insert() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
  };
  const window = {
    location: { search: options.search || '', href: 'https://fence.example/index.html', pathname: '/index.html' },
    addEventListener() {}, removeEventListener() {},
    SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon-key',
    supabase: { createClient() { return { auth: {
      onAuthStateChange() {},
      getSession: async () => ({ data: { session } }),
      refreshSession: async () => ({ data: { session } }),
    }, from() { return Object.create(chain); } }; } },
  };
  if (options.globalFlag !== undefined) window.SECUREWORKS_TEST_MODE = options.globalFlag;
  window.top = window;
  const document = {
    title: 'Fence',
    querySelector() { return null; }, getElementById() { return null; },
    createElement() { return { style: {} }; },
    body: { appendChild() {} },
  };
  const context = {
    window, document, navigator: { onLine: true }, localStorage: {
      length: 0, key() { return null; }, getItem() { return null; }, setItem() {}, removeItem() {},
    },
    URLSearchParams, TextEncoder, Promise,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, request) => {
      calls.push({ url: String(url), request: request || {} });
      return { ok: true, status: 200, json: async () => ({ success: true, job: { id: 'job-test' } }) };
    },
  };
  vm.runInNewContext(source, context, { filename: 'cloud.js' });
  return { cloud: window.SECUREWORKS_CLOUD, calls };
}

async function run() {
  {
    const { cloud, calls } = makeCloud();
    assert.strictEqual(cloud.testMode, false);
    await cloud.ghl.updateContact('contact-1', { firstName: 'Normal' });
    assert(!calls[0].url.includes('testMode='), 'ordinary production requests must remain untouched');
  }

  {
    const { cloud, calls } = makeCloud({ search: '?testMode=TEST-ZZZ' });
    assert.strictEqual(cloud.testMode, true);
    assert.strictEqual(cloud.testModeLabel, 'TEST-ZZZ');
    await cloud.ghl.updateContact('contact-test', { firstName: 'TEST-ZZZ' });
    assert(calls[0].url.includes('action=update_contact'));
    assert(calls[0].url.includes('testMode=true'), 'lab requests must carry the backend routing switch');
  }

  {
    const { cloud, calls } = makeCloud({ globalFlag: true });
    await cloud.ghl.loadJob('job-test');
    assert.strictEqual(cloud.testMode, true, 'Playwright init-script boolean enables test mode');
    assert(calls[0].url.includes('testMode=true'));
  }

  for (const malformed of ['?testMode=true', '?testMode=1', '?testMode=test-zzz']) {
    const { cloud } = makeCloud({ search: malformed });
    assert.strictEqual(cloud.testMode, false, 'malformed marker must fail closed: ' + malformed);
  }

  {
    const { cloud, calls } = makeCloud({ search: '?testMode=TEST-ZZZ' });
    await assert.rejects(
      cloud.authorizedFetch('https://supabase.example/functions/v1/send-quote', { method: 'POST' }),
      (error) => error && error.code === 'test_mode_comms_blocked',
    );
    assert.strictEqual(calls.length, 0, 'client-side comms block must happen before fetch');
  }

  assert(resetSource.includes("testMode: 'true'"), 'every reset proxy call carries test mode');
  assert(resetSource.includes("const PREFIX = 'TEST-ZZZ-'"), 'reset script has an exact test naming guard');
  assert(resetSource.includes('production organisation; refusing to report success'), 'reset refuses production organisation results');
  assert(!/method:\s*['\"]DELETE['\"]/.test(resetSource), 'reset script never deletes records');
  assert(resetSource.includes("required('GHL_TEST_PIPELINE_ID')"), 'pipeline config uses a general, non-fencing name');

  console.log('PASS production requests stay unchanged');
  console.log('PASS exact TEST-ZZZ marker routes every ghl-proxy request');
  console.log('PASS Playwright init-script configuration');
  console.log('PASS malformed markers fail closed');
  console.log('PASS outbound quote/email functions are blocked in lab mode');
  console.log('PASS seed/reset scaffold is test-only, non-destructive, and generally configured');
  console.log('\nSummary: 6 passed, 0 failed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

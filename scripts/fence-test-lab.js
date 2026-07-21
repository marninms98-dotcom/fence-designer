#!/usr/bin/env node
'use strict';

/**
 * Idempotently create or restore the TEST-ZZZ fence save fixture.
 *
 * This script never deletes records and every write is sent with testMode=true.
 * Run with --check for read-only verification or --reset for the explicit write.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'test-lab', 'fence-save-001.scope.json');
const PREFIX = 'TEST-ZZZ-';
const FIXTURE_NAME = 'TEST-ZZZ-FENCE-SAVE-001 LAB';
const args = new Set(process.argv.slice(2));
const mode = args.has('--reset') ? 'reset' : args.has('--check') ? 'check' : null;

function fail(message) {
  const error = new Error(message);
  error.name = 'FenceTestLabError';
  throw error;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) fail('Missing required environment variable: ' + name);
  return value;
}

function assertSafeFixtureName(name, label) {
  if (!String(name || '').startsWith(PREFIX)) {
    fail(label + ' is not a TEST-ZZZ record; refusing to continue: ' + String(name || '<blank>'));
  }
}

function normalizedPhone(value) {
  return String(value || '').replace(/[^+\d]/g, '');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalJson(value[key]);
      return out;
    }, {});
  }
  return value;
}

async function jsonResponse(response, label) {
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const detail = data && (data.error || data.message || data.code);
    fail(label + ' failed (HTTP ' + response.status + ')' + (detail ? ': ' + detail : ''));
  }
  return data || {};
}

async function main() {
  if (!mode || (args.has('--reset') && args.has('--check'))) {
    fail('Choose exactly one mode: --check (read-only) or --reset (writes TEST-ZZZ records only).');
  }

  const supabaseUrl = required('FENCE_TEST_SUPABASE_URL').replace(/\/$/, '');
  const anonKey = required('FENCE_TEST_SUPABASE_ANON_KEY');
  const testPipelineId = required('GHL_TEST_PIPELINE_ID');
  const testNewLeadStageId = required('GHL_TEST_NEW_LEAD_STAGE_ID');
  const userEmail = required('FENCE_TEST_USER_EMAIL');
  const userPassword = required('FENCE_TEST_USER_PASSWORD');
  const sinkEmail = required('FENCE_TEST_SINK_EMAIL').toLowerCase();
  const sinkPhone = normalizedPhone(required('FENCE_TEST_SINK_PHONE'));
  const approval = required('FENCE_TEST_SINKS_APPROVED');

  if (!/^https:\/\/[^/]+\.supabase\.co$/i.test(supabaseUrl)) fail('FENCE_TEST_SUPABASE_URL must be an https://*.supabase.co origin.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sinkEmail)) fail('FENCE_TEST_SINK_EMAIL is not a valid sink address.');
  if (!/^\+[1-9]\d{7,14}$/.test(sinkPhone)) fail('FENCE_TEST_SINK_PHONE must be an approved E.164 sink number.');
  if (approval !== 'YES-CAPTAIN-APPROVED') fail('Sink ownership has not been attested. Set FENCE_TEST_SINKS_APPROVED=YES-CAPTAIN-APPROVED only after Captain approval.');

  const auth = await jsonResponse(await fetch(supabaseUrl + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: userPassword }),
  }), 'TEST-ZZZ user login');
  const token = auth.access_token;
  if (!token) fail('TEST-ZZZ user login returned no access token.');

  async function proxy(action, options) {
    options = options || {};
    const query = new URLSearchParams(Object.assign({}, options.query || {}, {
      action,
      testMode: 'true',
    }));
    const response = await fetch(supabaseUrl + '/functions/v1/ghl-proxy?' + query.toString(), {
      method: options.body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return jsonResponse(response, 'ghl-proxy ' + action);
  }

  async function search(query, pipeline) {
    const data = await proxy('lead_search', { query: { q: query, pipeline: pipeline || '' } });
    return Array.isArray(data.opportunities) ? data.opportunities : [];
  }

  function displayName(row) {
    return String((row && (row.contactName || row.name)) || '').trim();
  }

  function exactFixtures(rows) {
    return rows.filter((row) => displayName(row).toUpperCase() === FIXTURE_NAME);
  }

  // Before any create, prove the approved sinks do not resolve to a non-test
  // contact. This prevents GHL dedup from attaching a lab opportunity to a real
  // team/client contact that happens to share an email or phone.
  for (const sink of [sinkEmail, sinkPhone]) {
    const matches = await search(sink, '');
    const unsafe = matches.find((row) => displayName(row) && !displayName(row).startsWith(PREFIX));
    if (unsafe) fail('Approved sink resolves to non-test GHL contact "' + displayName(unsafe) + '"; refusing all writes.');
  }

  let rows = await search(FIXTURE_NAME, 'fencing');
  const fixtureRows = exactFixtures(rows);
  const opportunityRows = fixtureRows.filter((row) => row.id);
  if (opportunityRows.length > 1) {
    fail('More than one TEST-ZZZ fixture opportunity exists. Refusing an ambiguous reset; a GHL lab admin must reconcile test-only duplicates.');
  }
  let lead = opportunityRows[0] || fixtureRows[0] || null;
  if (lead && lead.pipelineId && lead.pipelineId !== testPipelineId) {
    fail('TEST-ZZZ fixture resolved outside the configured general test pipeline; refusing all writes.');
  }
  if (mode === 'check' && lead && lead.stageName && String(lead.stageName).trim() !== 'New Lead') {
    fail('TEST-ZZZ fixture is not in the known New Lead stage. Run with --reset.');
  }
  let contactId = lead && lead.contactId;
  let opportunityId = lead && lead.id;

  if (mode === 'reset' && !contactId) {
    // Contact first, without an opportunity. If GHL dedup unexpectedly finds an
    // existing contact, fetch and validate its TEST-ZZZ name before any pipeline
    // record is created.
    const contactResult = await proxy('create_contact_and_opportunity', {
      body: {
        firstName: 'TEST-ZZZ-FENCE-SAVE-001',
        lastName: 'LAB',
        email: sinkEmail,
        phone: sinkPhone,
        address: '1 Test Lab Way',
        suburb: 'Perth',
        toolType: 'fencing',
        skipOpportunity: true,
      },
    });
    contactId = contactResult.contactId;
    if (!contactId) fail('TEST-ZZZ contact create returned no contactId.');
    const fetched = await proxy('contact', { query: { contactId } });
    const fetchedName = displayName(fetched.contact || {});
    assertSafeFixtureName(fetchedName, 'GHL dedup target');
  }

  if (mode === 'reset' && contactId && !opportunityId) {
    const oppResult = await proxy('create_contact_and_opportunity', {
      body: { contactId, toolType: 'fencing' },
    });
    opportunityId = oppResult.opportunityId;
    if (!opportunityId) fail('TEST-ZZZ opportunity create returned no opportunityId.');
  }

  if (!contactId || !opportunityId) {
    fail('TEST-ZZZ fixture is not fully seeded. Run this command with --reset after backend and GHL lab provisioning is complete.');
  }
  assertSafeFixtureName(displayName(lead || { name: FIXTURE_NAME }), 'Selected fixture');

  if (mode === 'reset') {
    await proxy('update_contact', {
      body: {
        contactId,
        firstName: 'TEST-ZZZ-FENCE-SAVE-001',
        lastName: 'LAB',
        email: sinkEmail,
        phone: sinkPhone,
        address: '1 Test Lab Way',
        suburb: 'Perth',
      },
    });
    const moved = await proxy('move_stage', {
      body: { opportunityId, stageId: testNewLeadStageId, jobType: 'fencing' },
    });
    if (moved.success !== true || moved.stageId !== testNewLeadStageId) {
      fail('Could not restore the TEST-ZZZ opportunity to the configured New Lead stage.');
    }
  }

  let jobData = await proxy('find_job', { query: { opportunityId, type: 'fencing' } });
  let job = jobData.job || null;
  if (mode === 'reset' && !job) {
    const created = await proxy('create_job', {
      body: {
        opportunityId,
        contactId,
        toolType: 'fencing',
        clientName: FIXTURE_NAME,
        clientPhone: sinkPhone,
        clientEmail: sinkEmail,
        siteAddress: '1 Test Lab Way',
        siteSuburb: 'Perth',
      },
    });
    job = created.job;
  }
  if (!job || !job.id) fail('TEST-ZZZ fixture has no Supabase fencing job. Run with --reset.');

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  // Keep sink values out of git while making the persisted browser fixture a
  // faithful contact round trip.
  fixture.job.email = sinkEmail;
  fixture.job.phone = sinkPhone;
  let loadResult = await proxy('load_job', { query: { jobId: job.id } });
  let loaded = loadResult.job;
  if (loaded) loaded.current_scope_hash = loadResult.current_scope_hash || loaded.current_scope_hash || null;
  if (!loaded || loaded.id !== job.id) fail('Could not load the TEST-ZZZ job for verification.');

  if (mode === 'reset') {
    const meta = {
      scopeCursorReconcileV1: true,
      scopeCursorJobId: job.id,
      scopeCursorProvenance: 'server_issued',
      client_name: FIXTURE_NAME,
      client_phone: sinkPhone,
      client_email: sinkEmail,
      site_address: '1 Test Lab Way',
      site_suburb: 'Perth',
      notes: 'TEST-ZZZ fence save-path lab fixture',
    };
    if (loaded.current_scope_hash) meta.baseScopeHash = loaded.current_scope_hash;
    await proxy('save_scope', { body: { jobId: job.id, scopeJson: fixture, meta } });
    loadResult = await proxy('load_job', { query: { jobId: job.id } });
    loaded = loadResult.job;
    if (loaded) loaded.current_scope_hash = loadResult.current_scope_hash || loaded.current_scope_hash || null;
  }

  if (JSON.stringify(canonicalJson(loaded.scope_json || null)) !== JSON.stringify(canonicalJson(fixture))) {
    fail('Persisted scope does not match fence-save-001.scope.json. Run with --reset to restore it.');
  }
  if (String(loaded.org_id || '') === '00000000-0000-0000-0000-000000000001') {
    fail('TEST-ZZZ job landed in the production organisation; refusing to report success.');
  }
  assertSafeFixtureName(loaded.client_name, 'Persisted Supabase job');

  const state = {
    mode: 'TEST-ZZZ',
    fixture: 'fence-save-001',
    contactId,
    opportunityId,
    jobId: job.id,
    currentScopeHash: loaded.current_scope_hash || null,
    verifiedAt: new Date().toISOString(),
  };
  const stateFile = path.resolve(process.env.FENCE_TEST_STATE_FILE || path.join(ROOT, '.fence-test-lab-state.json'));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(state, null, 2));
}

main().catch((error) => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});

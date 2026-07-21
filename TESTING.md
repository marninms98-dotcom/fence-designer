# Fence save-path testing

## Rung 4: TEST-ZZZ write lab

The write lab is the only approved target for tests that create or update a GHL contact/opportunity, create a Supabase job, or save a fence scope. Do not run write-path tests against a client record.

The lab uses two isolation boundaries inside the real stack:

1. A dedicated Supabase organisation and seeded test user isolate jobs and scope data from production organisation queries.
2. The dedicated general GHL pipeline `TESTTESTTEST` isolates test opportunities from the sales pipelines used by the team. It is shared by fencing, patios, and future tool labs. It is not fencing-only.

A separate GHL location was not chosen. The scoping save paths currently use one location-backed `ghl-proxy`, while Supabase organisation ownership is the actual job-data boundary. A test organisation plus a separate general pipeline exercises the real integration with less duplicated location configuration. The proxy must still fail closed when its test organisation or pipeline IDs are absent.

GHL configuration approved by the Captain on 2026-07-21:

| Setting | Value |
|---|---|
| Pipeline name | `TESTTESTTEST` |
| Pipeline ID | `kMSiJnd4KyPyIUletHbH` |
| Location ID | `13yKADzN94BRxX4hByYX` |
| New Lead stage | `61c23e36-8d28-4389-95f2-107f79173d6b` |
| Contacted stage | `25f5edbd-5b3e-45da-b9f7-7f91c452a339` |
| Proposal Sent stage | `76a9b4e7-b01e-4392-850c-12b8375886e1` |
| Closed stage | `53dcf750-f20a-4877-822b-e06c311f9a75` |

Backend configuration should use general names such as `GHL_TEST_PIPELINE_ID` and `GHL_TEST_NEW_LEAD_STAGE_ID`, not fencing-only names. These IDs are backend deployment configuration, not browser secrets.

All lab contacts, opportunities, and jobs start with `TEST-ZZZ-`. The canonical fencing fixture is `TEST-ZZZ-FENCE-SAVE-001 LAB`.

### Provisioning gate

The lab is ready only when all of these are true:

- `ghl-proxy` test-mode routing is deployed with `--no-verify-jwt`.
- Backend secrets contain the test organisation plus the general `TESTTESTTEST` pipeline/stage IDs above. A test request must fail rather than fall back to production when any required ID is absent.
- The seeded Supabase Auth user belongs to the dedicated test organisation.
- The general GHL test pipeline has no workflows, automations, SMS, email, assignment, or calendar actions attached. Any location-wide workflow is audited to exclude `TEST-ZZZ-` contacts.
- The Captain-approved team sink email and phone are configured.
- `node scripts/fence-test-lab.js --reset` and then `--check` both pass.

Do not treat the committed scaffold as proof that external provisioning is complete.

## Enable test mode

Use the exact URL marker:

```text
?testMode=TEST-ZZZ
```

For example:

```text
https://<fence-host>/index.html?testMode=TEST-ZZZ
```

`cloud.js` converts that marker to `testMode=true` on every `ghl-proxy` request. It also exposes:

```js
window.SECUREWORKS_CLOUD.testMode === true
window.SECUREWORKS_CLOUD.testModeLabel === 'TEST-ZZZ'
```

Playwright may set the equivalent boolean before page scripts load:

```js
await page.addInitScript(() => {
  window.SECUREWORKS_TEST_MODE = true;
});
```

Only the exact query value or literal boolean `true` enables the lab. Values such as `testMode=true`, `1`, or lower-case `test-zzz` stay in normal production mode. Production requests are otherwise unchanged.

A red `TEST-ZZZ LAB · NO CLIENT COMMS` marker appears in the browser. In test mode, the client also blocks direct calls to `send-quote`, `send-outlook-email`, and `send-po-email`. The backend remains the authoritative communications block and must reject test-mode SMS/email actions even if GHL is misconfigured.

## Credentials and configuration

Copy the names from [`tests/test-lab/.env.example`](tests/test-lab/.env.example) into the local shell, CI secret store, or the queued Playwright project's secret configuration. Never commit a populated env file.

Required values:

- `FENCE_TEST_SUPABASE_URL`: public Supabase project URL
- `FENCE_TEST_SUPABASE_ANON_KEY`: public anon key
- `GHL_TEST_PIPELINE_ID`: general `TESTTESTTEST` pipeline ID
- `GHL_TEST_NEW_LEAD_STAGE_ID`: general pipeline's New Lead stage ID
- `FENCE_TEST_USER_EMAIL`: seeded TEST-ZZZ Auth user
- `FENCE_TEST_USER_PASSWORD`: secret test-user password
- `FENCE_TEST_SINK_EMAIL`: Captain-approved team-owned sink
- `FENCE_TEST_SINK_PHONE`: Captain-approved team-owned sink in E.164 format
- `FENCE_TEST_SINKS_APPROVED=YES-CAPTAIN-APPROVED`: explicit sink-ownership attestation

Optional:

- `FENCE_TEST_STATE_FILE`: output path for fixture IDs, default `.fence-test-lab-state.json`

The backend separately owns its test organisation plus general test pipeline/stage environment variables and GHL API token. The non-secret pipeline/stage IDs are recorded above, but they do not belong in browser or Playwright configuration. The GHL token remains secret.

## Seed or reset the fixture

The script never deletes records. It only selects names beginning with `TEST-ZZZ-`, sends every API request with `testMode=true`, and refuses success if the job lands in the production organisation.

Read-only verification:

```bash
node scripts/fence-test-lab.js --check
```

Explicitly restore the known contact, opportunity, job, and scope state:

```bash
node scripts/fence-test-lab.js --reset
node scripts/fence-test-lab.js --check
```

The reset sequence:

1. Signs in as the seeded TEST-ZZZ user.
2. Checks the approved email and phone do not resolve to a non-test GHL contact.
3. Reuses the exact TEST-ZZZ contact/opportunity, or creates only the missing test records.
4. Restores the contact fields to the approved sinks.
5. Restores the opportunity to the general pipeline's New Lead stage.
6. Reuses or creates the opportunity-linked fencing job.
7. Saves [`tests/test-lab/fence-save-001.scope.json`](tests/test-lab/fence-save-001.scope.json) using the server-issued scope cursor.
8. Loads the job again and canonically compares the persisted JSON structure.
9. Writes non-secret IDs to `.fence-test-lab-state.json` with file mode `0600`.

If GHL dedup points at a non-TEST contact, the script stops before updating it. If the test route is unconfigured, the backend must reject the request. There is no production fallback.

## Playwright consumer contract

The queued fence-designer E2E suite should:

1. Run the reset command once in setup.
2. Read `.fence-test-lab-state.json` for `contactId`, `opportunityId`, `jobId`, and `currentScopeHash`.
3. Open the fence app with `?testMode=TEST-ZZZ`, or use the init-script boolean.
4. Authenticate as the seeded TEST-ZZZ user. Do not use a production staff storage state.
5. Select only `TEST-ZZZ-FENCE-SAVE-001 LAB` and assert the browser test-mode marker is visible.
6. Edit the scope, wait for the saved state, then load the same `jobId` through the flagged `ghl-proxy` path and verify persistence.
7. Exercise contact update only on the state-file `contactId`.
8. Run reset again in teardown so the next suite starts from the canonical fixture.

A suite must abort if `SECUREWORKS_CLOUD.testMode` is not true, the selected name lacks `TEST-ZZZ-`, the state file is absent, or reset/check fails.

Run the local no-network contract test with:

```bash
node tests/test-mode-config-harness.js
```

## Communications proof

Zero-client-risk is layered rather than based on naming alone:

- Supabase test organisation prevents test jobs entering production organisation views.
- The general `TESTTESTTEST` GHL pipeline keeps opportunities out of every live tool sales view.
- The test pipeline has no outbound workflows.
- The proxy blocks communications for every flagged test request.
- The browser blocks direct quote/email functions in test mode.
- Records use only Captain-approved team sinks.
- The script refuses non-TEST records and refuses a production organisation result.

A `TEST-ZZZ` prefix is a visual warning, not the security boundary.

## Rung 6 production canary policy

Rung 6 is policy only. This repository setup does not authorise any production canary.

Every individual production canary requires the Captain's explicit, recorded, per-use go. A previous approval, this lab approval, a green test suite, or a similar earlier canary is not permission. The approved run must identify the one production job, operator, time window, exact writes, observation plan, and stop conditions. It must be supervised throughout and must stop on any unexpected write or communication.

Without that fresh approval, use the TEST-ZZZ lab for writes. Where the lab cannot apply, use `chrome-devtools-axi` against real surfaces read-only.

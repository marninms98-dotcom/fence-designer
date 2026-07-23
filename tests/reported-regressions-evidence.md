# Fence field regression evidence, 2026-07-23

## Diagnosis

1. **GHL lead load refusal:** confirmed client integration fault. Merged PR 63 deliberately stopped an unresolved fencing context with `server_mint_required`. Its completing client integration existed only in stranded commit `4518bee`, so the deployed client never called the server-owned mint command.
2. **Local iPad promotion refusal:** same initiating fault through a different entry door. The local save path deliberately threw `server_mint_required` before any cloud write. Resume-local remained healthy because it does not cross the local-to-cloud identity boundary.
3. **OFFLINE pricing banner:** independent load-order fault. The inline pricing bootstrap ran before bottom-of-page `cloud.js`, permanently selected fallback, and made no pricing request. The live central table was reachable and returned 68 rows when called after cloud initialization.

The mint hypothesis would have been falsified if the deployed client contained `cloud.ghl.mintFenceJob`, if either refusal followed a failed `mint_fence_job` request, or if the backend action was absent. None was true. The pricing hypothesis would have been falsified by a pricing request before the fallback label or by an unreachable central table. Neither occurred.

## Reproduction boundary

The deployed GitHub Pages artifact was exercised at a 1024 x 1366 iPad-like viewport with `chrome-devtools-axi`.

- The price symptom reproduced directly while `navigator.onLine === true`.
- The two exact refusal messages reproduced in the deployed entry/save owners. This browser had no Khairo or TEST-ZZZ credentials, so auth and valid save data were fixture-enabled in page memory only. Both paths stopped before network I/O, and no production write was attempted.

## Backend contract proof

Backend PR 341 is merged. A read-only/rejected production probe to
`POST /functions/v1/ghl-proxy?action=mint_fence_job` using the shared-key path returned HTTP 401 with the exact action-specific contract:

```json
{"error":"mint_fence_job requires an authenticated Supabase user","code":"user_jwt_required","details":null}
```

That proves the deployed dispatcher contains the server-mint action and enforces its user-JWT-only boundary. The recovered client request and canonical response fields match `docs/fence-mint-contract.md` in the backend repository.

## Regression results

- Existing compatibility ladder: **160 passed, 0 failed** across the ten fixture/runtime/browser harnesses in `npm run test:fixtures`.
- Cloud save compatibility rung: **15 passed, 0 failed** in `tests/cp3-cloud-sync-behavior-harness.js` (included in the 160 total).
- New Playwright iPad regressions: **5 passed, 0 failed** in `tests/reported-regressions-playwright.spec.js`.
  - Load-mode contact-only GHL lead calls `mint_fence_job` and adopts the canonical job.
  - Local draft promotes, then calls `save_scope`, without either legacy browser create primitive.
  - `loadPicker` consumes the id the guarded owner already resolved/minted via `load_job` — exactly one `find_job` (the preflight), no post-mint re-resolve that could orphan a fresh mint.
  - Reachable live pricing, online table-unavailable fallback, and actual offline labels remain distinct.

## Post-review hardening (loadPicker consume + promotion clobber)

Two follow-up review findings on the recovered client were fixed forward:

1. **`loadPicker` re-resolve:** the GHL picker door discarded the id the guarded preflight already minted and re-called `findJobByOpportunity`, which on replication lag returned null and hard-stopped `identity_changed_during_entry` *after* a job was created, orphaning it. Now it loads `opp.supabaseJobId || opp._supabaseJobId || permit.target.jobId` directly. Proven by the new Playwright test above and source contracts in `tests/entry-funnel-runtime-harness.js`.
2. **`local_save_promotion` clobber:** a local draft whose opportunity mapped to an existing *scoped* cloud job forced `keepLocal`, bypassing the `requiresLoad` redirect and overwriting that scope via compare-and-save. The redirect now fires unless the operator explicitly chose `keep_link`, and the promotion caller bails before `saveScope`, so the existing scope is hydrated/reconciled first. The index.html promotion caller is not executable in the node harness, so this is proven by executed/source contracts in `tests/entry-funnel-runtime-harness.js` (no `!keepLocal` bypass; redirect gated on `switchChoice !== 'keep_link'`; caller `requiresLoad) return` before any write).
- Post-fix local browser proof reached the real central pricing table with HTTP 200 and displayed `Live DB prices` at 1024 x 1366.

## Recovery provenance

Recovered unchanged from stranded commit `4518bee`: guarded mint transport, persisted request UUID ownership, canonical identity application, GHL and local-promotion entry wiring, updated compatibility fixtures, and the associated `AGENTS.md` rules.

New in this branch: the independent pricing load-order fix, truthful fallback label, pinned Playwright 1.61 test setup using machine Chrome, and the three reported regression tests.

## Not tested

- No authenticated mint was sent to production or the TEST-ZZZ tenant because seeded test credentials were unavailable in this worktree.
- No production GHL contact, opportunity, Supabase job, or scope was created or changed.
- Captain post-merge deployment verification on Khairo's authenticated iPad remains required before notifying him.

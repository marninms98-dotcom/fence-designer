> **Docs hub:** read [`/Users/marninstobbe/Projects/secureworks-docs/CLAUDE.md`](/Users/marninstobbe/Projects/secureworks-docs/CLAUDE.md) first for the where-to-look table + canonical-source decision tree. **Live operational data** (jobs, invoices, contacts, POs) → Supabase `kevgrhcjxspbxgovpmfl`, never the wiki. **Historical/archived docs** (anything under `_archive/`, `strategy/dreaming/`, or carrying a "HISTORICAL SNAPSHOT" banner) are not current canon — cross-check `strategy/master-plan.md` v1.1 (2026-04-17) before acting on anything older than 2026-04.

---

# fence-designer

Fencing scoping tool (GitHub Pages). The canonical spec for this repo lives in `SPEC.md` alongside this file. Feature context: `secureworks-docs/features/fencing-scoping-tool.md`.

## M4 frozen-revision / QA / media gotchas (verified 2026-07)

- **Sent-job reopen is intentionally read-only.** `integration.js` `_autoLoadJob` (G-F1) redirects a job with `latest_frozen_scope_revision_id` to the `?scope_revision_id=` frozen viewer; that viewer sets `_isReadonly` (mode `readonly` **or** any `scope_revision_id`), which makes `save()`/`saveAfterSignOff()` bail with reason `readonly`. This input-lock is BY DESIGN — do not remove it. Editing a sent scope goes through the "Make a revision" clone flow only.
- **The frozen viewer must still LOAD media.** `_autoLoadFrozenRevision` must call `_loadCloudMedia(_jobId)` so the sealed job's site photos + video are viewable/downloadable in read-only mode. (It historically skipped media, hiding the scoper's docs on reopen.) Media load is a pure read; `_isReadonly` still blocks all writes.
- **`window.fenceQA` must be wired.** QA verification round-trips through `scope_json.verification`: `getFencingState()` reads `window.fenceQA._verificationState` on save; `loadFencingState()` restores it on reopen (`integration.js` ~690/~701). The QA object is declared `const fenceQA` in `index.html`, which is NOT a window property — so `index.html` must explicitly `window.fenceQA = fenceQA;` (right after the object, ~13415). Without it the round-trip silently no-ops (verification saved as `null`, never restored), and a reopened/sent job loses QA and re-demands sign-off. Patio uses a top-level `var patioQA` and relies on the same `window.patioQA` bridge.
- **Send/freeze does NOT hard-require a complete checklist.** The QA wizard (`runScopeChecks` in `index.html`) blocks outputs only on RED items; photos are RED only at **zero** (≥1 is fine), and <5 photos / unfinished video are AMBER (acknowledge-only). So a scope can freeze with an incomplete checklist. `validateForScopeComplete` (~13206, its "≥1 site photo" rule at ~13225) is dead code — no call site. Consider a harder pre-freeze gate as a follow-up.

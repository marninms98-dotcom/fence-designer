# Fence reconcile U1 browser evidence

Safe local harness only. No production endpoint, tenant, job or client data is used.

Run:

```bash
node tests/reconcile-two-device-browser.js
```

The harness starts a loopback HTTP server and isolated headless Chrome. Every scenario creates two separate browser contexts, an office/server observer and an iPad editor. It runs the production `cloud.js` and `integration.js` against an in-memory guarded server fixture.

Smallest counterfactual: preserve the typed 409 through `autosave:error`; when a guarded load proves the target scope is exactly `{}` and payload ownership matches that target, adopt the returned server cursor and retry the same target payload once. The first browser scenario and `autosave conflict carries payload and stops unchanged retry` in `cp3-cloud-sync-behavior-harness.js` preserve this regression.

Verified scenarios:

1. Empty server: typed `scope_hash_conflict`, guarded load proves `{}`, target ownership is checked, the returned cursor is adopted, and the iPad payload is retried once.
2. Real divergence, Keep iPad: local checkpoint read-back succeeds before one CAS write.
3. Real divergence, Take server: local checkpoint read-back succeeds before hydration.
4. Cancel: no remote write and local draft remains open.
5. Wrong ref: `scope_ref_mismatch` stops with retained local work, no cursor adoption, load, hydration or retry.
6. Capable missing cursor: `missing_scope_cursor` rehydrates a server-issued cursor before writing.
7. Empty-server retry failure: one recovery retry only, local draft retained, visible stop.
8. Unknown/absent server scope: never misclassified as proven empty.
9. Offline: local draft and ordered queue entry remain on the iPad with no server write.

Expected summary: `9 browser recovery scenarios passed, 0 failed`.

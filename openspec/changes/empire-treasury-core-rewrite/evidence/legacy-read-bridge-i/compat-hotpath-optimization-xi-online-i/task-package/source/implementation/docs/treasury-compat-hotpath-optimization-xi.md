# Treasury Compatibility Hot-path Optimization XI

## Scope

XI removes repeated bookkeeping from the existing read-only compatibility capsule. It does not change the 2 CPU cooperative budget, the default-OFF gate, authorization, persistence, table limits, source selection, task/reservation validation, eager index construction, or the independent direct/Core Store comparison.

The change is authored as two exact reversible transforms on the already-audited IX sources:

- `treasury-compat-hotpath.cjs` adapts the generated observation and commitment factories.
- `treasury-compat-preview-hotpath.cjs` adapts the preview/report path.

Reversibility proves source provenance only. Behavioral equivalence is established separately through diagnostics-OFF byte parity, full index API differential tests, seeded snapshots, callback/order checks, malformed-input checks, Memory write guards, and negative controls.

## Observation changes

Each endpoint keeps the first sparse `Object.keys(store)` result, compacts it in place to the non-zero keys already admitted into the numeric snapshot, and reuses that list when folding empire totals. The Store is not reread and its methods keep their existing receivers and call order.

The room-name lookup is populated during the existing room scan with a null-prototype object. Duplicate room names retain the prior last-room-wins lookup behavior, while the ordinal room-name list and totals retain every scanned room. Prototype-like room names remain data keys.

The final frozen observation data, public view API, callback order, epoch behavior, sparse resource semantics, and independent Store reads are unchanged.

## Commitment changes

Task and reservation authority tables are each enumerated once with `Object.keys`; the same key array supplies the authoritative record count and the keyed scan. This removes separate `Object.values` allocations without filtering or truncating the tables.

Self-routes reuse the already-resolved scope bucket rather than performing the identical second lookup. Automatic demand-health evaluation calls the canonical helper directly; manual tasks retain the canonical always-covered result. Full validation, safe-integer guards, incomplete-scope behavior, route first-match behavior, health checks, reservations, owner/expiry handling, and all eager secondary indexes remain present.

## Preview changes

The direct endpoint read accumulates the selected-resource total while the resource amounts are already being read instead of allocating a second `Object.values` traversal. `ports.resources()` is read once per admitted sample. The validated room-name list is retained and reused for the membership set, projection rows, and report output rather than recreating equivalent arrays.

No old Memory projection replaces Game Store reads. The preview still performs independent direct/Core comparison and reports partial CPU results without manufacturing completeness.

## Deterministic work reductions

The fixed synthetic characterization records the following operation reductions while preserving byte-identical diagnostics-OFF reports and full API snapshots:

- observation sparse-key enumerations: 8 → 4 for two rooms and four endpoints;
- observation room lookup: one Map allocation removed;
- authority-table `Object.values` arrays: 2 → 0;
- self-route scope lookups: one duplicate `Map.get` removed per self-route task;
- preview selected-resource `Object.values`: 4 → 0;
- preview resource-catalog reads: 2 → 1 per sample.

These are deterministic JavaScript operation counts, not Screeps CPU percentages. XI must be rebuilt from a clean committed source tree and measured in one bounded four-point online window before any engine performance conclusion.

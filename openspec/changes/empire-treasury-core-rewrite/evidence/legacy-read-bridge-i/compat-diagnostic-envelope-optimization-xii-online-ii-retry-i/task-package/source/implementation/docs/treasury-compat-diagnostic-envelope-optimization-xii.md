# Treasury Compatibility Diagnostic Envelope Optimization XII

## Scope

XII keeps the compatibility bridge read-only and default-OFF. It does not change the fixed 2 CPU cooperative budget, the two-room/two-resource scope, independent direct/Core Store reads, full legacy table validation, canonical task and reservation semantics, eager commitment indexes, four projection rows, authorization, persistence, or production writers.

The change targets work that is specific to the diagnostic preview and its successor-carried CPU completion envelope:

- the preceding report remains the authority for its full prefix profile and IX attribution;
- the following report carries only that sample's measured `serializationAndSize`, `emit`, and `retention` continuation;
- verification reconstructs the completed profile by identity-checking and merging the prefix with the tail-only completion;
- a missing successor still leaves the final sample tail unobservable; no cost is invented.

## Preview bookkeeping changes

The admitted sample resolves `Memory.data` and `Memory.runtime` once, then performs the same own-property path checks and complete bounded table scans beneath those roots. This is a per-sample cursor only, not a business-result cache.

Legacy projection comparison no longer allocates a temporary field map and key array. It checks used capacity, free capacity, and selected energy directly in the same order and preserves explicit unreadable and mismatch states.

For the fixed maximum of two rooms and four endpoint rows, room membership uses the validated room-name array instead of allocating a `Set`. Delta amounts are built in one loop rather than through `map` plus `Object.fromEntries`. Projection numeric validation no longer creates a temporary array. Frozen configured scope arrays and the completed valid-room list are reused in the report because neither is mutated after publication.

## Diagnostic completion contract

`beforeSerialization` and `fault` profiles retain the existing complete structure. An `afterRetention` profile has:

- the same `tick`, `sampleOrdinal`, `calls`, total `elapsed`, and checkpoint count;
- `completion: "tail_only"`;
- only `serializationAndSize`, `emit`, and `retention` in `phases`;
- no duplicate attribution or pre-serialization parent phases.

A verifier accepts the completion only when its identity and calls match the preceding prefix, its checkpoint count and elapsed value are monotonic, its phase keys are exactly the allowed tail set, and the merged phase sum equals completed elapsed. The previous-run CPU and emitted-byte checks remain independent.

## Safety and non-goals

XII does not:

- replace real Store reads with old Memory projections;
- omit task or reservation records;
- weaken safe-integer, owner, expiry, health, route, completeness, or corruption checks;
- cache observation or commitment business results across samples;
- raise the CPU budget or add a fifth point;
- authorize a 12-point observation or full Treasury production cutover.

Deterministic allocation and serialized-field reductions are not Screeps CPU percentages. A fresh four-point online window and independent old-production restoration are still required.

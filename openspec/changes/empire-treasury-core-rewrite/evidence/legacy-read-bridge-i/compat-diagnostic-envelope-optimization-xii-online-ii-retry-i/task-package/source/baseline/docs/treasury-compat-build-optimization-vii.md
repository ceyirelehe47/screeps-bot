# Build Optimization VII — full indexes, less intermediate work

This revision is limited to the read-only compatibility capsule. It is not a production rollout or a change to the Treasury host. Its source baseline is cdecde02ec7d364141d71f45bf21dc23969deff0 (the same source tree as Read V). CPU VI remains four diagnostics, zero complete business samples, three actual commitment builds, and closed recovery.

## Full task indexes share private bucket storage

The previous implementation stored outgoing, pending incoming, healthy incoming and outgoing-by-reason in four independent scope maps. Four other maps held incoming/outgoing room counts and receiver healthy amount/count. VII uses one map of per-scope buckets and one map of per-room buckets. The separate route map and production-reservation map remain. Bucket objects are private to one build, never shared across builders or calls.

Every canonical task is still enumerated and validated. There is no selected-resource prefilter and no lazy or omitted secondary index. Reason prefixes, first-route-wins merge ids, pending vs healthy demand, counts, receiver headroom and full index query methods remain available immediately. Self-routes and the original NUL-key aliases share the correct bucket. Safe-integer checks and the existing partial-update/continue order remain. Reservation validation, typed-owner identity, conservative unresolved ownership, expiry and callbacks are byte-identical to Read V. Receiver overlay callbacks remain live per query.

The optimization targets stable JSON authority records during one synchronous build, including malformed JSON values. It does not establish equivalence for adversarial property getters or coercion hooks which rewrite task identity/amount fields between accesses. Normal Memory JSON, stable read-only proxies, invalid records, callback/owner behavior and exceptions at the normal source boundaries are covered. No validator has been removed to enforce this domain.

## Observation intermediates

Location scans still independently enumerate each actual Store and call the same native capacity methods. The direct oracle is unchanged. Empire totals fold the owned frozen numeric snapshots via Object.keys rather than allocating Object.entries pairs. Key order, addition order, callbacks, missing locations, non-enumerable/symbol behavior, frozen data and view queries remain. A final room object is frozen directly instead of allocating a temporary object and copying it in deepFreezeRoom.

There is still a second traversal of the already-created numeric snapshot. This revision removes intermediate pairs; it does not claim a single-pass live scan or elimination of all observation allocation. Scan locations, resource dictionaries, the room index, query caches and result objects remain fresh.

## Authoring and validation

The original eight canonical TS source identities are retained. Generation composes the existing V context transform with scripts/lib/treasury-compat-build.cjs. Eleven exact count-checked VII substitutions cover task storage, aggregation/query access and two observation regions. Reversing VII restores the exact Read V prefix; reversing V then restores the original canonical prefix. Reversibility is provenance, not by itself proof of behavioral equivalence.

Two existing loader tests explicitly reverse the VII layer before checking V-only invariants; the remaining V behavioral tests are unchanged. A separate build-optimization spec exercises full index/observation APIs, detached queries, overflow, scope collisions, callbacks, freshness, mutation negative controls and 128 seeded differential snapshots. Twenty twelve-sample A/B scenarios use actual Read V and VII cores with the unchanged preview. All host data and CPU counters are synthetic. Native Map operations and temporary pair counts are observations of test-only VM instrumentation, not Screeps CPU timing.

The sole Jest wrapper remains one test in the 195-suite/685-test budget. Its Node subprocess now includes the new spec and has a bounded 180-second timeout instead of 45 seconds; no assertion or expected result is bypassed. Repository Node tests total 200; the package source slice excludes the pre-existing 19 independent tests and totals 181. Test counts are not added across these overlapping layers.

## Unchanged boundaries

The preview, direct algorithm, preflight table checks, CPU accounting and checkpoints, runtime assembly, config OFF, maxSampleCpu=2, reserveCpu=5, absolute window=0 and shared-definition/private-context loader are unchanged. No initialization is moved before admission. No task, reservation, Room, Store, observation, commitment index or epoch is cached across samples. No Screeps connection, credentials, upload, restore or new online window is authorized. No engine budget repair or percentage speedup is claimed.

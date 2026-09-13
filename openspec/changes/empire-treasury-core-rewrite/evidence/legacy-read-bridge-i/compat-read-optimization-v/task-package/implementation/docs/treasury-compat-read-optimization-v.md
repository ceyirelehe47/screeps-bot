# Read Optimization V — scope and invariants

This authoring revision is limited to the read-only compatibility capsule. It does not optimize or change the full Treasury host.

## Per-builder context, not a shared reader

The pre-V capsule initialized commitmentRevision to zero for each builder. Its public API exposed only buildObservation/buildCommitments, and the pinned read dependency graph never called the revision mutators. V threads a private context parameter into the canonical commitment builder and its two validators. Each new builder captures revision=0 and a new Set(RESOURCES_ALL). It does not read, reset or write the host revision. Context is lexical per builder, never a mutable global active-context slot. Old/new/recursive builder calls can coexist.

Seven definition factories initialize on the first successful builder call; later calls initialize none. Each still allocates a fresh context, catalog Set and wrapper. Every invocation of either build method still constructs a new observation/index, metrics and view caches. No task, reservation, Room, Store, epoch or business result is cached in the shared definitions. First initialization and per-builder capture remain inside the admitted readerLoad interval. Failed first capture does not publish partial shared definitions.

## Auditable authoring

The original eight canonical sources remain pinned to 01bd9831454950c4928df98dd8679692b55603e5. The pre-V generated file is retained as a fixture. scripts/lib/treasury-compat-context.cjs lists exact reversible context substitutions and removes the now-unneeded commitmentRevision import edge. Only the commitments factory body changes; recovering substitutions restores the entire original prefix byte for byte, including the unchanged unused revision factory. Aggregation, table iteration, validation rules, expiry, owner resolution, complete/incomplete scopes, query APIs and receiver projection algorithms are not simplified or bypassed.

## Direct Store reference lifetime

The direct oracle obtains one Store reference within each synchronous endpoint read. It still calls all original getUsedCapacity/getFreeCapacity/getCapacity methods with their original receiver and arguments. No numbers are sourced from legacy Memory or from core observation. Core independently obtains its Store references and performs its own sparse scan. In the stable endpoint model, two-room/two-resource direct Store property accesses fall from 24 to 4; core accesses remain 12 and the full method-call sequence is identical. This is a property-lookup count, not an engine CPU ratio. Arbitrary getters that deliberately return different Store objects on each access within one synchronous endpoint read are not a supported equivalence domain; exceptions, missing values, capacity changes between samples and native method failures remain covered.

## Verification boundary

Original bridge/real-readers/independent specs and the sandbox helper remain unchanged. The existing loader-optimization spec is explicitly evolved from III to V: context/count assertions are updated, the zero-revision capsule invariant replaces the old test-only revision mutation, and all prior freshness/error/owner/completeness scenarios remain. New tests cover simultaneous catalog contexts, nested calls, full index query parity and direct/core independence. Deterministic A/B uses the exact pre-V reader and core against the new reader and core, with synthetic inputs and synthetic CPU; it is not production replay.

Default OFF, maxSampleCpu=2, reserveCpu=5, window=0, all CPU checkpoints, per-tick admission and read-only ownership remain unchanged. This revision has no Screeps network or deployment authorization. The previous four diagnostic reports still contain zero complete business samples. No online CPU repair is claimed.

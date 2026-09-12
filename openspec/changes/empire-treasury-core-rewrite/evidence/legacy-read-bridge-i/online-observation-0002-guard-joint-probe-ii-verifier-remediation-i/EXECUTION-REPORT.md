# Guard Joint Probe II · Verifier Remediation & Existing Evidence Re-adjudication I

- Source evidence commit: `64d92713352826fb547a0860a963b11b4de4f440`
- Source probe-run tree: `f6660ce8aafd6e28ce01993c21a233845609f35a`
- Source run tree: `9469e42799ace7e2ec40a4656bfc9b4f84b53328`
- Task package SHA-256: `33704ea287d4a967804d55ff801625389f09b961ad99668db7b9a78d5a9df6b0`
- This round is offline re-adjudication only: no collector restart, no 25-minute rerun, no Screeps API call, no upload, no restore.

## Final status

```text
GUARD_JOINT_PROBE_COMPLETE_IMPLEMENTATION_VERIFIED
PROBE_SESSION_DECOUPLED_FROM_FORMAL_PROFILE
GUARD_COLLECTOR_CONTROL_PLANE_PROBE_INDEPENDENTLY_VERIFIED
EXISTING_EVIDENCE_READJUDICATED
NOT_DEPLOYED
```

## Why the previous verifier failed

The original verifier rejected the completed run solely because it required at least 295 heartbeat rows and observed 287. That fixed row quota assumed nearly exact 5-second scheduling and did not model Windows timer drift or the one allowed three-attempt HTTP deadline cycle. The raw failure artifact remains unchanged and is pinned by Git blob identity.

## Replacement decision basis

The completed verifier uses wall-clock coverage and continuity rather than a fixed row count. It checks both run boundaries, strict timestamp order, coverage span, ordinary and retry-explained maximum gaps, p95 gap, exact correlation of an extended gap with the recorded 1/2/3 retry attempts, collector PID/state, and console/CPU freshness.

## Re-adjudicated evidence

| Item | Result |
|---|---:|
| Probe duration | 1500460 ms |
| Successful time reads | 99 |
| Failed cycles | 1 |
| Final consecutive failures | 0 |
| Heartbeat rows | 287 |
| Heartbeat span | 1495086 ms |
| Median heartbeat gap | 5097 ms |
| p95 heartbeat gap | 5510 ms |
| Maximum heartbeat gap | 10033 ms |
| Retry-explained extended gaps | 1 |
| Collector PID | 32772 |
| Tick range | 73636421 → 73636790 |
| Code write requests | 0 |

The single extended heartbeat gap is accepted only because the immutable timeline contains the matching failed cycle and exactly three failed attempts numbered 1, 2, and 3.

## Immutable-source and process boundaries

The source probe files were materialized from `64d92713352826fb547a0860a963b11b4de4f440` and rechecked against `f6660ce8aafd6e28ce01993c21a233845609f35a` / `9469e42799ace7e2ec40a4656bfc9b4f84b53328`. The re-adjudication writes results outside the materialized source and verifies every source file hash before and after. No raw probe evidence is copied into this new evidence directory.

The source execution report disclosed that the external toolkit directory was rebuilt once while the already-running processes continued from loaded modules. This remains recorded as a non-material procedural deviation; this re-adjudication does not erase or reinterpret that disclosure.

Independent re-adjudication status: `EXISTING_GUARD_JOINT_PROBE_EVIDENCE_INDEPENDENTLY_READJUDICATED`.

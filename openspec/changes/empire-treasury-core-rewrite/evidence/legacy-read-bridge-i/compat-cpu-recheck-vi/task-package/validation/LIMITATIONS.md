# Maker verification boundary

Maker environment: Linux, Node v22.16.0, TypeScript 5.8.3, Git 2.47.3.

The local suite uses the exact submitted V reader/core and deterministic synthetic Room/Memory/CPU fixtures. Real subprocesses, loopback HTTP, temporary Git repositories and local bare remotes exercise execution/recovery and archive/stage/commit/push. WebSocket and remote state are simulated; some waits are compressed. Native-Windows execution, the complete user repository, real account credentials, online CPU and the 75-second official-server stream are not exercised by the maker.

The accepted IV verdict is copied from the connector-returned content and verified by its exact Git blob, SHA-256 and byte count. Its recovery metrics and phase numbers are not invented or treated as new measurements. The V acceptance is likewise byte-exact. Full historical raw-network re-adjudication is not performed. The older II verdict is a regression oracle only; the executable comparison selects IV from prerequisites.json.

The source slice tests transcription, frozen identities, OFF/ON behavior, current generator output and local typechecking. It is not a substitute for the user's complete project checks: Node142, both tsc configurations, Jest195/685, and Rollup build-only before uploading. Source-slice or fixture pass counts are never added to those totals.

Lower CPU is not a pass/fail threshold. Four diagnostics do not establish statistically controlled performance or twelve complete compatibility samples. Final sample tail remains unobservable without a successor; no fifth point. Sampling is cooperative; a non-preemptible stage may overrun2. External reported-cost stop5 does not raise the sampler allowance. Persistent network/host failure can leave closeout unconfirmed; the deployment API has no CAS.

Precise runtime inheritance and executed checks are recorded in the other validation files. No private snapshots, token or new live measurements are used by the maker.

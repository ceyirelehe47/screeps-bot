# Task Hotpath XIV · Online I Retry I

Self-contained execution package. It reuses the accepted XIV source and repairs tick-versus-wall-time admission. There is no source patch, no materialization and no source migration.

Start with **AGENT-RUN.md**. `policy.json` fixes a single new authorization, source/evidence anchors and finite time limits. Source reuse is read-only; only one future ON/OFF configuration pair is permitted.

Game-time reads are recorded with request/response wall timestamps and same-process monotonic intervals. At least seven successes spanning 120 seconds and 20 ticks are required. Conservative rate = max(5 seconds/tick, 1.5 × slowest observed interval rate), with uncertainty of HTTP timing included. Admission accounts for all remaining ticks plus 240 seconds of delivery reserve. It is checked before binding and again immediately before upload.

The observation close deadline is **75 minutes from the candidate-attempt marker**, never extended. This is when recovery is triggered, not a promise that the server has already restored the backup. Recovery has its own bounded reads and independent 75-second runtime confirmation. A hard finite deadline may still produce INCONCLUSIVE if the shard slows unexpectedly.

Candidate POST ≤1; restore POST ≤1; neither retries. The bridge remains XIV, 4 points/100 ticks, 2 CPU, reserve 5, default OFF. No fifth point, no warmup, no second window and no production-readiness claim.

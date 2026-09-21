# Provenance and scope

This retry starts from compat 0b354262fb5f3686166e3af0189d88a1690f0c6b and refactor 43ee4bf495b86002fccccc22d682e2527498ef82, independently read through the GitHub connector. XIV source tree is 0391f4b73522f02829f5151b455a5e5b45d0ab9c. The original XIV implementation commit is 90fd49221d1dbf12365d60edea25d8f153d2a1cb.

The supplied XIV package was 138887 bytes, ZIP SHA-256 33bf0b03776cadacda4933307b4570dad110d7ccad14fd76a697c9f51bb9ff72, integrity SHA-256 2d6dae2879d68691813fb85b92cf53d78e6d8430f3943e03e90b6c2f009518c1. Its source patch is deliberately NOT included in this retry. The unchanged source identities are retained as references/xiv-source-manifest.json.

The prior original run remains INCONCLUSIVE / WALL_DEADLINE. Its recovery was read from the exact Git blob 7860df0bc2853a801f07204d9f8eb2cd06ee93ee at the fixed refactor anchor. Historical findings are not new measurements.

The runtime modules listed in inherited-modules.json are byte-identical to XIV. actions.cjs and worker.cjs have narrow time-budget changes; restoreOnce, stable identity reads, HTTP transport, typed-module guard and runtime observer are retained. No runtime bridge source changes occur.

External technical references used only for timing design, not for repository facts:
- https://docs.screeps.com/game-loop.html
- https://docs.screeps.com/cpu-limit.html
- https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html#performancenow

Tick-speed estimates are not deterministic future bounds. A fixed deadline may still expire. Recovery is independently required even after safety/timeout closure.

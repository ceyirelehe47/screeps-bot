# Read Envelope Cost Reduction XV + Online I

Start with **AGENT-RUN.md**. Self-contained fixed source patch, no materialization.

The new source reduces redundant own-property checks, implements an exact ASCII
UTF-8 size fast path with unchanged Unicode fallback, reduces diagnostic helper
allocations, and lazily allocates only a per-view roomResources memo container.
Complete observation data and commitment indexes remain eager. Diagnostic wire
revision XIV and every existing probe stay unchanged; XV uses distinct Git and
bundle identities. No prewarming, dropped fields, business caching or estimated
CPU subtraction is allowed.

Native source apply/resume and full tree/byte validation precede offline gates.
The accepted finite 75-minute time-admission and recovery runtime modules are
byte-identical. One new candidate and one restore maximum, never retried.
Source default OFF and exact live old-production recovery are separate checks.

Package tests: 124; repository Node tests: 424. Real locked TypeScript5.9.3,
dual tsc, Jest195/685 and Rollup must run on the execution host before observe.
Synthetic local tests do not prove engine speedup or root causes. Always keep
ENGINE_CPU_BUDGET_GAP_UNRESOLVED until real evidence supports a stronger finding;
no 12-point or Treasury production-readiness conclusion is authorized here.

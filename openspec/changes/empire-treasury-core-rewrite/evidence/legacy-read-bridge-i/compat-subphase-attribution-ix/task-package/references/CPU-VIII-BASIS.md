# Fixed basis: CPU Recheck VIII

The package starts after the accepted CPU Recheck VIII closure.

```text
compat OFF head  ef23c464c83b90b413d43d07857f67d538f512a3
refactor head    77b82bff48e9f32a3ac035cf5e0888e1329b1046
verdict commit   77b82bff48e9f32a3ac035cf5e0888e1329b1046
verdict path     openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-recheck-viii/FINAL-VERIFICATION.json
verdict blob     a7938d71511d03226bf0945d284bce7bcd0f0ff5
comparison blob  f3675450e70f61fa2048cce1df57e206861050d4
```

Accepted facts:

- four raw and four valid diagnostic reports;
- zero complete business samples;
- three actual observation builds and three actual commitment builds;
- all three commitment indexes reported complete, but zero of four expected projection rows were emitted;
- the observed commitment-build median was about 0.87746 CPU and the observation-build median about 0.50920 CPU;
- the 2 CPU engine gap remains unresolved;
- candidate and restore each crossed the write boundary once;
- old production bytes and an independent 75-second runtime were verified after restoration.

This package does not alter that history or reinterpret it as a successful compatibility observation. It adds bounded instrumentation for a future controlled capture and performs no online run.

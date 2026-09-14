# Fixed source patch

`0001-hotpath-optimization-XI.patch` is generated from the exact baseline payload in `source/baseline/` to the fixed implementation in `source/implementation/`.

It changes exactly the 17 repository paths listed in `references/implementation-lock.json`. The package also carries complete before/after bytes; Agent normally uses `tools/apply.cjs`, which validates every staged blob before creating the source commit. The patch is an independent review and reconstruction artifact.

# Compatibility Source Manifest Remediation X

This revision repairs three stale output identities in `docs/treasury-compat-source-manifest.json` and changes the loader generator gate to validate every listed output, not only the files modified by the latest attribution revision.

The corrected identities are `treasuryCompatRuntime.ts`, `real-readers.spec.cjs`, and `helpers.cjs`. The runtime identity now corresponds to the committed version that enables `cpuDiagnostics: true` for the compatibility preview.

`build-treasury-compat-loader.cjs --check` now rejects stale, missing, duplicate, or byte-changed manifest outputs. No business read semantics, authorization, budget, configuration default, or online state is changed by this remediation.

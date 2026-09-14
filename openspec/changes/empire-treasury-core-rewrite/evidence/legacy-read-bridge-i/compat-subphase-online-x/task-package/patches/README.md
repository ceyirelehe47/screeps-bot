# Patch mirror

`0001-source-manifest-remediation.patch` is the exact five-path production-repository remediation from accepted IX bytes. It includes the regenerated `docs/treasury-compat-loader-optimization.json` provenance output.

`0002-execution-runtime-and-fixed-inputs.patch` and `0003-tests-docs-and-maker-validation.patch` are package reconstruction mirrors against an empty tree. They are for independent byte inspection and reconstruction only. Agent execution uses the fixed files and tools directly; these two mirrors must not be applied to the production repository.

The v2 execution tool also recognizes the exact unpushed four-path commit created by the superseded package and completes it with a one-path provenance commit. No reset or history rewrite is authorized.

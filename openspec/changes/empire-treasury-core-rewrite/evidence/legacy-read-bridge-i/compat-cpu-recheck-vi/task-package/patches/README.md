# Implementation mirrors

These three Git-generated patches reconstruct runtime/, tools/, tests/, and references/ in an EMPTY scratch repository. They are optional mirrors for audit, NOT source patches to apply to compat or refactor. The packaged files are the primary executable delivery. This round only changes the game config temporarily through the single observe entry.

Apply in SERIES order. Documentation, INTEGRITY.json, validation and IMPLEMENTATION-MANIFEST.json remain supplied by the complete package. Never combine these patches with an old tool directory or apply them during a live run.

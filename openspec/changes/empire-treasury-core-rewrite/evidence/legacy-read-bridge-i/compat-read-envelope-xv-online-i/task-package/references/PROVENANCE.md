# XV source and execution provenance

Current compat commit: `eba6a0df574c9cb6101bd3d7e5ebae729d3dd976`.
Accepted XIV source tree: `0391f4b73522f02829f5151b455a5e5b45d0ab9c`.
Prior evidence commit: `427080341d08fcfe5569149c6fefcbb8e4059840`.
Prior package ZIP SHA-256: `ad746b3d0d3489b5843b3f061f921c2894b4a1505f9c0d1cd6638ca99be5a0db`.
Prior package fingerprint: `e2437b851e2303b20766d283859f20f100aabe9ba44404606927baa51740ab31`.

All ten runtime modules and the deploy guard vendor file are byte-identical to
that accepted time-admission package. Their exact identities are pinned by
`inherited-modules.json` and exercised by the fixed tool suite. New policy
identities and code/evidence anchors are explicit; no old write quota is reset.

Repository authoring tools now apply a fixed new source commit before admission.
The source patch is a zero-context native Git diff over the authenticated XIV
source tree. The complete post-source tree, changed paths, old/new bytes, SHA-256
and Git blobs are pinned in `source-manifest.json`. Six newly added paths are
included in the native index, not inferred from an unstaged tracked-file diff.

The three source fixtures are authenticated XIV bytes. XV transforms compose
with the public generator all the way to the current Preview/Core and exactly
restore their inputs. Diagnostic wire revision XIV is deliberately retained:
probe count, interval coverage, output fields and validators did not change.
The new deployment/source tree, not that wire label, identifies XV.

`prior-XIV-retry-I-review.json` is the prior conversation's independent review,
not a replacement for the raw server evidence. `prior-anomaly.json` retains old
forensic provenance and is not a current status assertion. Synthetic reports
are explicitly fixtures, not a replay of the unknown live task records.

# Patch reconstruction mirrors

These three Git-generated patches reconstruct the package's executable runtime, tools, and fixed tests/inputs into an empty Git worktree. They are integrity and review mirrors; the Agent does **not** apply them to either production repository.

Apply in `SERIES` order with `git apply --index`. The reconstructed files must be byte-identical to the distributed payload. The temporary ON/OFF production config commits are created only by the execution tools after all gates pass.

# Provenance and revision boundaries

The runtime/tool base is the exact XV package uploaded in this conversation:
`screeps-compat-read-envelope-XV-online-I-2026-09-23.zip`, SHA-256
`c83cf51ab12a905795463de15584456ed4a326321de27a45917848e69e24a065`.
Its archived package tree is `1e3d31b8b3b2dc5553a3271933b52d356eb380ed` at
refactor commit `b7d63b4ae0f4af89f635e48d3451f1fe6e21aeba`.

Current source is commit `01205865d975878d04c9993a0c97a6ccab952be5`, exact tree
`cf3169d5e14892249488b333837b7e840b565cce`, parent
`eba6a0df574c9cb6101bd3d7e5ebae729d3dd976`. The source manifest is retained
byte-for-byte from XV as an implementation provenance lock, not a new patch.
Both branches were read again before constructing this package.

`prior-XV-time-observations.jsonl` reproduces all eleven raw GET records from
the previous NOT_DEPLOYED round. Its Git blob, bytes and SHA-256, and the two
original measurement/binding files, are checked by the package tests.
`prior-XV-independent-review.json` is the prior conversation's uploaded review,
not a new online observation. Tests normalize only the run ID when invoking the
new estimator against that historical fixture; they do not authorize deploying
against old ticks or accept old freshness evidence.

`inherited-modules.json` pins only whole files unchanged from the uploaded XV
package. `execution-boundaries.json` also pins the unchanged uploadOnce,
restoreOnce and exposureGuard function bytes. Timing estimator semantics remain
conservative; the added three-minute slack is a stricter admission rule.

Maker-evidence logs refer only to this package's local tests. Virtual-clock
future ticks are synthetic assumptions. No real account credentials, live
modules, network deployment or engine CPU measurements were used by the maker.

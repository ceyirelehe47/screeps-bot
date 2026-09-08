set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
START_HEAD=87507f42b1302e6f0e5916d9dfb5c3cca9d94790
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "treasury-lab-r2-"))')"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
printf '%s\n' "$START_HEAD" > "$OUT/expected-start.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"
run() {
  local name="$1" rc sep="" word; shift
  { for word in "$@"; do printf '%s%q' "$sep" "$word"; sep=" "; done; printf '\n'; } > "$OUT/$name.command.txt"
  if "$@" > "$OUT/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$OUT/$name.log"
  printf '%s\n' "$rc" > "$OUT/$name.exit-code.txt"
  return "$rc"
}
run production-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'
run config-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs
run defense-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src/runtime/defenseFocusFire.ts src/runtime/engagementFallbackRevision.ts \
  src/runtime/defenderRampartAllocation.ts src/runtime/homeDefense.ts \
  src/runtime/towerControl.ts src/runtime/physicalRampartOwnership.ts src/roles/homeDefender.ts
run slice-implementation-freeze git diff --exit-code "$START_HEAD" "$VALIDATION_HEAD" -- \
  test/mock/treasuryTerminalTransferPrototype.ts test/mock/treasuryTerminalTransferCoordinator.ts
git diff --name-status --no-renames "$START_HEAD" "$VALIDATION_HEAD" > "$OUT/changes-this-round.txt"
run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-bundle-before.txt"
run lab-observer node scripts/build-treasury-terminal-lab.mjs --out "$OUT/lab-observer"
run lab-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$OUT/lab-single-shot"
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/production-bundle-after.txt"
cmp "$OUT/production-bundle-before.txt" "$OUT/production-bundle-after.txt"

LAB_FILES=(test/lab/terminal-transfer/probe.test.ts)
SLICE_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
)
KEY_FILES=(
  "${LAB_FILES[@]}" "${SLICE_FILES[@]}"
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
DEFENSE_FILES=(
  src/runtime/defenseFocusFire.test.ts
  src/runtime/defenseFocusFireStateful.test.ts
  src/runtime/defenseFallbackReallocation.test.ts
  src/runtime/defenseAllActorReservation.test.ts
  src/runtime/defenseGlobalRampartFootprints.test.ts
  src/runtime/defensePreallocationRampartOwnership.test.ts
  src/runtime/defenseStationaryRampartOwnership.test.ts
  src/runtime/homeDefense.test.ts
  src/runtime/towerControl.test.ts
  src/roles/homeDefender.test.ts
  test/memoryDeclarationBoundaries.test.ts
)
for file in "${KEY_FILES[@]}" "${DEFENSE_FILES[@]}"; do test -f "$file"; done
run jest-lab npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${LAB_FILES[@]}" --json --outputFile="$OUT/jest-lab.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-key"
run jest-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${KEY_FILES[@]}" --json --outputFile="$OUT/jest-key.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-treasury"
run jest-treasury npx jest --config jest.config.cjs src/runtime/treasury/ \
  --runInBand --json --outputFile="$OUT/jest-treasury.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-defense"
run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${DEFENSE_FILES[@]}" --json --outputFile="$OUT/jest-defense.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-full"
run jest-full npx jest --config jest.config.cjs --runInBand --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
run verify-evidence node scripts/verify-treasury-evidence.mjs \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
run diff-check git diff --check
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
printf 'VALIDATION_COMPLETE\n产物目录：%s\n' "$OUT"

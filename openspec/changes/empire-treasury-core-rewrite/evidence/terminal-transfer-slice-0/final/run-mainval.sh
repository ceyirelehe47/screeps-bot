#!/usr/bin/env bash
# Terminal Transfer Slice 0 主验证（任务书 §7.2 模板 + 驱动自测三组）
set -euo pipefail
unset DEST
cd /d/code/screeps/screeps-bot
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(mktemp -d /c/Users/15027/AppData/Local/Temp/slice0-mainval-run-XXXX)"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"
pwd > "$OUT/workdir.txt"

run() {
  local name="$1" rc; shift
  printf '%q ' "$@" > "$OUT/$name.command.txt"; printf '\n' >> "$OUT/$name.command.txt"
  if "$@" > "$OUT/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$OUT/$name.log"; printf '%s\n' "$rc" > "$OUT/$name.exit-code.txt"
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

git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" > "$OUT/changes-from-freeze.txt"
git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" -- test/ scripts/ > "$OUT/changes-scripts-test.txt"
run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/bundle-sha256.txt"

KEY_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
for file in "${KEY_FILES[@]}"; do test -f "$file"; done
printf '%s\n' "${KEY_FILES[@]}" > "$OUT/key-files.txt"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-key"
run jest-key npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${KEY_FILES[@]}" --json --outputFile="$OUT/jest-key.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-treasury"
run jest-treasury npx jest --config jest.config.cjs src/runtime/treasury/ \
  --runInBand --json --outputFile="$OUT/jest-treasury.json"

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
for file in "${DEFENSE_FILES[@]}"; do test -f "$file"; done
printf '%s\n' "${DEFENSE_FILES[@]}" > "$OUT/defense-files.txt"
run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${DEFENSE_FILES[@]}" --json --outputFile="$OUT/jest-defense.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-full"
run jest-full npx jest --config jest.config.cjs --runInBand --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs

# 核验驱动（M01）：对本轮产物实跑
run verify-evidence node scripts/verify-treasury-evidence.mjs \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18

# 驱动自测三组（任务书 §2：保存输入 hash、命令、退出码、原始输出）
SELFTEST="$OUT/selftest"
mkdir -p "$SELFTEST"
EV_PREV="openspec/changes/empire-treasury-core-rewrite/evidence/core-candidate-seal-i-evidence-remediation-i/final"
# 正例：上轮归档产物（固定输入 hash）
run selftest-archived-ok node scripts/verify-treasury-evidence.mjs \
  --validation-head "$VALIDATION_HEAD" --run-dir "$EV_PREV" --fixture h18
# 负例 1：零输入（空 run-dir）
mkdir -p "$SELFTEST/empty"
set +e
node scripts/verify-treasury-evidence.mjs --validation-head "$VALIDATION_HEAD" \
  --run-dir "$SELFTEST/empty" --fixture h18 > "$SELFTEST/empty.log" 2>&1
echo $? > "$SELFTEST/empty.exit-code.txt"
cat "$SELFTEST/empty.log"
# 负例 2：坏内容（篡改 trace 的 unknownRisk 置 null——核验器须报问题）
mkdir -p "$SELFTEST/tampered"
cp -r "$EV_PREV/trace-key" "$SELFTEST/tampered/"
cp "$EV_PREV/jest-key.json" "$SELFTEST/tampered/"
node -e '
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[1];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const file = walk(path.join(root, "trace-key")).find((f) => f.endsWith("H18-J06.json"));
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const cp = doc.checkpoints[4];
cp.unknownRisk = null; cp.riskCheckedIds = null; cp.riskDiff = null;
fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
console.log("tampered:", file);
' "$SELFTEST"
node scripts/verify-treasury-evidence.mjs --validation-head "$VALIDATION_HEAD" \
  --run-dir "$SELFTEST/tampered" --fixture h18 > "$SELFTEST/tampered.log" 2>&1
echo $? > "$SELFTEST/tampered.exit-code.txt"
cat "$SELFTEST/tampered.log"
set -e
RC_EMPTY=$(cat "$SELFTEST/empty.exit-code.txt")
RC_TAMPER=$(cat "$SELFTEST/tampered.exit-code.txt")
test "$RC_EMPTY" != "0"; test "$RC_TAMPER" != "0"

run diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf '%s\n' "$OUT" > /c/Users/15027/AppData/Local/Temp/slice0-mainval/out-dir.txt
echo "MAIN_VALIDATION_DONE OUT=$OUT"

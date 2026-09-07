#!/usr/bin/env bash
# Terminal Transfer Slice 0 · Remediation I——固定提交主验证（任务书 §9 模板）
# 在 VALIDATION_HEAD 干净工作树执行；所有输出写仓库外临时目录。
set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
START_HEAD=93a6152507167478a4cb005168e47d639b924436
VALIDATION_HEAD="$(git rev-parse HEAD)"
OUT="$(mktemp -d)"
printf '%s\n' "$OUT" > /tmp/slice0-r1-mainval-out.txt
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
printf '%s\n' "$START_HEAD" > "$OUT/expected-start.txt"
git status --porcelain > "$OUT/status-before.txt"
test ! -s "$OUT/status-before.txt"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"

run() {
  local name="$1" rc; shift
  printf '%q ' "$@" > "$OUT/$name.command.txt"
  printf '\n' >> "$OUT/$name.command.txt"
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
git diff --name-status --no-renames "$START_HEAD" "$VALIDATION_HEAD" > "$OUT/changes-this-round.txt"
git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" > "$OUT/changes-from-freeze.txt"

run typecheck npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run build npm run build
node -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("dist/main.js")).digest("hex"))' > "$OUT/bundle-sha256.txt"

NM_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
)
for file in "${NM_FILES[@]}"; do test -f "$file"; done
run jest-slice0 npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${NM_FILES[@]}" --json --outputFile="$OUT/jest-slice0.json"

KEY_FILES=(
  "${NM_FILES[@]}"
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
for file in "${KEY_FILES[@]}"; do test -f "$file"; done
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
run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  "${DEFENSE_FILES[@]}" --json --outputFile="$OUT/jest-defense.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-full"
run jest-full npx jest --config jest.config.cjs --runInBand \
  --json --outputFile="$OUT/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$OUT/trace-budget"
run budget node scripts/verify-jest-budget.mjs
run verify-evidence node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18

# T1/N07：同一个已提交驱动，从仓库外含空格目录运行（脚本绝对路径 + 输入绝对路径）。
FOREIGN_CWD="$OUT/foreign cwd"
mkdir -p "$FOREIGN_CWD" "$OUT/empty-input"
(
  cd "$FOREIGN_CWD"
  run verify-outside node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT" --fixture h18
  printf '%q ' node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT/empty-input" --fixture h18 > "$OUT/verify-empty.command.txt"
  printf '\n' >> "$OUT/verify-empty.command.txt"
  set +e
  node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
    --validation-head "$VALIDATION_HEAD" --run-dir "$OUT/empty-input" --fixture h18 \
    > "$OUT/verify-empty.log" 2>&1
  rc=$?
  set -e
  printf '%s\n' "$rc" > "$OUT/verify-empty.exit-code.txt"
  cat "$OUT/verify-empty.log"
  test "$rc" -ne 0
)

# N07 坏产物对照：篡改 trace-key 副本的 unknownIds[0]——驱动必须非零。
mkdir -p "$OUT/tampered-input/trace-key"
cp -r "$OUT/trace-key/." "$OUT/tampered-input/trace-key/"
cp "$OUT/validation-head.txt" "$OUT/tampered-input/"
cp "$OUT/jest-key.json" "$OUT/tampered-input/"
node -e '
const fs=require("node:fs"),path=require("node:path");
const root=process.argv[1];
const hits=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name==="H18-J06.json")hits.push(p);}})(root);
if(hits.length===0){console.error("未找到 H18-J06.json");process.exit(1);}
hits.sort();
const f=hits[0];
const doc=JSON.parse(fs.readFileSync(f,"utf8"));
doc.fixture.unknownIds[0]="tk1_TAMPERED_00";
fs.writeFileSync(f,JSON.stringify(doc,null,1));
console.log("tampered: "+f);
' "$OUT/tampered-input/trace-key"
printf '%q ' node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT/tampered-input" --fixture h18 > "$OUT/verify-tampered.command.txt"
printf '\n' >> "$OUT/verify-tampered.command.txt"
set +e
node "$REPO_ROOT/scripts/verify-treasury-evidence.mjs" \
  --validation-head "$VALIDATION_HEAD" --run-dir "$OUT/tampered-input" --fixture h18 \
  > "$OUT/verify-tampered.log" 2>&1
rc_tampered=$?
set -e
printf '%s\n' "$rc_tampered" > "$OUT/verify-tampered.exit-code.txt"
cat "$OUT/verify-tampered.log"
test "$rc_tampered" -ne 0

run diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
printf 'MAIN_VALIDATION_DONE\n产物目录：%s\n' "$OUT"

set -euo pipefail
cd /d/code/screeps/screeps-bot
EVIDENCE_TMP="D:/code/screeps/.tmp-r3-final"
VALIDATION_HEAD="$(git rev-parse HEAD)"
printf '%s\n' "$VALIDATION_HEAD" > "$EVIDENCE_TMP/validation-head.txt"
git status --porcelain > "$EVIDENCE_TMP/status-before.txt"
test ! -s "$EVIDENCE_TMP/status-before.txt"

run_logged() {
  local name="$1" rc
  shift
  printf '%q ' "$@" > "$EVIDENCE_TMP/$name.command.txt"
  printf '\n' >> "$EVIDENCE_TMP/$name.command.txt"
  if "$@" > "$EVIDENCE_TMP/$name.log" 2>&1; then rc=0; else rc=$?; fi
  printf '%s\n' "$rc" > "$EVIDENCE_TMP/$name.exit-code.txt"
  return "$rc"
}

node --version > "$EVIDENCE_TMP/node-version.txt"
npm --version > "$EVIDENCE_TMP/npm-version.txt"
run_logged typecheck npx tsc --noEmit -p tsconfig.json
run_logged build npm run build
run_logged jest-treasury npx jest --config jest.config.cjs \
  src/runtime/treasury/ --runInBand --json \
  --outputFile="$EVIDENCE_TMP/jest-treasury.json"

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
printf '%s\n' "${DEFENSE_FILES[@]}" > "$EVIDENCE_TMP/defense-files.txt"
run_logged jest-defense npx jest --config jest.config.cjs \
  --runInBand --runTestsByPath "${DEFENSE_FILES[@]}" --json \
  --outputFile="$EVIDENCE_TMP/jest-defense.json"
run_logged jest-full npx jest --config jest.config.cjs --runInBand --json \
  --outputFile="$EVIDENCE_TMP/jest-full.json"

test -f dist/main.js
sha256sum dist/main.js > "$EVIDENCE_TMP/bundle-sha256.txt"
run_logged diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$EVIDENCE_TMP/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$EVIDENCE_TMP/status-after.txt"
test ! -s "$EVIDENCE_TMP/status-after.txt"
echo VALIDATION-OK

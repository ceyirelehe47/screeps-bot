#!/usr/bin/env bash
set -euo pipefail
unset DEST
BASE=bd9570d2c3cf8632202cfee4e3a96d95250add52
STRICT_BASE=8c5459c4ca40a6fd06494e4cad519e20d0cd7533
PROD_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
EXPECT_HEAD=f8631d031c8732b2f2fe1a0b18983a6fe489c384
E="$1"
cd /d/code/screeps/screeps-bot

run() {
  local label="$1" rc
  shift
  {
    printf 'cwd: %s\n' "$PWD"
    printf 'command:'
    printf ' %q' "$@"
    printf '\n'
    date -u '+start: %Y-%m-%dT%H:%M:%SZ'
  } > "$E/$label.command.txt"
  if "$@" > "$E/$label.stdout.log" 2> "$E/$label.stderr.log"; then rc=0; else rc=$?; fi
  printf '%s\n' "$rc" > "$E/$label.exit-code.txt"
  date -u '+end: %Y-%m-%dT%H:%M:%SZ' >> "$E/$label.command.txt"
  printf '%s exit=%s\n' "$label" "$rc"
  return "$rc"
}

git rev-parse HEAD > "$E/validation-head.txt"
[ "$(cat "$E/validation-head.txt")" = "$EXPECT_HEAD" ] || { echo "HEAD_MISMATCH"; exit 2; }
git status --short > "$E/status-before.txt"
run npm-ci npm ci
run typecheck-all npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run production-build npm run build
sha256sum dist/main.js | awk '{print $1}' > "$E/production-bundle-sha-after-build.txt"
run jest-lab npx jest --config jest.config.cjs --runInBand test/lab/terminal-transfer/ --json --outputFile="$E/jest-lab.json"
run jest-slice npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts --json --outputFile="$E/jest-slice.json"
run jest-treasury npx jest --config jest.config.cjs --runInBand src/runtime/treasury/ --json --outputFile="$E/jest-treasury.json"
run jest-defense npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/defenseFocusFire.test.ts src/runtime/defenseFocusFireStateful.test.ts src/runtime/defenseFallbackReallocation.test.ts src/runtime/defenseAllActorReservation.test.ts src/runtime/defenseGlobalRampartFootprints.test.ts src/runtime/defensePreallocationRampartOwnership.test.ts src/runtime/defenseStationaryRampartOwnership.test.ts src/runtime/homeDefense.test.ts src/runtime/towerControl.test.ts src/roles/homeDefender.test.ts test/memoryDeclarationBoundaries.test.ts --json --outputFile="$E/jest-defense.json"
run jest-full npx jest --config jest.config.cjs --runInBand --json --outputFile="$E/jest-full.json"
run budget node scripts/verify-jest-budget.mjs
run build-observer node scripts/build-treasury-terminal-lab.mjs --out "$E/lab-observer"
run build-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$E/lab-single-shot"
run build-main node scripts/build-treasury-terminal-lab.mjs --mode run-i-main --out "$E/lab-run-i-main"
sha256sum dist/main.js | awk '{print $1}' > "$E/production-bundle-sha-after-lab-builds.txt"
if cmp -s "$E/production-bundle-sha-after-build.txt" "$E/production-bundle-sha-after-lab-builds.txt"; then echo "DIST_UNTOUCHED=OK" > "$E/dist-untouched.txt"; else echo "DIST_UNTOUCHED=FAILED" > "$E/dist-untouched.txt"; exit 1; fi
run bundle-check node "$E/check-bundles.mjs" "$E"
run diff-check git diff --check
run freeze-production git diff --exit-code "$PROD_BASE" HEAD -- src ':(exclude,glob)src/**/*.test.ts' ':(exclude,glob)src/**/*.test.tsx' ':(exclude,glob)src/**/*.test.js' ':(exclude,glob)src/**/*.test.jsx'
run freeze-root git diff --exit-code "$BASE" HEAD -- package.json package-lock.json ':(glob)tsconfig*.json' ':(glob)jest.config.*' ':(glob)rollup.config.*'
run freeze-lab-and-slice git diff --exit-code "$BASE" HEAD -- scripts/build-treasury-terminal-lab.mjs test/lab/terminal-transfer/runIMain.ts test/lab/terminal-transfer/observer.ts test/lab/terminal-transfer/singleShot.ts test/lab/terminal-transfer/controlRecord.ts test/lab/terminal-transfer/worldRead.ts test/lab/terminal-transfer/sample.ts test/mock/treasuryTerminalTransferPrototype.ts test/mock/treasuryTerminalTransferCoordinator.ts src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
git diff --name-status "$BASE" HEAD > "$E/full-diff-name-status.txt"
set +e
git diff "$STRICT_BASE" HEAD -- test/lab/terminal-transfer/sendGate.ts > "$E/sendgate-strict-base-diff.txt"
echo "$?" > "$E/sendgate-strict-base-diff.exit-code.txt"
printf 'cwd: %s\ncommand: git diff STRICT_BASE HEAD -- test/lab/terminal-transfer/sendGate.ts\n' "$PWD" > "$E/sendgate-strict-base-diff.command.txt"
node scripts/verify-lab-calibration.mjs --facts test/lab/terminal-transfer/fixtures/calibration-facts-healthy.json > "$E/cal02-healthy.stdout.log" 2> "$E/cal02-healthy.stderr.log"
echo "$?" > "$E/cal02-healthy.exit-code.txt"
printf 'cwd: %s\ncommand: node scripts/verify-lab-calibration.mjs --facts test/lab/terminal-transfer/fixtures/calibration-facts-healthy.json\n' "$PWD" > "$E/cal02-healthy.command.txt"
node scripts/verify-lab-calibration.mjs --facts test/lab/terminal-transfer/fixtures/calibration-facts-mismatch.json > "$E/cal02-mismatch.stdout.log" 2> "$E/cal02-mismatch.stderr.log"
echo "$?" > "$E/cal02-mismatch.exit-code.txt"
printf 'cwd: %s\ncommand: node scripts/verify-lab-calibration.mjs --facts test/lab/terminal-transfer/fixtures/calibration-facts-mismatch.json\n' "$PWD" > "$E/cal02-mismatch.command.txt"
set -e
[ "$(cat "$E/sendgate-strict-base-diff.exit-code.txt")" = "1" ] && [ -s "$E/sendgate-strict-base-diff.txt" ] || { echo "SENDGATE_DIFF_UNEXPECTED"; exit 1; }
[ "$(cat "$E/cal02-healthy.exit-code.txt")" = "0" ] || { echo "CAL02_HEALTHY_EXPECTED_0"; exit 1; }
[ "$(cat "$E/cal02-mismatch.exit-code.txt")" = "1" ] || { echo "CAL02_MISMATCH_EXPECTED_1"; exit 1; }
git rev-parse HEAD > "$E/validation-head-after.txt"
git status --short > "$E/status-after.txt"
echo "VALIDATION_DONE E=$E"

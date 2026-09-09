#!/bin/bash
set -uo pipefail
unset DEST
E=/tmp/screeps-ctrl-r1-first
run() {
  local label="$1" rc
  shift
  { printf 'cwd: %s\ncommand:' "$PWD"; printf ' %q' "$@"; printf '\n'; date -u '+start: %Y-%m-%dT%H:%M:%SZ'; } > "$E/$label.command.txt"
  "$@" > "$E/$label.stdout.log" 2> "$E/$label.stderr.log"
  rc=$?
  printf '%s\n' "$rc" > "$E/$label.exit-code.txt"
  date -u '+end: %Y-%m-%dT%H:%M:%SZ' >> "$E/$label.command.txt"
  printf '%s exit=%s\n' "$label" "$rc"
  return 0
}
git rev-parse HEAD > "$E/head.txt"
git status --short > "$E/status-before.txt"
run npm-ci npm ci
run node-tools-test node --test test/lab/terminal-transfer/tools/calibration.spec.cjs test/lab/terminal-transfer/tools/memory.spec.cjs test/lab/terminal-transfer/tools/stop.spec.cjs
run typecheck-all npx tsc --noEmit -p tsconfig.json
run typecheck-build npx tsc --noEmit -p tsconfig.build.json
run production-build npm run build
run jest-lab-directed npx jest --config jest.config.cjs --runInBand --runTestsByPath test/lab/terminal-transfer/probe.test.ts test/lab/terminal-transfer/runI.test.ts test/lab/terminal-transfer/calibration.test.ts test/lab/terminal-transfer/controlRemediation.test.ts --json --outputFile=/tmp/screeps-ctrl-r1-first/jest-lab-directed.json
run jest-slice0 npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts --json --outputFile=/tmp/screeps-ctrl-r1-first/jest-slice0.json

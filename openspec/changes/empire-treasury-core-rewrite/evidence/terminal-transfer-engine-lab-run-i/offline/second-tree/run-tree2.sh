set -euo pipefail
# Lab Run I 第二树复验（任务书 §7.1）：固定 VALIDATION_HEAD 的 detached worktree、
# 独立 npm ci（不共享 node_modules）、复跑 LAB（probe+runI）与 Slice 0 三件。
# 产物写入 TREE2_OUT（脚本与日志不进主仓库）。
REPO_ROOT="$(git -C "D:/code/screeps/screeps-bot" rev-parse --show-toplevel)"
VALIDATION_HEAD=15b027bc3f002b97219001a8766fd6d6e0e78736
TREE2_OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "labrun1-tree2-run-"))')"
WORKTREE="$TREE2_OUT/worktree"
printf '%s\n' "$VALIDATION_HEAD" > "$TREE2_OUT/validation-head.txt"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$VALIDATION_HEAD" > "$TREE2_OUT/worktree-add.log" 2>&1
cd "$WORKTREE"
node --version > "$TREE2_OUT/node-version.txt"
npm --version > "$TREE2_OUT/npm-version.txt"
run() {
  local name="$1" rc sep="" word; shift
  { for word in "$@"; do printf '%s%q' "$sep" "$word"; sep=" "; done; printf '\n'; } > "$TREE2_OUT/$name.command.txt"
  if "$@" > "$TREE2_OUT/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$TREE2_OUT/$name.log"
  printf '%s\n' "$rc" > "$TREE2_OUT/$name.exit-code.txt"
  return "$rc"
}
sha256sum package-lock.json > "$TREE2_OUT/lockfile-sha.txt"
sha256sum "$REPO_ROOT/package-lock.json" >> "$TREE2_OUT/lockfile-sha.txt"
test -d "$WORKTREE/node_modules" && echo "node_modules pre-exists" && exit 1 || true
run npm-ci npm ci --no-audit --no-fund
node -p 'require.resolve("jest")' > "$TREE2_OUT/resolve-jest.txt"
node -p 'require.resolve("typescript")' >> "$TREE2_OUT/resolve-jest.txt"
run jest-lab npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  test/lab/terminal-transfer/probe.test.ts \
  test/lab/terminal-transfer/runI.test.ts \
  --json --outputFile="$TREE2_OUT/jest-lab.json"
run jest-slice0 npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts \
  --json --outputFile="$TREE2_OUT/jest-slice0.json"
run lab-build-observer node scripts/build-treasury-terminal-lab.mjs --out "$TREE2_OUT/bundle-observer"
run lab-build-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$TREE2_OUT/bundle-single-shot"
run lab-build-run-i-main node scripts/build-treasury-terminal-lab.mjs --mode run-i-main --out "$TREE2_OUT/bundle-run-i-main"
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" > "$TREE2_OUT/worktree-remove.log" 2>&1
printf 'TREE2_COMPLETE\n产物目录：%s\n' "$TREE2_OUT"

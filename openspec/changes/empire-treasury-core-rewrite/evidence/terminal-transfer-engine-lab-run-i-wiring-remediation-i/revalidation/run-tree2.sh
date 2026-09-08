set -euo pipefail
unset DEST
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
VALIDATION_HEAD="$(git rev-parse HEAD)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "labrun1-wiring-tree2-"))')"
printf '%s\n' "$VALIDATION_HEAD" > "$OUT/validation-head.txt"
TREE="$OUT/tree"
git worktree add --detach "$TREE" "$VALIDATION_HEAD" > "$OUT/worktree-add.log" 2>&1
test ! -d "$TREE/node_modules"
cd "$TREE"
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
node -e 'const c=require("node:crypto"),f=require("node:fs");console.log(c.createHash("sha256").update(f.readFileSync("package-lock.json")).digest("hex"))' > "$OUT/lockfile-sha.txt"
run npm-ci npm ci --no-audit --no-fund
node -p 'require.resolve("jest")' > "$OUT/jest-resolve.txt"
node -p 'require.resolve("typescript")' > "$OUT/typescript-resolve.txt"
LAB_FILES=(test/lab/terminal-transfer/probe.test.ts test/lab/terminal-transfer/runI.test.ts)
SLICE_FILES=(
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
)
for file in "${LAB_FILES[@]}" "${SLICE_FILES[@]}"; do test -f "$file"; done
run jest-lab npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  --cacheDirectory "$OUT/jest-cache" \
  "${LAB_FILES[@]}" --json --outputFile="$OUT/jest-lab.json"
run jest-slice npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  --cacheDirectory "$OUT/jest-cache" \
  "${SLICE_FILES[@]}" --json --outputFile="$OUT/jest-slice.json"
run lab-observer node scripts/build-treasury-terminal-lab.mjs --out "$OUT/lab-observer"
run lab-single-shot node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$OUT/lab-single-shot"
run lab-main node scripts/build-treasury-terminal-lab.mjs --mode run-i-main --out "$OUT/lab-run-i-main"
# 叶子产物与起点归档逐字节一致；main 与主树主验证构建一致（runI.test 断言含归档一致；
# 此处再独立核对三产物 hash 记录在案）。
OUT_NODE="$OUT" node -e '
const c=require("node:crypto"),f=require("node:fs");
const OUT=process.env.OUT_NODE;
for (const [name,p] of [["observer","lab-observer/observer.js"],["single-shot","lab-single-shot/single-shot.js"],["main","lab-run-i-main/main.js"]]) {
  const b=f.readFileSync(OUT+"/"+p);
  console.log(name+" "+b.length+" "+c.createHash("sha256").update(b).digest("hex"));
}' > "$OUT/lab-artifacts-identity.txt"
cat "$OUT/lab-artifacts-identity.txt"
cd "$REPO_ROOT"
git worktree remove --force "$TREE" > "$OUT/worktree-remove.log" 2>&1
printf 'TREE2_COMPLETE\n产物目录：%s\n' "$OUT"

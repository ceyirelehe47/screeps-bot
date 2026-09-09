#!/usr/bin/env bash
# Calibration Rerun §9.5——第二干净工作树复现（同一 VALIDATION_HEAD）
# 只复跑 LAB（含本轮新增 calibration.test.ts）、Slice 0、三产物构建与
# 程序字节核对；不连接游戏、不发送、不重复全仓压力与预算自跑。
set -euo pipefail
unset DEST
VALIDATION_HEAD=7b9135985ab3ce02192c853f051e76005562866e
REPO=/d/code/screeps/screeps-bot
E="$1"          # 主验证输出目录（lab-*/ 三产物用于程序字节比对）
T="$2"          # 第二树输出目录（仓库外临时目录）
WT="$3"         # worktree 路径（.worktrees/ 下）

run() {
  local label="$1" dir="$2" rc
  shift 2
  {
    printf 'cwd: %s\n' "$dir"
    printf 'command:'
    printf ' %q' "$@"
    printf '\n'
    date -u '+start: %Y-%m-%dT%H:%M:%SZ'
  } > "$T/$label.command.txt"
  if ( cd "$dir" && "$@" > "$T/$label.stdout.log" 2> "$T/$label.stderr.log" ); then rc=0; else rc=$?; fi
  printf '%s\n' "$rc" > "$T/$label.exit-code.txt"
  date -u '+end: %Y-%m-%dT%H:%M:%SZ' >> "$T/$label.command.txt"
  printf '%s exit=%s\n' "$label" "$rc"
  return "$rc"
}

cd "$REPO"
git worktree add "$WT" "$VALIDATION_HEAD" > "$T/worktree-add.log" 2>&1 || { cat "$T/worktree-add.log"; exit 1; }
run node-version "$WT" node -v
run npm-version "$WT" npm -v
run npm-ci "$WT" npm ci
run resolve-deps "$WT" node -e "console.log('jest@' + require('jest/package.json').version + ' -> ' + require.resolve('jest/package.json')); console.log('typescript -> ' + require.resolve('typescript/package.json'))"
run jest-lab "$WT" npx jest --config jest.config.cjs --runInBand test/lab/terminal-transfer/ --json --outputFile="$T/jest-lab.json"
run jest-slice "$WT" npx jest --config jest.config.cjs --runInBand --runTestsByPath src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts --json --outputFile="$T/jest-slice.json"
run build-observer "$WT" node scripts/build-treasury-terminal-lab.mjs --out "$T/bundle-observer"
run build-single-shot "$WT" node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$T/bundle-single-shot"
run build-main "$WT" node scripts/build-treasury-terminal-lab.mjs --mode run-i-main --out "$T/bundle-run-i-main"

# 程序字节比对（同一 VALIDATION_HEAD 的主树 vs 第二树；manifest 的
# generatedAt/路径差异不参与——只比三个 JS 产物与 example JSON）。
for pair in "observer.js:lab-observer:bundle-observer" "single-shot.js:lab-single-shot:bundle-single-shot" "main.js:lab-run-i-main:bundle-run-i-main"; do
  file="$(echo "$pair" | cut -d: -f1)"
  mainDir="$(echo "$pair" | cut -d: -f2)"
  treeDir="$(echo "$pair" | cut -d: -f3)"
  if cmp -s "$E/$mainDir/$file" "$T/$treeDir/$file"; then
    echo "IDENTICAL $file" >> "$T/bundle-compare.txt"
  else
    echo "DIFFER $file" >> "$T/bundle-compare.txt"
    echo "BUNDLE_MISMATCH $file" >&2
    exit 1
  fi
done
if cmp -s "$E/lab-observer/example.experiment.json" "$T/bundle-observer/example.experiment.json"; then
  echo "IDENTICAL example.experiment.json" >> "$T/bundle-compare.txt"
else
  echo "DIFFER example.experiment.json" >> "$T/bundle-compare.txt"
  exit 1
fi

cd "$REPO"
git worktree remove --force "$WT" > "$T/worktree-remove.log" 2>&1
echo "SECOND_TREE_DONE T=$T"

#!/usr/bin/env bash
set -euo pipefail
cd /d/code/screeps/screeps-bot
OUT="$1"
SELFTEST="$OUT/selftest"
VALIDATION_HEAD=$(cat "$OUT/validation-head.txt")
# 事件记录：首跑 tamper node 脚本传参错误（$SELFTEST 应为 tampered 子目录）——ENOENT、
# 副本未篡改、驱动正确返回 0，set -e 在 RC_TAMPER 断言处退出；本重跑修正参数后重做尾段。
rm -rf "$SELFTEST/tampered"
mkdir -p "$SELFTEST/tampered"
EV_PREV="openspec/changes/empire-treasury-core-rewrite/evidence/core-candidate-seal-i-evidence-remediation-i/final"
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
' "$SELFTEST/tampered"
set +e
node scripts/verify-treasury-evidence.mjs --validation-head "$VALIDATION_HEAD" \
  --run-dir "$SELFTEST/tampered" --fixture h18 > "$SELFTEST/tampered.log" 2>&1
RC=$?
echo $RC > "$SELFTEST/tampered.exit-code.txt"
cat "$SELFTEST/tampered.log"
set -e
test "$RC" != "0"
RC_EMPTY=$(cat "$SELFTEST/empty.exit-code.txt")
test "$RC_EMPTY" != "0"
git diff --check
git rev-parse HEAD > "$OUT/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$OUT/status-after.txt"
test ! -s "$OUT/status-after.txt"
echo "MAIN_VALIDATION_DONE OUT=$OUT"

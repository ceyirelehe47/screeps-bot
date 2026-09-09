#!/usr/bin/env bash
# 主验证脚本尾部断言修正补跑：原断言误把普通 `git diff`（无 --exit-code，
# 恒退 0）当作退出 1 判定，导致脚本在全部命令已执行完毕后提前退出。
# 本补跑先核对 HEAD/工作区未变，再按正确语义（diff 非空=存在差异）完成
# 剩余断言与收尾工件。原失败记录保留于 wrapper.log，不掩盖。
set -euo pipefail
EXPECT_HEAD=f8631d031c8732b2f2fe1a0b18983a6fe489c384
E="$1"
cd /d/code/screeps/screeps-bot
[ "$(git rev-parse HEAD)" = "$EXPECT_HEAD" ] || { echo "HEAD_CHANGED"; exit 2; }
[ -z "$(git status --short)" ] || { echo "TREE_DIRTY"; exit 2; }
# sendGate 相对 STRICT_BASE：普通 git diff 退出码恒 0，判定依据是 diff 非空。
[ -s "$E/sendgate-strict-base-diff.txt" ] || { echo "SENDGATE_DIFF_EMPTY"; exit 1; }
[ "$(cat "$E/cal02-healthy.exit-code.txt")" = "0" ] || { echo "CAL02_HEALTHY_EXPECTED_0"; exit 1; }
[ "$(cat "$E/cal02-mismatch.exit-code.txt")" = "1" ] || { echo "CAL02_MISMATCH_EXPECTED_1"; exit 1; }
git rev-parse HEAD > "$E/validation-head-after.txt"
git status --short > "$E/status-after.txt"
printf 'note: 主脚本尾部断言（普通 git diff 误判退出码 1）提前退出后补跑；\n全部命令已在同一 HEAD 执行完毕且退出码见各 *.exit-code.txt。\n' > "$E/finish-note.txt"
echo "VALIDATION_DONE E=$E"

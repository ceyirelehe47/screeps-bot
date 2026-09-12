# Compat Reader CPU I · v3 归档收尾续接

本包只接续 v2 的步骤18–21。完整实现由制包方提供；Agent 只执行固定验证、唯一 evidence 提交及普通推送。不重做源码、不复跑已通过的整仓测试。

## 0. 保留现场与权限

保留 compat 已提交未推送的源码、refactor 已暂存的原77文件、v2包及 Git 外执行目录，包括 `18-diff-check.*`。不得先撤销暂存、清空 evidence、修改原 patch 或重新装配 v2；不得 reset、clean、amend、rebase、force-push。不得更改全局、系统或仓库 Git 配置来规避检查，不得关闭签名或提交钩子。

本包不是“将 v2 报告改成已经成功”。原任务书和原 patch 保留原字节。新补充明确承认：原生完整 whitespace 检查仍返回2，改用有且只有一个固定文件、两处固定空上下文的语法例外。任何额外诊断都失败。

不使用 Screeps token，不连接 Screeps API，不重新构建或部署，不运行 collector/Guard，不执行恢复，不启动0004。配置仍为OFF，预算仍为2；引擎CPU缺口仍未解决。

任一步失败保留stdout/stderr/exit及现有状态并停止后续步骤。不能现场修改本包或阈值。不得因为步骤失败而删除已通过的源码提交或77文件。

## 1. 唯一允许的续接状态

```text
Repository: ceyirelehe47/screeps-bot
compat branch: compat/treasury-read-bridge-i
compat base:   3292e152b0db465263e4f1fa5c9eac068394acef
local compat:  现有且唯一的源码提交，Agent报告短SHA为43b1b8e

refactor branch: refactor/empire-treasury-rearchitecture
refactor HEAD:   0b09414f90c7144bbff61758fe7cf605576231e7
local index:    原 v2 evidence 恰好77个新增普通文件

remote compat:   3292e152b0db465263e4f1fa5c9eac068394acef
remote refactor: 0b09414f90c7144bbff61758fe7cf605576231e7
```

工具不把短SHA当作完整身份。它读取现有完整SHA，要求唯一父提交等于固定compat基线、差异恰好为v2的四条路径、提交中字节匹配v2固定实现，并与原 `FINAL-VERIFICATION.json` 的完整compatHead一致。四路径为：

```text
src/runtime/treasuryCompatCpu.ts
src/runtime/treasuryCompatRead.ts
src/runtime/treasuryCompatRuntime.ts
test/treasury-compat/helpers.cjs
```

不创建第二个compat提交。refactor最终只新建一个以0b09414…为父节点的evidence提交，其中包含原77文件及本轮新增的独立补充目录。

## 2. v2步骤18的精确替代

固定例外对象为原归档中：

```text
task-package/patches/0001-reader-cpu-accounting.patch
SHA-256: 5067582c5e52de06c1bb1fac0126b9e6e65e483ec9bc8b0d09eca8ec0d5e5067
bytes: 12954
lines: 73, 78
line bytes: 0x20（单个空格）
```

检查顺序不可更改：核验全部原77文件与暂存字节；核验完整v2包身份；核验上述整个patch字节；解析hunk证明两行为标准空上下文；执行完整原生检查，要求exit=2且诊断恰好是这两处；仅排除该一个固定路径对剩余暂存文件运行相同检查，要求exit=0且无输出。

不是排除全部 `.patch`；不是把字节校验直接等同于whitespace校验；不是全局关闭尾随空格检查；也不是只删除这两行重新归档。生产源码另做无例外的 `git diff --check`。

原生检查的stdout/stderr会无损存成JSON字符串，保留原始摘要；不会把包含“加号加空格”的诊断输出直接另存成仓库中的文本行，避免诊断文件自身再触发同一门禁。

## 3. 原生环境与新目录

在原Windows/Node环境执行，Node 22已有环境即可；本续接包不依赖TypeScript或npm新安装。不要重跑v2的步骤01–17，尤其不要调用v2要求干净基线的baseline/apply/archive。

核对ZIP SHA-256后解压到新目录。`WORK3` 必须尚不存在，不能复用或覆盖v2工作目录。以下只填写真实工作树路径：

```bash
set -euo pipefail
PKG3='D:/code/screeps/incoming/screeps-compat-reader-cpu-I-v3-closeout-2026-09-12'
WORK3='D:/code/screeps/compat-reader-cpu-I-v3-closeout-verification'
COMPAT='/填写实际 compat 工作树'
REFACTOR='/填写实际 refactor 工作树'
mkdir "$WORK3"
step() {
  local name="$1"; shift
  local rc
  if "$@" >"$WORK3/$name.stdout" 2>"$WORK3/$name.stderr"; then rc=0; else rc=$?; fi
  printf '%s\n' "$rc" >"$WORK3/$name.exit.txt"
  return "$rc"
}
```

工具的 `--out` 子目录由工具创建，不能预建。本包、WORK3与旧执行目录均保持在两个Git工作树之外。v2旧目录只读保留，不需要提供给工具；原77文件本身携带此前验收原件。

## 4. 核验包与执行37项续接测试

```bash
step 01-package node "$PKG3/tools/run.cjs" verify-package
step 02-tests node "$PKG3/tools/run.cjs" test --out "$WORK3/closeout-tests"
```

要求37/37，failed/skipped/todo/cancelled均0。用例使用真实临时Git仓库、原v2包字节以及显式标注的合成执行记录；涵盖完整archive→stage→新gate→commit→本地bare remote推送回读。

这些测试不重复91项CPU实现测试，不替代原真实仓库70项Node、195/685或A/B的执行证据。临时Git测试里的身份和换行设置只作用于临时仓库，真实仓库配置不动。

## 5. 读取远端，再锁定现有提交与暂存区

```bash
step 03-fetch-compat git -C "$COMPAT" fetch origin compat/treasury-read-bridge-i
step 04-fetch-refactor git -C "$REFACTOR" fetch origin refactor/empire-treasury-rearchitecture
step 05-inspect node "$PKG3/tools/run.cjs" inspect \
  --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK3/inspection"
```

inspect只读取仓库内容、索引和Git对象（`write-tree`可写Git对象缓存，但不改变工作树或暂存内容）。它保存原77文件逐文件大小和SHA-256、整体fingerprint、既有compat完整SHA、原索引tree，以及两处原生失败的准确记录。

已通过的测试允许复用，但仍核验v2包固定身份、91和70的原始TAP计数、退出码、两套类型检查/预算检查/build-only的0退出、195/685既有预算、10场景结果和固定核心身份。不推导Node计时为引擎CPU，不提升旧原始报告的结论。

若不是报告的续接状态，停止，不自动撤销暂存或重建工作树。

## 6. 只添加独立补充目录

```bash
step 06-assemble node "$PKG3/tools/run.cjs" assemble \
  --compat "$COMPAT" --refactor "$REFACTOR" \
  --inspection "$WORK3/inspection" --tests "$WORK3/closeout-tests" \
  --out "$WORK3/assembly"
ADD_TARGET='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-reader-cpu-attribution-i-v3-closeout'
step 07-stage-addendum git -C "$REFACTOR" add -- "$ADD_TARGET"
```

新目录包含本完整续接包、检查前证据、固定测试结果、例外说明及新manifest。旧77文件及旧manifest不修改、不重哈希、不重新生成。工具不会替Agent执行stage，原暂存区在步骤07前保持不变。

写入失败只清理本次新建的补充目录，不删除原77文件。输出或目标已存在时停止，禁止先 `rm -rf` 再试。

## 7. 最终暂存门禁——取代v2步骤18

```bash
step 08-final-gate node "$PKG3/tools/run.cjs" gate \
  --compat "$COMPAT" --refactor "$REFACTOR" \
  --inspection "$WORK3/inspection" --out "$WORK3/final-gate"
```

这一步检查“原77文件+新补充”的整个索引，所有原字节必须与步骤05一致，补充必须与固定程序生成的内容一致，并记录可提交的完整indexTree。

成功码为 `FINAL_STAGED_CLOSEOUT_GATE_VERIFIED`；其内部明确保留 `nativeCheckPassed=false`、`nativeExit=2`、`remainingPathsExit=0`。不得把成功写成“原生diff --check已经0退出”。不要在此后再次执行v2无例外步骤18并将其当作新的独立阻塞。

此授权不覆盖Git已有钩子/组织签名策略；若真实提交钩子另有要求，保留失败并停止，不能 `--no-verify`、临时关钩子或改签名配置。

## 8. 唯一 evidence 提交与双分支普通推送

```bash
step 09-commit-evidence git -C "$REFACTOR" commit -m "evidence(compat): close CPU I verification with exact patch-context exception"
step 10-verify-committed node "$PKG3/tools/run.cjs" verify-committed \
  --compat "$COMPAT" --refactor "$REFACTOR" --gate "$WORK3/final-gate" \
  --out "$WORK3/committed"
step 11-push-compat git -C "$COMPAT" push origin HEAD:compat/treasury-read-bridge-i
step 12-push-refactor git -C "$REFACTOR" push origin HEAD:refactor/empire-treasury-rearchitecture
step 13-verify-remote node "$PKG3/tools/run.cjs" verify-remote \
  --compat "$COMPAT" --refactor "$REFACTOR" --committed "$WORK3/committed" \
  --out "$WORK3/remote-proof"
```

verify-committed要求新evidence提交唯一父节点正确、tree逐字节等于最终gate锁定的indexTree；compat仍为原源码提交，两工作树干净。推送使用既有认证，不能force。

若只有一条推送成功，停止并如实记录部分推送状态；不回退已推送分支，不重造提交。所有步骤原始输出留在WORK3，不通过追加“成功日志”改变已提交evidence的tree。

## 9. 最终报告

只有步骤13 `CPU_V3_CLOSEOUT_REMOTE_VERIFIED` 后，才允许报告：

```text
COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED
CPU_PHASE_DIAGNOSTICS_IMPLEMENTED
UTF8_NORMAL_OUTPUT_RESCAN_REMOVED
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

报告两个完整新SHA、v2及v3包SHA、原77文件未变、例外恰好两处、37项本轮测试以及复用的真实v2结果。说明完整原生检查仍为2，按本次固定语法例外完成收尾；v2最初止步18的事实不被删掉。

禁止报告 CPU_BUDGET_GAP_REPAIRED、ONLINE_COMPAT_READ_OBSERVED、DEPLOYED或生产可切换。此次无新的CPU实测，不启用兼容桥。

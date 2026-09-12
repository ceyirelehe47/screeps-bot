# Compat Reader CPU Attribution I · v2
## 完整实现交付；修复仓库测试集成；Agent 仅验证；不部署

本包取代 SHA-256 为 `e15b7c5ff0480dbf91ac7f96928380742a4ab30b2bd136a15012f97bad153978` 的旧 CPU I 包。它不是新的线上实验。
Git 基线不变。三份 CPU 生产实现与旧包逐字节相同，新增变更仅为仓库沙箱测试夹具的精确依赖映射。

## 0. 目标、权限与失败纪律

完成默认 OFF 的 CPU 分阶段诊断、普通输出一次重复 UTF-8 遍历消除及真实仓库测试集成。**不宣称已修复引擎中的 2 CPU 预算缺口。**

compat 只允许以下四个路径：

```text
src/runtime/treasuryCompatCpu.ts        新文件；与 v1 完全相同
src/runtime/treasuryCompatRead.ts       与 v1 完全相同
src/runtime/treasuryCompatRuntime.ts    与 v1 完全相同
test/treasury-compat/helpers.cjs        本版增加的唯一仓库集成变更
```

helper 只允许 `treasuryCompatRead.ts → ./treasuryCompatCpu` 这一精确加载边。它加载真实 CPU 模块，不提供假实现、不回退到宿主 require、不开放任意相对路径。显式 own-property imports 仍优先，其他未授权导入继续失败。

不修改任何既有 spec、Jest wrapper、195 suites / 685 tests 预算、配置及 maxSampleCpu=2、生成核心、main、依赖、构建配置、Memory、市场、物流、Treasury 内核或历史 evidence。
不使用 token、不连接 Screeps、不运行 collector/Guard、不上传候选、不恢复、不启动 0004。仅允许 Git fetch/push 与本地测试/构建。

Agent 不改代码、不修绿、不删/跳过断言、不改阈值、不现场追加测试。任何验证失败立即保存输出并停止后续步骤，不进入 stage/commit/archive/push。
不要清理旧失败目录或旧日志。v1 已应用的三文件保持原样，由新版工具先按字节识别，再只补 helper；不能先 `reset --hard`、`clean -fd` 或盲目覆盖。

## 1. 固定身份

```text
Repository: ceyirelehe47/screeps-bot
compat/treasury-read-bridge-i
3292e152b0db465263e4f1fa5c9eac068394acef

refactor/empire-treasury-rearchitecture
0b09414f90c7144bbff61758fe7cf605576231e7

真实生成核心 Git blob
c44d8a306f2b11986c6556e098be7d2e10315fa6
```

两条最终线性提交：compat 的四路径实现/测试夹具提交；refactor 的新 v2 evidence 提交。基线未移动时才执行，不 amend、rebase、reset 或 force-push。

## 2. 原生环境与新目录

在正常 Git 配置的新终端中执行。Windows / Node v22.19.0；TypeScript 使用兼容仓库已有依赖，不升级、不重装。
不要沿用上轮用于诊断的 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_SYSTEM` 空文件覆盖。测试内的临时 Git 操作已经局部固定换行策略，不需要屏蔽真实 Git 身份、签名或系统设置。包不改真实仓库的 Git 配置。

先核对 ZIP SHA-256，再解压到新目录。包本体不得修改。WORK 必须尚不存在；旧目录（如 `compat-reader-cpu-I-verification`）只读保留。

```bash
set -euo pipefail
PKG='D:/code/screeps/incoming/screeps-compat-reader-cpu-I-v2-2026-09-12'
WORK='D:/code/screeps/compat-reader-cpu-I-v2-verification'
COMPAT='/填写实际 compat 工作树'
REFACTOR='/填写实际 refactor 工作树'
mkdir "$WORK"
step() {
  local name="$1"; shift
  local rc
  if "$@" >"$WORK/$name.stdout" 2>"$WORK/$name.stderr"; then rc=0; else rc=$?; fi
  printf '%s\n' "$rc" >"$WORK/$name.exit.txt"
  return "$rc"
}
```

工具自建的 `--out` / `--snapshot` 目录不能预先创建。包、WORK、snapshot 均须在两个工作树之外。

## 3. 前检：允许已证实的 v1 三文件状态

```bash
step 01-fetch-compat git -C "$COMPAT" fetch origin compat/treasury-read-bridge-i
step 02-fetch-refactor git -C "$REFACTOR" fetch origin refactor/empire-treasury-rearchitecture
step 03-integrity node "$PKG/tools/run.cjs" verify-package
step 04-baseline node "$PKG/tools/run.cjs" baseline --compat "$COMPAT" --refactor "$REFACTOR"
```

refactor 必须干净，双方本地和 remote-tracking HEAD 必须等于 §1。compat 索引必须为空，工具只接受三种可判定状态：

- `CLEAN_BASELINE`：干净基线。
- `EXACT_V1_SOURCE_APPLIED`：恰好三份 v1 实现的完整固定字节；helper 仍为基线。
- `EXACT_V2_APPLIED`：恰好四份 v2 完整固定字节，用于只读核验已应用的本版。

未知编辑、额外路径、部分应用、源码字节不符、已有暂存或分支漂移均拒绝。不能根据 `M`/`??` 就认定是旧包产物。
前检不恢复、不删除、不修改任何文件。

## 4. 固定实现测试（仓库写入之前）

```bash
step 05-tests node "$PKG/tools/run.cjs" test \
  --typescript-repo "$COMPAT" --compat "$COMPAT" --refactor "$REFACTOR" \
  --out "$WORK/implementation-tests"
```

要求 91/91，fail/skipped/todo/cancelled 全为0，最小类型夹具无诊断。91 包括原69项及22项集成/安全续接测试。
其中一项会在子进程执行原版、未改动的 `bridge.spec.cjs` 共41项；该子集不再加到91或195/685中。
测试还必须用旧真实 helper 复现 `unexpected runtime import: ./treasuryCompatCpu`，证明检验能发现原缺陷。

本包固定测试不是完整仓库195/685，也不是官方CPU数据。

## 5. 快照并适配，不重复覆盖已有源码

```bash
step 06-apply node "$PKG/tools/run.cjs" apply \
  --compat "$COMPAT" --snapshot "$WORK/application-input"
step 07-diff-check git -C "$COMPAT" diff --check
step 08-source-check node "$PKG/tools/run.cjs" check --compat "$COMPAT"
```

工具在写入前将四个允许路径的现存原字节、缺失标记、SHA-256 和输入状态保存到 Git 外 snapshot。保留已有 CRLF，不从 Git 重建失败现场。

`EXACT_V1_SOURCE_APPLIED` 只写 helper，三份已应用源码一字节不动。干净基线写四文件。已是本版则核验后不重复写。
写入/写后核验失败回滚本次实际写入的原字节；不清除之前的 v1 源码。快照失败则不写仓库。

`patches/0001` 与 `0002` 是可审查镜像；不要在固定 apply 后再执行补丁，也不要直接在 v1 脏树重复套0001。

## 6. 真实固定核心十场景 A/B

```bash
step 09-characterize node "$PKG/tools/run.cjs" characterize \
  --compat "$COMPAT" --refactor "$REFACTOR" --typescript-repo "$COMPAT" \
  --out "$WORK/characterization"
```

不直接复用上轮PASS文件。重新运行固定十场景，真实核心必须由Git对象物化并校验blob。
要求旧/新诊断关闭输出逐字节等价，诊断开启剔除明确诊断字段后业务语义等价，Memory不写、每样本新建reader。
场景覆盖空表、2/16/256任务、257超界、非法状态、缺失预留表、无revision通知的跨样本变化、256个未过期/已过期预留。
数据为合成输入，不伪称重放线上真实任务。UTF-8扫描24→12只说明一次重复遍历被移除，不是引擎CPU改善比例。

## 7. 真实仓库完整检查与只构建

```bash
step 10-full-check node "$PKG/tools/run.cjs" full-check \
  --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/project-checks"
```

依次执行：

1. 按固定blob检查三份原版 CJS specs 与两份 Jest wrappers 没被修改，执行全部三份真实仓库 Node specs（bridge / real-readers / independent）。
2. `tsconfig.build.json` 与 `tsconfig.json` 两套 TypeScript 检查。
3. 原 `scripts/verify-jest-budget.mjs`，必须原预算195/685。
4. Rollup build-only，源码未提交的dirty身份如实保留，禁止上传dist。

所有输出、stderr、exit保存。工具不调用push脚本；清除DEST、DEPLOY_ALLOW_DIRTY、NODE_OPTIONS等部署/注入环境。新helper必须通过原测试，不得删测试或调整计数。
任一失败停止。实际整仓检查仍是必要门禁，不能用制作方41项或包内91项替代。

## 8. compat 唯一提交

```bash
step 11-stage-source git -C "$COMPAT" add -- \
  src/runtime/treasuryCompatRead.ts src/runtime/treasuryCompatRuntime.ts \
  src/runtime/treasuryCompatCpu.ts test/treasury-compat/helpers.cjs
step 12-verify-source-index node "$PKG/tools/run.cjs" verify-staged --compat "$COMPAT"
step 13-commit-source git -C "$COMPAT" commit -m "perf(compat): add CPU attribution with repository sandbox integration"
```

必须父节点=3292e15...，仅四路径；暂存字节等于固定payload。不得为了提交而屏蔽签名策略；身份或签名失败时保存并报告。

## 9. 独立 evidence 装配、提交与推送

```bash
step 14-archive node "$PKG/tools/run.cjs" archive \
  --compat "$COMPAT" --refactor "$REFACTOR" \
  --tests "$WORK/implementation-tests" --characterization "$WORK/characterization" \
  --checks "$WORK/project-checks" --out "$WORK/archive-result.json"
step 15-verify-archive node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR"
TARGET='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-reader-cpu-attribution-i-v2'
step 16-stage-evidence git -C "$REFACTOR" add -- "$TARGET"
step 17-verify-evidence-index node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR" --staged yes
step 18-diff-check git -C "$REFACTOR" diff --cached --check
step 19-commit-evidence git -C "$REFACTOR" commit -m "evidence(compat): verify CPU attribution v2 repository integration"
step 20-push-compat git -C "$COMPAT" push origin HEAD:compat/treasury-read-bridge-i
step 21-push-refactor git -C "$REFACTOR" push origin HEAD:refactor/empire-treasury-rearchitecture
```

新目录装配完整任务包、91项原始结果、实际10场景A/B、真实仓库检查输出、最终报告。局部 `.gitattributes` 固定原始证据字节。
不复制旧线上日志、模块快照、Memory、token、dist或旧WORK。旧失败目录和本轮application-input快照保留在Git外。
push遇到漂移停止，不force。末尾保存两树 `status --porcelain` 与 `ls-remote origin refs/heads/...`，确认两个新SHA都可见。

## 10. 终态与真实边界

报告两个新SHA、v2 ZIP SHA-256、Windows/Node/TS、91项测试、真实10场景、两套类型检查、195/685、build-only和push结果。说明接续模式及是否只更新helper。
全部通过才允许：

```text
COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED
CPU_PHASE_DIAGNOSTICS_IMPLEMENTED
UTF8_NORMAL_OUTPUT_RESCAN_REMOVED
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

不能报告 ONLINE_COMPAT_READ_OBSERVED、CPU_BUDGET_GAP_REPAIRED、DEPLOYED或生产可切换。
原0003仍为1条raw/0条完整，恢复闭合不变。没有新的线上CPU实测。末样本尾部成本无后继报告时仍不可观测。

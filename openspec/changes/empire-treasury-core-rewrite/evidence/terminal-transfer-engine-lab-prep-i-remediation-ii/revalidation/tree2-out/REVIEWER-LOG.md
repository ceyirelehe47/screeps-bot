# REVIEWER-LOG —— Terminal Transfer Engine Lab Prep I · Remediation II 第二树独立复验

- 复验者角色：第二树独立 reviewer（同一 VALIDATION_HEAD 上的干净 detached worktree，独立依赖安装）
- 日期：2026-09-08
- 主仓库：`D:\code\screeps\screeps-bot`（分支 `refactor/empire-treasury-rearchitecture`，只读，未做任何修改）
- VALIDATION_HEAD：`9bf6625503bc8f697fdc2ba1f30e8fb78c58678f`
- 第二树 T2：`C:/Users/15027/AppData/Local/Temp/labprep1-r2-tree2`（detached worktree）
- 输出目录 OUT2：`C:/Users/15027/AppData/Local/Temp/labprep1-r2-tree2-out`
- 任务书：`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-ii/task/task-brief.md`（已读全文，职责见 §7.3）

## 第 0 步：读取任务书全文

已读取上述 task-brief.md 全文（295 行）。重点确认：§3 B1/B2 基线、§4 唯一大小语义（完整 JSON 的 UTF-8 字节数 ≤4096，读/写/读回同一口径）、§5 必需测试、§6 R01–R04、§7.3 reviewer 职责（复跑 LAB+KEY+Defense；KEY 已含 Slice 0；无需全仓/budget 重跑；重点独立核对 4096/4097、非 ASCII 结果拒写、受支持字段超限读取、保留 attempted 不重发）。

## 第 1 步：建立第二树

| 项 | 命令/方法 | 结果 |
| --- | --- | --- |
| T2 预检查 | `test -e` | 不存在（OUT2 同样不存在） |
| 建树 | `git worktree add --detach T2 9bf6625503bc8f697fdc2ba1f30e8fb78c58678f`（主仓库执行） | 退出码 0 |
| HEAD 核验 | `git -C T2 rev-parse HEAD` | `9bf6625503bc8f697fdc2ba1f30e8fb78c58678f` === VALIDATION_HEAD，PASS |
| 工作树核验 | `git -C T2 status --porcelain` | 空，PASS |
| 非符号链接 | `node fs.lstatSync(T2)` | isSymbolicLink=false、isDirectory=true、realpath 为原路径，PASS |
| node_modules 预检 | `fs.existsSync(T2/node_modules)` | false（安装前不存在），PASS |

## 第 2 步：独立依赖安装

- Node `v22.19.0`、npm `10.9.3`（见 `node-version.txt`、`npm-version.txt`）。
- `cd T2 && npm ci --no-audit --no-fund > npm-ci.log 2>&1`：**退出码 0，耗时 21 秒，added 896 packages in 20s**（原始输出已存 `npm-ci.log`）。
- lockfile 双树对比（node:crypto sha256，见 `lockfile-compare.txt`）：
  - T2 = `490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a`
  - 主树 = `490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a`
  - **一致**，且与预期前缀 `490ee9c7…` 吻合，PASS。
- 依赖实际解析路径（`require.resolve(..., {paths:[T2/node_modules]})`，见 `resolve-paths.txt`）：
  - typescript → `C:\Users\15027\AppData\Local\Temp\labprep1-r2-tree2\node_modules\typescript\lib\typescript.js`（T2 内部）
  - jest → `C:\Users\15027\AppData\Local\Temp\labprep1-r2-tree2\node_modules\jest\build\index.js`（T2 内部）
  - ts-jest 同理解析到 T2 内部，PASS。
- 非链接核验：`fs.lstatSync(T2/node_modules)` → isSymbolicLink=false；jest/typescript/ts-jest 包目录亦均非 symlink，PASS。
- 主树无污染：主仓库全程只读（唯一写操作为 `git worktree add` 的元数据登记，`git status --porcelain` 全程保持空）。

## 第 3 步：复跑三组 Jest（独立 cache 与输出）

所有命令：`npx jest --config jest.config.cjs --runInBand --cacheDirectory "$OUT2/jest-cache" --runTestsByPath <files> --json --outputFile=...`（在 T2 内执行）。

| 组 | 文件数 | 退出码 | suites | tests | passed | failed | pending | todo | 期望 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LAB（probe.test.ts） | 1 | 0 | 1 | 22 | 22 | 0 | 0 | 0 | 1/22 | PASS（45 秒） |
| KEY（LAB+SLICE 3+Remediation IV/V/VI 共 9 文件，`TREASURY_SEAL_EVIDENCE_DIR=$OUT2/trace-key`） | 9 | 0 | 9 | 102 | 102 | 0 | 0 | 0 | 9/102 | PASS（24 秒） |
| Defense（11 文件，`TREASURY_SEAL_EVIDENCE_DIR=$OUT2/trace-defense`） | 11 | 0 | 11 | 118 | 118 | 0 | 0 | 0 | 11/118 | PASS（40 秒） |

JSON 原件：`jest-lab.json`、`jest-key.json`、`jest-defense.json`；stdout 日志同名 `-stdout.log`；汇总 `jest-summary.txt`。三组退出码全部 0。

## 第 4 步：reviewer 独立字节核对（自写脚本，不复用主树测试代码）

临时脚本 `T2/reviewer-vm-check.cjs`（验证后已删除，原件逻辑见本日志及 `reviewer-vm-check.log`）。产物构建：`node scripts/build-treasury-terminal-lab.mjs --mode single-shot --out "$OUT2/reviewer-bundle"`（T2 内执行，退出码 0）。

- 构建产物身份（manifest 见 `reviewer-bundle/manifest.json` 及副本 `reviewer-bundle-manifest-copy.json`）：**bytes=27697，output.sha256=`7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391`**，repoSourceCommit=9bf6625…（===VALIDATION_HEAD），lockfileSha256=490ee9c7…（与双树一致）。脚本内以 node:crypto 独立复算 bundle sha256 与实测字节均一致。
- VM 沙箱：`node:vm` 全新 context，sandbox 仅 `module/exports/console/Game/Memory`；每个沙箱内以 `typeof` 探针证明 **Buffer/TextEncoder/process/require 均为 undefined**（容量路径不依赖 Node 注入，PASS）。
- 假世界合成值与 `labConfig.ts` 的 `LAB_EXAMPLE_EXPERIMENT` 一致：experimentId `lab-prep1-example-0001`、shard `lab-synthetic-shard`、user `lab-synthetic-user`、W1N57→W10N57、term id `lab-term-source-synthetic`/`lab-term-target-synthetic`、H 1000、energy 10000、fee 26（calcTransactionCost 恒 26 ≤ maxFeeEnergy 1000）、targetTick 12345。
- 期望字节数全部由脚本在 VM 外 `Buffer.byteLength(s,'utf8')` 独立计算。

### 场景甲（B1：非 ASCII 结果超限拒写）——16 项全 PASS

初始槽为合法武装小记录；send spy 进入时抛 `new Error("错".repeat(2048))` 且不改库存/冷却/交易视图。实测：

- send 恰 **1** 次；send 入口内槽上 **attempted===true**（experimentId/attemptedTick=12345 匹配）。
- 最终槽完整 JSON：**93 字节 ≤4096**（VM 外独立计算），键仅 `experimentId,armed,attempted,attemptedTick`——**不含 syncResult/stopped**，attempted 保留。
- 日志含 `lab-control-write-refused`+`reason:"size_limit"` 行，自报 **bytes=6296 >4096**；且与 VM 外独立 Buffer 计算（6296）**严格相等**（不只验证 >4096）。
- 同步异常如实输出：`phase:"sync-throw"` 1 次、result.ok=false。
- 同 tick 二次 loop、推进一 tick（12346）、用同一 Memory 在**全新 VM 沙箱**重建模块于**相同目标 tick 12345** 再 loop——累计 send 仍 **1**；新 VM 拒绝原因 **already_attempted**（非 tick 门禁掩盖）。

### 场景乙（B2：受支持字段超限读取）——8 项全 PASS

预置 `{experimentId 同上, armed:true, attempted:true, attemptedTick:12345, syncResult:{ok:false,error:"x".repeat(5000)}, stopped:true}`（全部受支持字段，无未知键）。实测：

- VM 外独立证明完整 JSON **5145 字节 >4096**（纯 ASCII，chars=5145）。
- 产物 loop 三次（同 tick×2 + 下一 tick 12346）：全部 `lab-precondition-rejection` 且 reason 均为 **control_record_corrupt**，**无一次 already_stopped**。
- 累计 send **0**；槽对象**引用未变**（`memory.__labTerminalTransferProbe === 预置引用`）且**内容完全未变**（JSON 逐字节相同）——零写；无任何控制槽写尝试日志。

### 场景丙（4096/4097 独立边界）——21 项全 PASS

同形状（与乙完全相同字段集）已结束记录，error 为纯 ASCII，线性精确构造后**实测断言**（误差非 0 即 FAIL）：

- 记录 A：完整 JSON **实测恰 4096 字节**（errorLen=3951）→ 产物 loop 拒绝原因 **already_stopped**（读取健康）；`readControlRecord` 直读（typescript transpileModule 将 T2 的 controlRecord.ts 转 CommonJS 后在 VM 执行）返回 **ok**；零 send。
- 记录 B：完整 JSON **实测恰 4097 字节**（errorLen=3952）→ 产物 loop 拒绝原因 **control_record_corrupt**（读取不健康）；直读返回 **corrupt**；零 send。
- 对照：短合法同形状记录直读 **ok**（读取未被整体禁用）；场景乙超限记录直读 **corrupt**。
- 交叉核对：产物/源码内纯 JS `measureUtf8Bytes` 与 VM 外 `Buffer.byteLength` 在 7 组输入（纯 ASCII、中文 2048×“错”、emoji 代理对、引号/反斜杠/控制字符、孤立高代理、孤立低代理、混合）**全部严格相等**（6159、608、808、6/9、5098 等实测见日志）。
- transpile 用的 typescript 解析自第二树 `T2/node_modules`（`resolve-paths` 核对过）。

汇总：**PASS=45 FAIL=0，脚本退出码 0**。完整逐行输出见 `reviewer-vm-check.log`。

## 第 5 步：budget manifest 一致性（只读对比，不重跑全仓）

解析 `T2/test/test-suite-budget.json`（见 `budget-manifest-check.txt`）：

| 项 | 实测 | 结论 |
| --- | --- | --- |
| target.tests | **1465** | ===1465，PASS |
| files["test/lab/terminal-transfer/probe.test.ts"].budget | **22**（tests=22, passed=22） | ===22，PASS |
| target.commit | **`ae991e5e73a98ca8de69db0e07b06f71927156c5`** | 与复验指令预期 `9bf6625…` 不一致——**见下方"差异与异常"第 1 条**，判定为仓库有意设计而非缺陷 |

## 差异与异常（如实记录）

1. **target.commit 与指令预期不一致（判定：非缺陷）**。实测 `ae991e5e…`。查证：`ae991e5` 是 VALIDATION_HEAD `9bf6625` 的直接父提交（本轮“R01/R02 实现+测试+基线”提交）；`9bf6625` 的 commit message 明确写“target 锚点固定至 ae991e5；baseline 保持 b6ab29a；脚本 requiredTarget 同滚”，manifest `allocation.note` 同样记“锚点 ae991e5”。`scripts/verify-jest-budget.mjs` 的 `requiredTarget` 只校验 suites/tests/passed/failed/pending/todo，**不校验 target.commit**，因此不存在 budget 校验缺口。历史模式一致（Remediation I 轮锚点 b6ab29a 亦为该轮实现提交）。结论：锚点语义内部自洽；本差异属复验指令预期与仓库既定设计之差，如实上报，未做任何修改。
2. **证据目录 final/ 与 revalidation/ 当前为空**（baseline/ 含 baseline-run.log、README.md、reproduce-baseline.cjs；task/task-brief.md 存在）。主报告文件亦未见。推测 final/revalidation 归档与第二树复验（本轮）结果尚未提交入库；此为观察事实，不属本 reviewer 核对范围，如实上报。
3. 无其他异常：三组 Jest 无失败/跳过；npm ci 无错误；主仓库工作树全程未变。

## 第 6 步：清理

- `npm-ci.log` 与构建 manifest 副本已存 OUT2；`T2/npm-ci.log` 与 `T2/reviewer-vm-check.cjs` 已删除。
- 从主仓库执行 `git worktree remove --force T2`；`git worktree list` 仅剩主树；主仓库 `git status --porcelain` 为空（含 `.git/worktrees` 元数据自动回收）。

## 总结论

第二树独立性四项核验全部成立（非链接、解析路径落第二树、主树零污染、lockfile 双树一致）；npm ci 退出码 0（896 包）；LAB 1/22、KEY 9/102、Defense 11/118 全部通过；reviewer 独立字节核对 45 项全 PASS（场景甲/乙/丙实测数字见上）；budget manifest 两项 PASS、target.commit 差异如第 1 条所述判定为有意设计。R02/R03 相关的 4096/4097 边界、非 ASCII 结果拒写、受支持字段超限读取、保留 attempted 不重发均获第二树独立证实。

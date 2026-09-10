# Treasury Legacy Read Bridge I — 生成与独立验收报告

日期：2026-09-11。执行环境：Windows / Node v22.19.0 / TypeScript 5.9.3（两侧工作树独立安装锁定依赖）。

**结论：`COMPAT_READ_CANDIDATE_VERIFIED / NOT_DEPLOYED`**

| 身份 | 值 |
| --- | --- |
| 输入任务包 | `screeps-treasury-legacy-read-bridge-I-task-package-2026-09-10.zip` sha256 `7316e980…36a35b`（46 文件 INTEGRITY.json 逐项 sha256 全 OK，原件归档 `00-package/`） |
| 读取算法来源（固定 Git 对象） | `01bd9831454950c4928df98dd8679692b55603e5`（与开发分支 HEAD 一致；8 文件 blob 与 source-plan 锁全一致） |
| 旧生产基线 | `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c`（main blob `5f6c49c7…`、main.test blob `2d2283b8…` 均与计划一致） |
| 候选分支 | `compat/treasury-read-bridge-i`，远端=本地=`7ceabba9f2f100b28a34a94e624968452516a8ea` |
| CANDIDATE_VALIDATION_HEAD | `6d514b5de2dd518596eab11865f2d841c9cb18e2`（全量回归与首轮构建在该 SHA 执行） |
| 候选提交链 | `ce7d07c`（装配 13 文件）→ `6d514b5`（Agent 独立反例 2 文件）→ `7ceabba`（预算锚点 2 文件） |
| 交付状态 | IMPLEMENTED_LOCAL_CHECKS_ONLY → **COMPAT_READ_CANDIDATE_VERIFIED / NOT_DEPLOYED**（未上传 Screeps、未采样、未切活动分支、未写线上 Memory） |

## §1 实际候选 SHA 与基线；旧业务究竟改了哪些字节

- 基线 `06ffedb`，最终候选 `7ceabba`（3 提交线性，未合并进 main、未覆盖开发分支）。
- **生产文件仅 `src/main.ts` 被修改，恰好 2 行新增**：1 行 import（`runTreasuryCompatRead`）+ 1 行 `cpuProfiler.measure("treasuryCompatRead", …)` 插在 `empireInventoryShadow` 之后、原 `flush()` 之前。主循环 38→39 阶段（`07-frozen-diff/frozen-diff-summary.md` 有完整 diff）。
- 新增生产文件 5 个：`src/runtime/treasuryCompat{Types,Config,Read,Runtime}.ts`（手写）+ `treasuryCompatReadCore.generated.ts`（生成物，未手改）。
- 其余 12 个变更文件全部是测试/文档/预算：旧顺序测试 `src/main.test.ts`（2 行：相位表 +1 项、38→39）、专属测试 5 个（`test/treasury-compat/` 4 个 Node spec + helpers 之外含独立反例、`test/treasuryCompatRead.test.ts` 与 `test/treasuryCompatIndependent.test.ts` 两个 Jest wrapper）、候选文档 2 个、预算 2 个（`test/test-suite-budget.json`、`scripts/verify-jest-budget.mjs` 仅锚点/目标数字）。
- **27/27 关键路径字节不变**：resourceControl / resourceReservation / runtimeServices / memoryCleanup / `src/types/memory/runtime.d.ts` / package.json / package-lock.json / rollup.config.js / tsconfig×2 / deployGuard.cjs / src/runtime 全部 Defense 文件 / logistics 全部执行层文件（两侧 `rev-parse` blob 全等实测）。

## §2 是否生成了真实固定源的 8 文件闭包（非 mock/裁剪）

是。装配器 `--check`/`--apply` 均成功（`01-assemble/`）：

- 闭包含 8 个模块（observation / commitments / types / commitmentRevision / holderResolution / ownerIdentity / resourceTransferTaskHealth / configNormalize），每个模块的 git blob 与 source-plan.json 锁逐一相符，来源 commit=`01bd983`，生成物 62,929 字节。
- 生成物只导出 `createCompatibilityReadCore()`，返回冻结对象 `{buildObservation, buildCommitments}` 两个入口；依赖图为静态 import map，越出 8 文件白名单/动态 require/eval/Function 构造器在装配器层被拒绝（交付方 assembler.spec 22 例 + 我方复跑）。
- `real-readers.spec.cjs` 10 例强制要求生成物真实存在并调用真实原算法（缺失即失败，无 skip 路径），全部通过。交付包 validation 中"未在交付环境执行"的 10 项 real-readers 用例与 8 文件闭包生成，本轮已全部实际执行。

## §3 非空、缺失、损坏、容量变化是否有真实原函数下的正反对照

**交付方用例（51 例 Node，41 bridge + 10 real-readers）全部通过**（`02-first-round/first-node-test.log`）。

**Agent 独立反例 19 例全部通过**（`03-independent/`，场景/记录形状/断言值均独立构造，未复制交付方用例）：

1. 非空/变更/到期：两房正对照（done/cancelled 不计 outgoing、manual 计入对侧 incoming）；`expiresAt === tick` 当 tick 仍占用（canonical 严格小于才到期）、跨过才排除且原记录保留；旧 writer 状态迁移 pending→done + 新增记录（无 revision 通知）下一样本如实反映。
2. 缺失/损坏：reservations 为数组/null 不冒充空表；单条损坏（remaining>amount）→ read_incomplete + scope 级 incomplete；限定资源外（U）损坏记录 completeness 忠实跟随原索引（选定 H 行仍 complete、invalidRecords=1）；catalog 外资源 → globally-incomplete 传染全部 scope；Proxy 守卫武装实证（写尝试被拦截计数≥3）+ 观察全程零写 + 原型未污染。
3. 容量/身份：非 1M/8M 档位合法容量变化（1M→3M）与结构 ID 替换均触发 `endpoint_or_capacity_changed` 不沿用旧基线；单房一端不可读 → 全房退出 observation/commitments（not_read、readers 零调用）；单资源方法读数超总量 → unreadable。
4. 真实来源/主循环：真实 observation 稀疏键枚举（1000）与方法读数（800）故意不一致 → mismatch 含 'H'，恢复后 match；同 tick 投影字段为字符串 → unreadable 而非 match；**候选实际 main.ts**（对比 `06ffedb` 固定基线）39 阶段、首阶段业务异常 fail-fast 且 compatRead 未执行、compatRead 读取异常被包裹且 flush 照常；默认配置非合法启用 profile（enabled 翻转 alone 仍拒绝）。
5. 窗口/泄露：绝对窗口结束 + heap 重建不重开窗口（零新增读取）；低 bucket 跳过消耗本 tick 尝试名额（同 tick 恢复也不补采）；fault 清空保留快照；输出不含原始任务/预留负载、holder 身份串与凭据形态。

## §4 是否发现 Memory 尝试写入、索引跨采样陈旧或旧业务行为变化

**未发现。**独立反例与交付用例共同覆盖：guard Proxy 全程零写、JSON 前后不变、runtime 无新增键、treasuryCore 保持 present_not_interpreted/activeCount=null；每采样新建读取模块缓存与索引（旧 writer 不 bump 新 revision 也读到新值，calls.readers 递增实证）；候选实际 main.ts 与固定基线逐阶段对拍（除新增相位外 deepEqual，flush 行为一致，原业务异常仍 fail-fast）。

## §5 默认关闭、生成物来源、原主循环、构建体积与旧基线预算是否成立

- **默认关闭**：源码 `TREASURY_COMPAT_CONFIG.enabled=false`、冻结；bundle 内 `enabled: false` 原样可见（`05-build/`）；运行级测试证明关闭时不触碰任何端口（含模块构造）；默认值不是合法启用 profile。
- **生成物来源**：`docs/treasury-compat-source-manifest.json` 记录 8 模块路径/blob/sha256/字节数、编译器 5.9.3、12 输出清单与 `preparedNotDeployed:true`；生成物头部标注固定 source commit。
- **原主循环**：38→39，仅末尾诊断相位；六项旧 main 顺序测试原样通过（改动仅为相位表+计数）。
- **构建**：`npm run build` EXIT=0（未设 DEST，build-only；deployGuard 生产守卫未触发属预期）。单模块 `dist/main.js` = 4,586,665 字节，较当前线上 `default` 分支模块（4,494,463 字节）+92,202 字节（≈+2.05%）。线上现存 4,494,463 字节单模块证明该账号可接受 ≥4.49MB；账户级单模块上限离线不可确证，**不得因 build exit=0 推断满足上传限制**——实际发布前仍须以真实上传核验。
- **预算**：全量 Jest 195 suites / 685 tests 全绿（CANDIDATE_VALIDATION_HEAD，`04-full-and-budget/candidate-full.json`）；新增 Jest 恰 2 个 wrapper（装配方 1 + 独立方 1），内部 Node 用例（41+10+19）不计入 Jest 计数。预算锚点按真实收集更新至 195/685、基线 commit 移至 `6d514b5`；`node scripts/verify-jest-budget.mjs` 输出 `JEST_TEST_BUDGET=PASSED`（该脚本内部重跑一次全量 Jest，属其真实行为，已如实记录，未跑第三遍）。旧 main 六项测试未减少。
- **第二干净工作树**（最终 SHA `7ceabba` 独立 npm ci + TS 5.9.3）：tsc×2 EXIT=0、Node 70/70（bridge+real-readers+independent）、定向 Jest 8/8、构建 EXIT=0。17 个变更文件两树 sha256 逐一相等；同 SHA 构建 bundle 仅 3 行差异（BUILD_TAG 时间戳、BUILD_DEPLOY_BRANCH 分支检测——分支工作树 vs detached、自引 `__DEPLOY_BUNDLE_HASH__`），业务字节一致。第二树是干净环境复验，不称其为另一执行者的独立审查。

## §6 是否上传 Screeps、是否有线上新桥样本

**未部署、未采样。**零 Screeps API 调用（本轮无需线上读取，未使用免限流授权）、零上传、零 `npm run push` / `npm run local`、未切换活动分支、未写线上 Memory、未动用户监控。该小候选之后的限定线上观察仍需：核对当前活动模块、明确覆盖/关闭授权与实时 profile（含外部墙钟收尾）；本包不预填结构 ID、起止 tick 或制造部署许可。

## 未执行边界（诚实清单）

- 8 文件闭包生成与 10 项 real-readers（交付环境 DNS 失败未执行）→ 本轮已执行 ✅；目标仓库锁定依赖完整类型检查 → 已执行 ✅；候选全仓 Jest/预算 → 已执行 ✅；真实 Rollup bundle → 已执行 ✅。
- **游戏执行或部署未执行**（真实 CPU、线上行为、上传体积服务端核验均未验证）。
- token/免限流：本轮零线上请求，未触发；未在命令行/日志/证据中出现凭据（脱敏扫描见 `independent-acceptance.md`）。

## 环境与命令保真

所有命令以绝对路径在 Git Bash 执行、退出码留痕（各子目录 log/JSON）；`unset DEST DEPLOY_ALLOW_DIRTY` 于每条构建/测试命令前执行。证据目录树：`00-package`（任务包原件）、`01-assemble`、`02-first-round`、`03-independent`、`04-full-and-budget`、`05-build`、`06-second-tree`、`07-frozen-diff`。

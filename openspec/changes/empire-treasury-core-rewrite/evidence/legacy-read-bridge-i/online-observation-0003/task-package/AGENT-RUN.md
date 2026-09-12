# 正式兼容观察 0003 — 完整实现交付 / Agent 仅验证

## 0. 工作范围与权限

本包的代码、固定测试、配置生成器、独立恢复进程、原始日志验证器、归档与提交工具已经实现。执行 Agent 不设计规则、不写补丁、不改测试、不放宽门槛。仅填写真实目录参数、验证固定字节、运行固定命令和报告结果。

本轮授权官方服 `screeps.com`，账号 `forster`（`634fe406347a7b69b28aeccb`），活动分支 `default`，`shard1`。房间仅 `E3N59` / `E4N58`，资源仅 `energy` / `H`，端点仅 `storage` / `terminal`。

本轮明确授权：**至多一次候选 code POST，以及至多一次恢复 code POST**。恢复只有在当前模块仍逐字节等于本轮候选时才执行。未上传则不发送恢复。所有 HTTP 读取均有限时；代码写入不自动重试。目标分支必须排他使用：确认没有其他人、watch/push 进程或部署自动化会并发改 `default`。不能确认时，停在离线阶段，不能勾选 `--exclusive-target`。

不授权完整 Treasury 分支部署，不授权 Terminal send、market deal、console 代码注入、Memory 写入/迁移，不扩大房间、资源或生产源码范围。旧 bot 自己原有的游戏行为继续运行，不能把“观察器不写 Memory”扩张成“整个旧 bot 不写 Memory”。

**不要重跑已验收的 25 分钟 Guard 探针。** 本轮直接使用已闭合的先决证据。原始历史 evidence 一律不改。

## 1. 固定基线

| 用途 | 分支/对象 |
|---|---|
| 新 evidence 基线 | `refactor/empire-treasury-rearchitecture@ee03fb4a871b1a707a4244d2f3a7819e5982324d` |
| 兼容候选基线，默认 OFF | `compat/treasury-read-bridge-i@fcfc125f0e5cd6c3370318b4fee0450f4d09af53` |
| 线上原件 BUILD_COMMIT | `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c` |
| 线上模块集合摘要 | `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf` |
| 线上 main SHA-256 / bytes | `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b` / `4494463` |
| canonical deployGuard Git blob | `796e71d9b5572014fd2ce8e9a0ee797e4e04c7a8` |

先使用 `git worktree list --porcelain` 定位两个既有工作树，不另造分支、不复用过期 profile `104e47b…`。必须使用 Node 22（Windows 原生 Node 22.19.0 可用），不要求 WSL、不要求文件系统大小写敏感。不要设置 `NODE_OPTIONS`、`DEST`、`DEPLOY_ALLOW_DIRTY`。

下面变量仅是路径示例，按实际工作树填写；这不构成实现修改。`PKG`、验证输出、实时工作目录全部在 Git 工作树外。不得删除旧轮现场。

```bash
PKG='D:/code/screeps/obs0003-package'
REF='D:/code/screeps/screeps-bot'
COMPAT='D:/code/screeps/compat-worktree'
SECRET='D:/code/screeps/.secret.json'
VALID='D:/code/screeps/obs0003-validation'
WORK='D:/code/screeps/obs0003-live'
```

`SECRET` 必须是已有凭据文件的**路径**，绝不把 token 值放进命令行。确认 `WORK` 不存在；存在就停止，不删除、不改 runId 后重试。首次验证输出根 `VALID` 可创建，但 `VALID/tests`、`VALID/compat-offline` 必须尚不存在。

## 2. 下载、解压与基线

核验发布的 ZIP SHA-256 后完整解压。不要通过截断管道逐段解压。不要在包目录里写 stdout/TAP/临时文件；精确文件集合校验会拒绝新增文件。

```bash
node "$PKG/tools/check-baseline.cjs" --refactor "$REF" --compat "$COMPAT"
```

该命令同时核验包文件集合、两个 clean 本地/远端 HEAD、canonical deployGuard、Node 22 和已通过的 Guard 重裁决证据。任何漂移停止，不能自动 rebase、强推或把新的 HEAD 当作已审过。

## 3. 固定实现测试与真实兼容基线验证

```bash
mkdir -p "$VALID"
node "$PKG/tools/run-tests.cjs" --out "$VALID/tests"
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$VALID/compat-offline"
```

第一条工具命令必须获得固定 **92/92**，skip/todo/cancelled 均为 0，真实 TAP/stdout/stderr/退出记录由工具自动落盘。测试含独立 Node 子进程、模拟远端状态、真实 loopback HTTP 请求和真实临时 Git 仓库；不连接 Screeps。不要把这些数目与旧生产 Jest 数目相加。

第二条命令按固定源码运行两套 TypeScript 检查、原仓库 `verify-jest-budget.mjs`（195 suites / 685 tests）和一次 `DEST` 未设置的 warm build。依赖必须来自仓库锁文件；依赖缺失时先停止并报告，不改 package.json/lock 或预算文件。既有依赖已就绪时直接执行，不在采样窗口绑定后才安装依赖。

离线失败：保留原件、零上传、停止，不让 Agent 现场修绿。此前的证据整改不用重做。

## 4. 唯一一次正式观察入口

确认验证全部通过、部署目标排他使用、机器可持续运行约 90 分钟并另外留出恢复/后检时间后，执行一次：

```bash
node "$PKG/tools/observe.cjs" \
  --refactor "$REF" --compat "$COMPAT" \
  --offline "$VALID/compat-offline" --tests "$VALID/tests" \
  --work "$WORK" --secret "$SECRET" \
  --execute --exclusive-target
```

**不要拆成“绑定 profile 后过很久再 execute”的手工流程。** 单入口会立即按固定顺序执行：

1. 再核对基线与离线结果，读取线上真实模块与账号/活动分支/房间归属。
2. 在离线验证完成后读取新鲜官方 tick：`S = ceil((liveTick + 150) / 100) × 100`，`E = S + 1100`。恰好 12 个点，100 tick 间隔。不把任何预先写死的 tick 当作新鲜前检。
3. `compat` 只产生一个 ON profile 提交，唯一源码路径 `src/runtime/treasuryCompatConfig.ts`。其他生产源码保持不变。
4. 在 `$WORK/build` 建立该 HEAD 的 detached 构建树，共用既有 node_modules junction，运行类型检查与 frozen Rollup。没有 DEST；只构建不上传。detached 使 frozen Rollup 的目标身份为 `default`，避免把 Git 分支名误作为线上目标。
5. 核对 bundle 内 HEAD/tree/dirty/目标分支及内嵌哈希；再次读取线上代码与 tick。线上已变或距 S 少于 100 tick 时，**不上传，不改窗口**，关闭本轮源码后报告。
6. 将完整 backup/candidate 放在 `$WORK/run`；摘要另存 `public-session.json`。完整模块正文绝不进入 Git。
7. 启动独立 collector，再启动独立恢复 worker。等待 console/CPU 双通道与 guard-ready 新鲜后，才允许唯一一次候选 POST。
8. `upload-attempt.json` 在 POST 前排他创建并 fsync；重复入口、已有 closing 或已恢复尝试均禁止再上传。POST 返回与逐字节回读分别记录；不把超时当作“未执行”。
9. 观察器取得预定 12 点。恢复 worker 复用已验收的分类式有限重试：每周期最多三次、单次最多 2500ms、250/750ms 退避，周期预算最多 8000ms；一个完整失败周期降级，连续两个失败周期关闭。collector 异常、样本不完整/错序、未知部署身份或墙钟截止均触发关闭。
10. 最末样本到达后恢复；若末点 HTTP tick 已经过而 console 尚在传送，允许固定 20 tick 的末点传输宽限，不增加采样点、不延长编译期窗口。候选从 E 之后本身就不再采样。
11. 恢复前重新核验当前模块只可能是本轮候选/原件；第三方代码不覆盖。`restore-attempt.json` 也在 POST 前排他创建并 fsync，最多一次恢复写入。恢复进程死亡且尚无恢复写入标记时，父监督器可接管这一次恢复；有标记就不重发。
12. 以独立只读回读补充确认恢复，继续用同一 collector 观察至少 75 秒新鲜 console/CPU，再次读取线上模块原件。CPU 为账号频道，shard1 由 console 和身份/代码回读独立约束，报告不声称 CPU 频道本身带 shard 字段。
13. collector 正常收尾，源码自动产生 OFF 提交；关闭后完整 Git tree 必须等于初始 `fcfc125…` tree。该 OFF 源码不再次上传，线上应是前检旧生产原字节。
14. 从原始 WebSocket 日志重新解析样本和部署身份并验收，不把 guard 的汇总自报当作成功。

硬截止仍为从候选上传尝试开始 **90 分钟**，不因慢 tick 或缺样本临时放宽。如果服务器速度使 12 点来不及完成，只能记录 INCONCLUSIVE 并恢复；不得追加第 13 点或开启第二窗口。

## 5. 正确处理成功、失败与恢复不确认

`observe` 退出码 0 才表示完整观察通过；退出码 2 表示已产出非成功观察裁决。查看 `$WORK/run/observation-verification.json` 和原始恢复记录，不能仅看终端最后一行。

采样阶段失败后，**必须先让已启动的恢复 worker 完成安全收尾**。失败即停止的含义是不再尝试新窗口、不修改实现，而不是把恢复进程杀掉。如果父进程意外退出，独立 worker 仍负责原窗口与墙钟截止恢复；不要删除包、toolkit、build 或 run 目录，也不要重建运行中的工具目录。

恢复未确认时，可以运行只读查询，不会补发写入：

```bash
node "$PKG/tools/reconcile.cjs" --compat "$COMPAT" --run "$WORK/run" --secret "$SECRET"
```

本轮只读查询结果可另存外部诊断目录，但不能覆盖已有原件。出现 `CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT`、残留 action lock、仍在运行的 guard 或 `UPLOAD_OUTCOME_UNRESOLVED` 时报告人工处置，不自行删除锁、不调用 API 手工强制覆盖。

只有识别到本轮合法 profile HEAD 时，下列命令才可恢复本地默认 OFF；它不调用 Screeps：

```bash
node "$PKG/tools/close-source.cjs" --compat "$COMPAT" --run "$WORK/run"
```

机器断电、操作系统杀死全部进程、磁盘不可写及服务器缺少 CAS 的竞态，不能被本包承诺为“绝对可恢复”。本包保留原件、写前标记、固定窗口和明确不确认终态，而非伪造恢复成功。

## 6. 12 点验收口径

必须全部满足：预定 12 点完整且顺序一致；候选部署身份帧与编译 tag 匹配；每点四个端点直接读取成功并与固定核心选定范围匹配；权限标志始终 false、spendable 始终 null；legacy 输入没有将缺失/损坏/超界伪造成空表；commitments 四个 room/resource 行及完整性成立；无 output_limited、fault、CPU 跳过造成的缺点或重启拼接；唯一 footer、退出码与 PID 对应；恢复前后回读和 75 秒主循环证据完整；本地源码默认 OFF。

CPU 必须诚实区分：12 个 `cpuBeforeSerializationAndEmit < 2`；后继样本可归属的前 11 个 `previousRun.cpuIncludingEmit <= 5`。**末样本完整成本没有第 13 点可报告，固定为 `not_observable_with_frozen_reader`**，不凭空补零或为取成本扩大采样窗口。这沿用既有冻结读取器的可观测边界。

commitment builder 没有另设独立调用计数器。12 个完整报告对应冻结源码的调用路径，但不能声称取得一个并不存在的底层运行计数器。legacyProjection 的 stale/absent/mismatch 保留原值并统计；不能由“direct/core 匹配”推导整个旧投影或 Treasury 决策全部等价。

允许最终标签：

- `ONLINE_COMPAT_READ_OBSERVED / RESTORED`：完整通过。
- `ONLINE_COMPAT_READ_INCONCLUSIVE / RESTORED`：缺样本或其他验收失败，但恢复链完整。
- `ONLINE_CLOSE_UNCONFIRMED`：恢复证据不足；原始恢复 POST 结果不可改写。
- `NOT_DEPLOYED`：没有进入候选 POST 边界。

禁止 `TREASURY_PRODUCTION_READY`、完整 Treasury 已切换、全帝国等价等超出本轮证据的结论。

## 7. 归档与推送

确认没有仍在运行的恢复/collector 进程后，无论本轮通过还是失败，都按白名单归档（若在离线阶段就失败，未建立 live run，只保留离线现场并停止）：

```bash
node "$PKG/tools/archive.cjs" --refactor "$REF" --run "$WORK/run" \
  --tests "$VALID/tests" --offline "$VALID/compat-offline" --secret "$SECRET"
node "$PKG/tools/publish.cjs" --refactor "$REF" --compat "$COMPAT" --push
```

归档器在接触 Git 前完成 token 原值、URL 编码、8/16 前缀检查；只复制列出的日志与摘要，**绝不递归复制 live 目录**，不复制 backup.json/candidate.json/session.json，也不复制凭据。完整任务包和测试原件入新 evidence，使独立审查者可复算。不要改写历史 evidence。

新增路径仅：

`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0003/`

正常结果是 compat 两个线性提交（ON、OFF，净源码差异为零），refactor 唯一 evidence 提交。推送前再确认两个远端没有漂移，不使用 force/reset/amend/rebase。推送失败保留本地 SHA 并报告，不能启动第二轮观察。

## 8. 最终回复

报告实际两个 HEAD 与 push 结果、92 项固定工具测试和195/685候选基线各自结果、profile 起止 tick、唯一上传与恢复的原始状态、12 点中取得数量与缺失项、CPU 的11+1口径、线上恢复证据和默认OFF源码HEAD。区分原始 guard 恢复结果与独立回读补充结论。

不要让 Agent 根据本包继续设计 schema、补丁或额外反例。任何新缺陷返回制作方处理，原件和失败标签不得为修绿而改动。

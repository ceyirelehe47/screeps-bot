# Treasury Production T1 阶段状态（2026-09-24；2026-09-25 更新）

## 候选范围

基线为旧生产源码 `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c`。本分支只移植国库执行所需的核心依赖，并将既有 `resourceControl` 转运任务接入生产主循环。默认 `Memory.cfg.treasuryTerminalTransferSlice0` 缺失即 OFF；本分支没有上传到 Screeps。

首个写入候选固定为本账号 `E3N59 → E4N58` 的既有 H 转运任务：一次最多 100 H，实时手续费最多 100 energy，一个持久配额只允许一次 native dispatch。不存在符合条件的旧任务时不会自动造任务。`shadow` 只读观察；`drain` 停止新接纳并处理已存在的 work；OFF 状态遇到未结 work 仍会排空，不直接交回旧 writer。

## 接入与排他

| 入口 | 本分支行为 |
| --- | --- |
| `src/main.ts` | 在旧生产 tick 顺序前装配 Treasury 生命周期；`finally` 完成排空与 CPU 记录。 |
| `src/runtime/resourceControl.ts` | 原任务排序中接管匹配的单个切片，沿用本 tick 的 send budget、terminal busy 与接收容量账本。拒绝或结果未知时不落回旧发送路径。 |
| `src/runtime/resourceReservation.ts` | 旧预约表经版本化迁移后，旧调用者也使用 typed owner；未知版本或损坏数据拒绝迁移并保留原表。 |
| `src/runtime/marketActionArbiter.ts` | T1 配额、租约或执行记录尚未结清时，阻止两端 terminal 的其他 native 写入及发往目标房的其他 send。 |
| `src/runtime/treasuryTerminalTransfer.ts` | 对真实 terminal、结构 ID、owner、库存、费用、共享容量和旧任务做执行前复验；记录 dispatch 配额，按交易与世界观测对账，确认后才减少旧任务 remaining。 |

同一个旧任务切片在授权时按精确 task ID 与数量排除，其他旧任务和预约继续计入承诺。内核 work 承担执行状态，不作为第二份业务需求。

## 已完成验证

- `npm run typecheck`：通过。
- `npm run build`：build only，通过；没有线上上传。
- 相关 Jest 组合回归：`resourceControl`、容量回归、旧转运任务、预约、市场仲裁、Treasury T1、生产入口、主循环及巡逻，共 9 个 suite 通过。生产入口测试实际调用 `runResourceControl()`，并经真实 facade/kernel 到达 `terminal.send` 的 Game 边界；Game 边界仍为测试替身。
- 独立的 shard1 巡逻修复 `5cef62c5` 已作为后续基线差异移入本分支，避免以后部署国库候选时恢复旧破墙行为。
- **真实隔离 Screeps Engine 4.3.0：成功链路已通过。** 已经从生产任务入口对非空旧任务与预约发送一次 100 H，经引擎原生交易确认后扣旧任务余量，`drain` 无重复交易，OFF 交回旧 writer 的 150 H，重启后仍不重发。另做带逐阶段 CPU 采样的第二轮合成复测。原始快照、指纹、校验脚本与计量边界见 [隔离引擎验收报告](treasury-production-T1-engine-acceptance-20260925.md)。本测试没有上传正式 shard1。

## 尚未通过的准入

- **正式灰度**：本分支从未上传正式 shard1，也未在正式服开启 `canary`。隔离引擎验收已经完成，独立审查和 writer 灰度决定仍未完成；准备稿见 [首次灰度说明](treasury-production-T1-first-gray-20260925.md)。
- **G1 FC1 Online II 已单独完成**：获本轮限定授权后，独立的巡逻安全兼容候选在 shard1 采集 4 个报告与 4 份完整成本回执；候选/恢复各写入一次，原巡逻修复字节及恢复后运行均已确认。G1 的源分支和证据分支与本 G2 产品候选分开；本候选仍未上传正式服。详见 [任务包最终状态](treasury-production-T1-final-status-20260925.md)。
- **产物大小**：当前 build-only `main.js` 为 4,946,214 字节，距离按十进制计算的 5 MB 仅余约 54 KB。仍需在正式候选验收时复核平台模块限制、生成内容和余量；本地构建通过不等于线上上传成功。

因此本文件记录的是已通过真实隔离引擎成功链路的可审查候选，不宣称正式生产就绪。首次灰度的费用/CPU停止阈值目前属于策略选择；仍须以线上只读状态、已归档的 G1 结果及独立审查核定。

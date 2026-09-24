# Treasury Production T1 阶段状态（2026-09-24）

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

## 尚未通过的准入

- **真实隔离 Screeps Engine**：本机未发现可复用的隔离 server 安装或运行进程；尚未让本候选经真实引擎完成一次转运、到账、任务扣减和 drain。Jest 结果不能替代该项。
- **正式灰度**：本分支从未上传，未开启 `canary`，未获得引擎验收及独立审查后的 writer 灰度决定。
- **G1 FC1 Online II**：这是另一项一次性线上测量；本分支的测试与构建不构成 G1 的四点实测或恢复证据。用户本轮只授权部署巡逻修复，未将本候选或 G1 测量上传到正式服。当前线上已加载巡逻修复 `5cef62c5`，而 G1 包内备份与恢复依据仍是旧生产字节；不能用旧包直接覆盖现役巡逻代码，必须重新核定基线、候选与恢复字节及对应授权。
- **产物大小**：当前 build-only `main.js` 为 4,946,214 字节，距离按十进制计算的 5 MB 仅余约 54 KB。仍需在正式候选验收时复核平台模块限制、生成内容和余量；本地构建通过不等于线上上传成功。

因此本文件记录的是可审查的阶段候选，不宣称生产就绪。正式灰度入口、费用/CPU判据和恢复步骤必须在真实引擎结果、线上旧任务及预约快照、独立审查后定稿。

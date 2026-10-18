# 原 20 项架构目标完整验收

本记录对应业务发布 `2026.10.18-10`、提交 `77d42c10fcdfe074298180fd6ccf6e554c15f0b7`，不是把每批局部修改算作完成。原 20 项及 A1–A20 已按生产接入、反例、完整回归和线上身份逐项核对；功能复查 R1–R10 的既有修复继续保留，见 `2026-10-18-recheck-fixes.md`。

## 整体验证

- 服务器两套类型检查通过；无过滤完整回归 **296 套件、2339 用例全部通过**，没有失败、跳过或 todo。全部 1781 个受控文件的字节与提交树绑定，20 项引用的反例套件全部通过。
- 干净 `main`、`origin/main` 与远端实际 main 对齐后构建。构建使用同一 main 提交的隔离 checkout，目标分支为 `default`，未使用 dirty override 或构建服务器凭据。
- 正式产物语法通过，64 个压缩映射抽样一致；运行模块 3379876 字节。commit/tree/tag/内容哈希和完整模块读回一致，回滚保存为此前实际运行的完整 `57dbd79d` 模块。
- shard1 实际执行 tag：`2026.10.18-10+77d42c1@2026-10-18T03:16:10.508Z`；部署 tick 74404038，最终核对 tick 74404124，独立健康记录完成至同 tick。
- 订阅后连续观察 240 秒、55 帧，console 错误、捕获异常与未知 shard 错误均为 0；阶段累计失败没有增加，没有新的完成 tick 缺口或未完成记录。旧回滚误记保存在 `legacyGap`，历史记录没有被删除来冒充健康。

## 逐项对应

下列反例属于服务器测试和故障注入；线上确认发布身份及有界业务状态，没有在线制造故障或扩大市场权限。

| 编号 | 范围 | 生产接入 | 反例证据 | 验证边界 |
| --- | --- | --- | --- | --- |
| 1 | 统一寻路、独立完整性/ops、partial TTL | src/movement/pathSearch.ts; src/movement/moveProfile.ts; src/movement/pathing.ts | src/movement/pathSearch.test.ts; src/movement/pathing.crossTickCache.test.ts | 预算耗尽不二次搜索；异常预扣；规划额度不能侵占 creep 执行 |
| 2 | 出口同矩阵、严格路由缓存/退避、stuck 幂等 | src/movement/routing.ts; src/movement/pathing.ts | src/movement/routing.unified.test.ts; src/movement/routing.test.ts; src/roles/powerBankCombatPair.test.ts | 静态封路保留退避；预算/策略等待不记死路；同 tick 重入 |
| 3 | 任务 owner 出征准入与防御/RESERVE | src/runtime/outboundMissionPolicy.ts; src/runtime/outboundMissionRegistry.ts | src/runtime/outboundMissionPolicy.test.ts; src/runtime/architectureBoundaries.test.ts | Deposit 当前世代、出生房 fallback、旧战争承诺到期、已占领 bootstrap |
| 4 | 防御优先真实分层、独立健康、EMA 预算 | src/main.ts; src/runtime/processTable.ts; src/runtime/processScheduler.ts; src/runtime/cpuTickHealth.ts | src/runtime/processScheduler.test.ts; src/runtime/cpuTickHealth.test.ts | 低 bucket、后续关键阶段成本、每 tick 新 Game 对象、profiler 关闭/缺帧 |
| 5 | 逐房隔离、普通熔断、告警、半写收敛 | src/runtime/runtimeIsolation.ts; src/runtime/synthesisControl.ts; src/runtime/nukerControl.ts; src/runtime/powerSpawnControl.ts | src/runtime/runtimeIsolation.test.ts; src/runtime/synthesisControl.test.ts; src/runtime/nukerControl.test.ts; src/runtime/powerSpawnControl.test.ts | 关键房每 tick 重试；普通半开恢复；失败 producer 撤回未执行规划并保留已接受责任 |
| 6 | 统一测试寻路与移动观测 | test/mock/movement.ts; src/movement/metrics.ts | src/movement/pathSearch.test.ts; src/movement/traffic.resolution.test.ts; src/movement/routing.unified.test.ts | 单房 A* 的预算/障碍；实际 intent 覆盖、拒绝与取消分开计数 |
| 7 | 安全区独立稳定缓存矩阵层 | src/movement/safeZoneLayer.ts; src/movement/pathing.ts | src/movement/safeZoneLayer.test.ts; src/movement/routing.combat.test.ts | revision/布局失效；clone；自定义无 key 回调不能缓存；策略拒绝区别断路 |
| 8 | 写入所有权与 owner GC | src/runtime/memoryGcRegistry.ts; src/runtime/registerTaskMemoryOwners.ts; src/runtime/logistics/resourceTransferTasks.ts | src/runtime/taskMemoryOwnership.test.ts; test/treasuryCommitmentInvalidationBoundaries.test.ts; src/runtime/architectureBoundaries.test.ts | 跨 shard/Deposit/Rescue 活体和出生保护；patch 自动 revision；中央不读领域子树 |
| 9 | TickContext 唯一全扫及 cargo 增量，调和门控 | src/runtime/tickContext.ts; src/runtime/carrierCargo.ts; src/runtime/reconciliationGate.ts; src/runtime/bootstrap.ts | src/runtime/carrierCargo.test.ts; src/runtime/reconciliationGate.test.ts; src/runtime/architectureBoundaries.test.ts | 同 tick 重定向、堆重置、失败不记录门控、成员/到岗事实改变 |
| 10 | 配置与出生请求统一写入 | src/runtime/creepConfigService.ts; src/runtime/spawnRequests.ts; src/mount/mountSpawn.ts | src/runtime/creepConfigService.test.ts; src/runtime/spawnRequests.test.ts; test/creepConfigMutationBoundaries.test.ts | 不可变 DTO、去重/队列变更、拒绝原因、成功出生收据 |
| 11 | 配置 revision 读索引 | src/runtime/creepConfigService.ts; src/runtime/spawnPlanner.ts | src/runtime/creepConfigService.test.ts; src/runtime/architectureBoundaries.test.ts | 写后读刷新、旧快照不变、出生规划不重复 list |
| 12 | 声明式进程与稳定错峰 | src/runtime/processTable.ts; src/runtime/cadence.ts; src/runtime/cpuMonitor.ts | src/runtime/cadence.test.ts; src/runtime/processScheduler.test.ts; src/runtime/architectureBoundaries.test.ts | 42 个生产阶段；依赖顺序；裸取模边界；相位只统计实采样桶 |
| 13 | 显式 MoveProfile 生产迁移 | src/movement/moveProfile.ts; src/movement/pathing.ts; src/roles/shared.ts | src/movement/pathSearch.test.ts; src/movement/pathing.test.ts | 完整性、maxOps、reusePath、partialTtl 独立；无失效 travelRange |
| 14 | 分层缓存/布局 revision/战斗回调 | src/movement/matrixCache.ts; src/movement/matrixLayers.ts; src/roles/towerDrainPair.ts | src/movement/matrixCache.test.ts; src/roles/towerDrainPair.test.ts; src/movement/pathing.crossTickCache.test.ts | clone、容量/TTL、布局变更；战斗约束 key；缓存下一步重新验风险 |
| 15 | 任务生命周期与集中退役/boostParts | src/runtime/taskLifecycle.ts; src/runtime/retirement.ts; src/runtime/boostParts.ts | src/runtime/taskLifecycle.test.ts; src/runtime/retirement.test.ts; src/runtime/boostParts.test.ts; src/runtime/powerBankHarvest.test.ts; src/runtime/architectureBoundaries.test.ts | 非法/重复转换、entry 第 k 步失败重试、出生中退役、异种 boost、PB 次 tick 货物确认 |
| 16 | PB/War 共同小队内核 | src/runtime/squads/squad.ts; src/roles/powerBankCombatPair.ts; src/roles/warPartner.ts | src/runtime/squads/squad.test.ts; src/roles/powerBankCombatPair.test.ts; src/roles/warDuoMovement.integration.test.ts | 角色/世代/双向绑定、同帧幂等、外部移动事实改变才重试、跨房同步 |
| 17 | 执行协议/粘性动作/休眠/帧末交通 | src/runtime/creepExecution.ts; src/mount/mountCreep.ts; src/movement/traffic.ts; src/roles/miner.ts; src/roles/mineralHarvester.ts | src/runtime/creepExecution.test.ts; src/roles/miner.execution.test.ts; src/movement/traffic.resolution.test.ts; src/roles/warDuoMovement.integration.test.ts | 真实 miner 停采复验、提前唤醒、重置回落、让路接管、交换/环、成组取消与取消失败 |
| 18 | 市场静态预检复用与实时安全、shadow owner | src/runtime/marketBaseResourcePermit.ts; src/runtime/processTable.ts; docs/runtime-shadow-owners.md | src/runtime/marketBaseResourcePermit.test.ts; src/runtime/processScheduler.test.ts | 完整不可变证明后缓存；可变后代/访问器/外部高水位始终重验；T0 廉价安全闸 |
| 19 | 既有许可链 segments 能力重新验收 | src/runtime/permitChainSegments.ts; src/runtime/permitChainSegmentCodec.ts; src/runtime/memoryStorage.ts | src/runtime/permitChainSegments.test.ts; src/runtime/permitChainSegmentCodec.test.ts; src/runtime/memoryStorage.test.ts | 未激活/双 bank、容量拒绝、重置恢复、失败保留内联；既有能力不算新增收益 |
| 20 | 有界 epoch 事件与兼容 memory 瘦身 | src/runtime/runtimeEvents.ts; src/runtime/creepExecution.ts; src/runtime/spawnRequests.ts; src/runtime/memoryCleanup.ts | src/runtime/taskLifecycle.test.ts; src/runtime/creepExecution.test.ts; src/runtime/taskMemoryOwnership.test.ts | 容量/TTL、同序号 ABA、损坏恢复、跨房参数/货物/退役保留；不承诺大量节省 |


## 实际运行读取

- 配置索引可用且只读，revision=36、配置 79 条；26 个 Spawn 的兼容队列均只读。
- 事件队列已观察到任务转换、workforce 退役与实际死亡，使用带 epoch 的序号；移动累计读到 19 次取消、0 次 intent 覆盖和 0 次预算拒绝。计数只表示观察窗口内行为，不等于所有场景都在线触发。
- 冷数据能力属于既有实现的复验：segment 81/82/83、active epoch=1，JSON 813797 字节。tick 74404073 逻辑 Memory 1733137 字符，RawMemory 919856 字符；它们不是同一落盘瞬间的可减差值，也不作为本轮新增节省。非空角色参数、任务身份、货物与退役字段继续保留。
- 后段 sample tick 74404085：业务阶段 65.27 CPU、flush 边界 70.04 CPU；读取 tick 74404089 的 bucket=9900。这是预热后的有界样本，不能由不同 tick、角色负载及包含型 span 推导长期收益；市场实时账本和最终写入校验仍执行。

## 发布证据与文档提交关系

本记录随文档版 `2026.10.18-11` 提交，记录的业务验收明确绑定 `77d42c10`；文档版没有修改 src、测试、构建或运行脚本。文档版仍单独构建和核对实际执行身份，后续证据保存于忽略目录 `monitor-data/architecture-completion-record/`。

业务发布的完整原始证据位于忽略目录 `monitor-data/architecture-squad-execution/`：`evidence/full-final/verification.json`、`evidence/item-test-coverage.json`、`manifest.json`、`release-status.json`、`final-readback.json`、`post-final.json`、`final-git.json` 及有界观察/owner/Memory 读取。此前失败或被替代的候选保留在 evidence/attempt-*，不相加当作完整回归，也不记为发布成功。

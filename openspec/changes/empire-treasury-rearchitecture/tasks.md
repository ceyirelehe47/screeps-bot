# Tasks

## 1. 阶段 A：OpenSpec 与迁移地图

- [x] 1.1 建立 `openspec/changes/empire-treasury-rearchitecture/`（proposal/design/tasks/specs）
- [x] 1.2 记录权威数据边界、职责边界、tick/contract 生命周期、18 条不变量落实位置
- [x] 1.3 迁移地图（8 个消费者顺序）+ 旧模块删除清单 + adapter 删除条件

## 2. 阶段 B：Treasury Core

- [x] 2.1 `types.ts`：LocationKind/Epoch/JournalEntry/QueryContext/BalanceView/Metrics
- [x] 2.2 `observation.ts`：不可变稀疏 observation（storage+terminal）、多方向索引、observedAtTick/epochSeq、fresh scope 独立构建；复用 TickContext myRooms；每 Store 单次 Object.keys；无 Game 引用保留；无 Memory 持久化
- [x] 2.3 `projection.ts`：transaction journal、幂等结算（stale epoch 拒绝/already_settled 拒绝）、projected overlay、reconciler（差异计数+样本，不静默）
- [x] 2.4 `facade.ts`：TreasuryService（observation/commitments/query/recordAcceptedAction/metrics/resetForTest）+ RuntimeServices 注册（无新 global 槽）
- [x] 2.5 带上下文查询：observed/projected/committed/spendable/incoming/outgoing/transferable；spendable 非负 + overcommitted 置位；无无上下文 available API

## 3. 阶段 C：承诺统一索引

- [x] 3.1 transfer tasks：outgoing/pendingOutgoing/incoming/pendingIncoming/taskCount/route merge lookup（复用 canonical 谓词，零复制持久数据）
- [x] 3.2 production reservations：活跃聚合、holder 存在性（孤儿计数）、过期排除（不删除原始记录）
- [x] 3.3 receiver commitments：healthy incoming 聚合 + 轻量 headroom（口径差异在 design.md 声明）
- [x] 3.4 后续（非本轮）：ReceiverCapacityLedger 内存实例并入、Budget Service、Contract Service（authorize 语义）

## 4. 阶段 D：Shadow 与兼容

- [x] 4.1 `shadow.ts`：Treasury vs empireInventoryIndex core + 独立直读双通道对比；覆盖房间 storage/terminal 资源、帝国总量、capacity、缺失位置、stale epoch、承诺重复计数
- [x] 4.2 零行为写入（无 intent API、无生产行为变化）；低频采样（40 tick）+ force 通道；mismatch 环形缓冲 cap + 聚合计数；低频快照 Memory.runtime.treasuryPerf（断言写入，沿用 inventoryPerf 先例）
- [x] 4.3 挂载 main.ts treasuryShadow phase（empireInventoryShadow 之后）
- [x] 4.4 兼容层：本轮直接替换 productionMonitor（无 adapter）；hubProgress adapter 待消费者迁移阶段建立时再定义删除条件

## 5. 阶段 E：消费者迁移

- [x] 5.1 productionMonitor storage/terminal energy 读取改走 Treasury observation（行为输出等价）
- [ ] 5.2 （下阶段）hubProgress/console 面板迁移 + 新旧输出 shadow 对比
- [ ] 5.3 （下阶段）resourceControl 热路径替换（getStoredResources / 重复采集点）

## 6. 验证与门禁

- [x] 6.1 新增测试：observation 不可变/稀疏枚举/总量=Σ桶/查询无副作用；projected 不改 observed/成功才产生 delta/幂等/跨 tick 不重复结算；承诺过期排除/孤儿计数/headroom 非负/spendable 非负/stale epoch 拒绝；shadow 零写；RuntimeServices reset
- [x] 6.2 确定性操作计数断言（storeEnumerations/resourceKeysEnumerated/roomFindCalls=0）
- [x] 6.3 `npm run typecheck`、`npm run build`、全量 Jest 通过（区分本次回归 vs 既有失败）
- [x] 6.4 Jest 预算治理：collect → apply-budget → verify 锚点更新 → `npm run test:budget`
- [x] 6.5 市场安全相关既有测试保持通过（零市场代码改动）

## 7. 上线门槛（后续阶段，非本轮）

- [ ] 7.1 Treasury shadow 连续 1000+ tick 零 mismatch 后迁移 resourceControl 热路径
- [ ] 7.2 market-fresh epoch 接入前独立安全评审（不破坏 fresh floor/双读/CAS/WAL/permit）
- [ ] 7.3 旧模块按删除清单分批退役，每批附 shadow 证据

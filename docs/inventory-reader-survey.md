# Inventory Reader 清单（EmpireInventoryIndex 影子阶段调研，2026-08-29）

> 结论来源：全仓只读扫描（src/runtime、src/roles），排除 *.test.ts。
> 缩写 RC = src/runtime/resourceControl.ts。频率依据 src/main.ts 的每 tick
> 顺序执行 + 各模块内部节流。本清单是 `empireInventoryIndex.ts` 分层 API
> 的设计依据；影子阶段不改变任何下列读取者的行为。

## 0. 既有缓存基础设施（索引对齐的基线）

- `src/runtime/tickContext.ts:34-267`——每 tick 每 room 惰性缓存结构列表
  （按 structureType 索引）、dropped energy、energy tombstone/ruin。只缓存
  结构列表，不缓存 store 数值。
- `RC:1106-1187 collectResourceControlSnapshots`——单次调用内数值 memo；
  同 tick 多入口重复采集（runResourceControl + nukerControl:579 +
  synthesisCompatibilityPlanning:305 + shadowCapture:4111）。
- `marketBaseResourceAutomation.ts:2136-2169`——terminal 存在性每 tick 缓存。
- `marketSaleExposure.ts`——terminal 可用量的市场 exposure 扣减层
  （carrier/remoteCarrier/nuker/powerSpawn/RC 共用；索引必须保留该扣减
  语义作为消费者侧叠加，不进索引本身）。

## 1. Storage 读取者（语义 / 频率 / 缓存）

| 读取者 | 语义 | 频率 | 缓存 |
|---|---|---|---|
| RC 快照（:1117-1183） | energy 总量、总 used/free、（capturedResources 时）每资源量 | full tick 每 10 tick；readiness 授权时每 tick | 快照即缓存（单 run） |
| RC 任务规划（:1215/2277/5009/5703/6800） | 每资源量、free(resource) | 每 tick（授权时） | 经快照结构引用直读 |
| synthesisControl（:479-870） | 每资源量（供体/补给） | planning 每 10 tick；状态机每 tick | 无 |
| factoryControl（:342-736） | 每资源量（stock/补给/卸货） | 每 tick（sleepTicks 节流） | 无（findFactory 每次重扫） |
| hubPlanner（:547-2770） | free 总量 + 全 store 枚举 | 每 50 tick 或 needsPlan | 无 |
| hubProgress（:887-1239） | T3 化合物 + 全枚举 | 每 5 tick | 无 |
| boostControl（:39-177） | 单化合物量 + free | 买入每 5 tick；事件驱动 | 无 |
| nukerControl（:202-321） | energy/G 量（含 exposure 扣减） | 每 tick | 无 |
| powerSpawnControl（:31-41） | POWER/ENERGY 量 | 每 tick 每 room | 无 |
| powerBankBoost/Harvest | 化合物量 + free | 事件驱动 | 无 |
| marketSaleProtectionAdapter（:168） | 卖出资源 storage 分量 | 市场周期 | 无 |
| productionMonitor（:144） | energy 总量 | 每 5 tick | 无 |
| carrier/remoteCarrier/remoteMiningCarrier/upgrader/energyTargets | energy 存在性、free(resource) | 每 creep 每 tick | 结构列表走 tickContext |
| autoReserveFlag/mineralExtraction/powerCreepControl/linkControl/remoteMining | 存在性/pos/free(mineral) | 各自节流 | 无 |

## 2. Terminal 读取者（含 cooldown）

与 Storage 高度对称（同批函数，行号见上表对应项）。terminal.cooldown 读取者：
RC:1175/2448/5553/7622/7777/7874/7964（发送前 cooldown===0 过滤）、
synthesisControl:578（donor 过滤）、factoryControl:1152、boostControl:115、
powerBankBoost:477、marketDirectContinuousAutomation:1894/1906/4146、
marketSaleDirectAutomation:1427、marketActionArbiter:499/694-707（send 执行）、
marketBaseResourceAutomation:2147/2255。

## 3. RESOURCES_ALL / 全资源枚举热点（重点）

1. **RC:4947-4951 getStoredResources**：`RESOURCES_ALL.filter(r =>
   store.getUsedCapacity(r) > 0)`——每 tick × 每 room × ~35 资源 × 2 结构，
   全索引最大热点（快照已有 terminalResourceAmounts 却绕过直读）。
2. RC:1130-1141 快照捕获：terminal 始终全量 RESOURCES_ALL；storage 仅
   capturedResources 模式。
3. hubPlanner:919-962 getEligibleSynthesisRooms：全部 my rooms 的
   storage+terminal 全枚举，plan cadence 内多次调用无 memo。
4. hubPlanner:577-590/2616-2653、hubProgress:680-718/1203-1242：hub/卫星
   全 store 枚举（含 lab/factory/powerSpawn/carrier cargo），每 5-50 tick。
5. synthesisControl:477-523 roomResourceAmount：storage+terminal+
   FIND_MY_STRUCTURES(lab|factory|powerSpawn) 全扫，O(资源×房间×结构)。
6. factoryControl:340-353 getRoomStock：storage+terminal+factory 每资源，
   findFactoryInRoom 每次重扫。
7. RC:2271-2294 getResourceControlRoomStock（导出 API）：同 5。
8. 自建资源列表循环：RC:781-790/7641/7780/7986、
   marketBaseResourcePolicy:492/745/864/929、marketSaleConfig:1113、
   marketSaleProtectionAdapter:156/1168/1550、hubProtectionSnapshot:489/737。
9. Object.keys(store) 枚举：remoteCarrier:26-76（含 exposure clamp）、
   flagHauling:56-68、carrier:141-149/1316、movement/creepState:91-111。

## 4. Factory / Lab / PowerSpawn / Nuker

- Factory：factoryControl:322-747（存在性/stock/组件/卸货）、
  hubPlanner:2635-2645、productionMonitor:148。
- Lab（数量最多、每 tick）：synthesisControl:734-1230（反应进度/液位/清理）、
  boostControl:164-214、powerBankBoost:186-232、powerBankHarvest:415-420、
  hubProgress:890-898/1206-1218、energyTargets:118-123、combatBoosts:45-46。
- PowerSpawn：powerSpawnControl:21-153（water-mark 决策每 tick）、
  energyTargets:104-116、carrier:1755。
- Nuker：nukerControl:76-90/366-399/454-579（G/energy 全套 + 跨房调拨
  重采快照）、carrier:917、hubPlanner:2669。

## 5. Container / Creep store / Dropped / Tombstone / Ruin 独立扫描

- Container：tickContext:236-242（列表）、carrier:220-228、
  energyTargets:167-202、powerCreepControl:374-377、mineralExtraction:15-49、
  remoteWorker:122、hubPlanner:2635。
- Dropped：tickContext:243-250（energy）、carrier:217-218、
  remoteMiningCarrier:166、remoteWorker:78、powerBankHauler:87/107、
  powerBankHarvest:1742。
- Tombstone/Ruin：tickContext:251-266（energy-only）；
  **carrier:1275-1300 pickupOwnedRoomDeadStoreResource 直接 FIND 全资源
  （绕过 energy-only 缓存）**；remoteCarrier:98-102、flagHauling:82-87。
- Creep store：hubProgress:653-670（carrier cargo 清单）、
  synthesisControl:510-523（在途合成原料）、energyPickupReservation:246-270、
  movement/creepState:91-111、各 role 的 energy 直读。

## 6. 对索引分层 API 的直接结论

(a) Core 层必须覆盖：storage/terminal 每资源量（不是只有 terminal）、
capacity、cooldown——RC 快照语义 + synthesis/factory/hub 的 storage 每资源
需求（现状 storage 每资源只在 capturedResources 模式才采）。
(b) Production 层：lab/factory/powerSpawn/nuker 的 used/capacity/free +
每资源聚合（6+ 模块各自重扫）。
(c) Field 层：container/dropped/tombstone/ruin/creep（carrier pickup 链）。
(d) 修饰量不进索引：marketSaleExposure 扣减、carrier commitment、
capacityState——属消费者侧语义，索引只提供物理量。
(e) 快照房间集偏差：RC 快照只含有 terminal 的房间——索引 Core 覆盖全部
owned room（影子对账时注意该差异，不属于 mismatch）。

## 7. 微基准结论（提交 4 基准 fixture 的依据）

旧方式 = rooms × RESOURCES_ALL × getUsedCapacity(resource)（约 8×35×2 =
560 次/结构类/tick 的探测调用）；新方式 = Store 实际 key 枚举（现状每
room 通常 3-12 个资源 key）。确定性门槛：调用数（getUsedCapacity 计数）、
扫描数（storeObjectsScanned/resourceKeysEnumerated）与结果等价性；
wall-clock 仅作诊断。

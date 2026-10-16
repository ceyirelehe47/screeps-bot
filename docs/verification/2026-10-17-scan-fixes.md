# 2026-10-17 扫描问题修复记录

扫描基线：`a9c1f81a225731a1ca247cfc33a3a2dfd0e7dba2`。修复分支：`codex/scan-fixes-20261017`。

本次在独立工作区修复报告的 26 项高中风险问题和 11 组低风险问题。原工作目录的分支与未提交修改未改动。上述离线修复阶段未发布到 Screeps，也未改变版本号。后续经用户批准，整合线上 `2026.10.17-1` 的 CPU、许可链与面板改动，准备发布 `2026.10.17-2`；正式发布证据保存在本机忽略目录 `monitor-data/scan-release-20261017/`。

## 逐项对应

下表编号 1–26 沿用原报告；27–37 对应原报告的低风险清单。

| 编号 | 最终行为 | 主要实现与回归 |
| --- | --- | --- |
| 1 | 所有自有房间无本地采矿单位时均可优先孵化应急采矿体；可支付常规矿工时优先恢复常规矿工。 | `spawnPlanner.ts`；普通房、殖民房、重复排队与在孵化保护 |
| 2 | 战斗时最多一塔治疗，其余塔继续参与攻击。 | `towerControl.ts`；三塔治疗/攻击分工 |
| 3 | 只有不再拥有/殖民且超过 TTL 的布局才清理。 | `memoryCleanup.ts`；在用、近期离开、过期离开三类布局 |
| 4 | 带等级配方要求工厂等级相等且对应 Operate Factory 效果生效；无等级配方仍可在有等级工厂生产，旧失效配方的无用输入会卸出。 | `factoryControl.ts`；等级不匹配、过期效果、生效效果 |
| 5 | 无矿物卸货空间时不从死亡存储捡矿；已携带无主任务矿物时放下，解除阻塞。 | `carrier.ts`；无 Storage/Terminal、已有杂物及 mount 状态切换 |
| 6 | 排除 nuker 和敌方私有 rampart 覆盖的目标；不可取错误写入最多 16 项、50 tick 的 CreepMemory 黑名单。 | `remoteCarrier.ts`；有效目标选择、原生 Creep 对象重建后的黑名单 |
| 7 | 能请求观察时等待新视野；无法请求观察时按已知所有权避让继续行军。 | `powerBankTransit.ts`；无 Observer 回退、已知敌房仍禁止 |
| 8 | 应急能量采购缺口扣除 Terminal 现货及健康在途。 | `resourceMarketOperations.ts`；现货和在途覆盖 |
| 9 | 由当前合成批次重建需求，扣实际库存、健康在途及本 tick 已接受收货差量；旧 missing 不会重复覆盖需求。 | `resourceMarketOperations.ts`；调拨待发、send(OK) 尚未更新 Store、次帧到货 |
| 10 | 按包含转账能量成本的有效价格选择订单；每次采购及同轮多房采购都遵守 creditReserve。 | 市场有效价格及资金预留回归；默认 creditReserve=100000、energyShadowPrice=0.12，可配置 |
| 11 | 容器伤害快照记录 ticksToDecay，只把超出实际衰减的血量损失算攻击。 | `remoteMining.ts`；非整除 tick 衰减与额外攻击 |
| 12 | 储备模式保留一名维护 worker，并撤销 bootstrap 中旧的全量孤立逻辑；有核心工地时不进入自动储备。 | `roomWorkforce.ts`、`bootstrap.ts`、`autoReserveFlag.ts`；数量、配置、队列、关键工地 |
| 13 | 敌人全部免疫塔火力时仍执行应急 rampart 修理。 | `towerControl.ts`；攻击停止而应急修理继续 |
| 14 | 追踪核心 rampart 消失、真实 Spawn/Storage/Tower 受伤或消失及相邻敌 CLAIM；按结构衰减计时和核弹落地快照排除自然损伤。 | `coreDefense.ts`；摧毁、自然消失、塔受击、控制器威胁、核伤害 |
| 15 | PowerSpawn 仅取 Storage 超过 energyFloor 的能量；Terminal 同样保留能量底线。 | `powerSpawnControl.ts`；仅高出底线 123 能量及到达底线 |
| 16 | 合成/工厂补料的来源选择和任务金额均扣 Terminal 市场锁定量。 | `synthesisControl.ts`、`factoryControl.ts`；锁定后选 Storage |
| 17 | 切换配方时清空旧 loadingSinceTick，新配方重新计时。 | 合成换配方超时回归 |
| 18 | incomplete 使用有限距离估算；失败估算缓存 25 tick、成功估算 500 tick，上限 128 项。 | `remoteCarrier.ts`；新生不自杀与到期重测；缓存不保留历史 Game 对象 |
| 19 | 已成功治疗搭档后不再发自疗覆盖意图。 | `healer.ts`；双方受伤只保留一次有效治疗 |
| 20 | remoteWorker 无工作时清除旧移动状态并留在目标房。 | `remoteWorker.ts`；空闲不再请求返家 |
| 21 | worker 建造无路可达时释放任务。 | `worker.ts`；ERR_NOT_IN_RANGE + ERR_NO_PATH |
| 22 | withdraw/pickup 成功后保持取货阶段，下一 tick 按 Store 判断是否满载。 | `remoteMiningCarrier.ts`；部分装载、满载及原有来源隔离 |
| 23 | 旧 path/travel 状态只有最近一个 tick 仍请求移动时才阻止让路。 | `traffic.ts`；闲置旧路径与当前移动合同 |
| 24 | PB 中止解除 configName，所有认领入口都跳过回收单位。 | `powerBankHarvest.ts`；中止脱绑、同 bank 重发现不领养回收成员 |
| 25 | PB 运行时寿命余量使用 20 tick，准入余量继续保持 100 tick。 | PB 无 boost/损毁 ATTACK、HEAL 恢复时间与寿命不足撤回 |
| 26 | Portal 发现清理和跨 shard 选路均扣除快照年龄；没有可用 Portal 时撤销旧待孵化配置。 | `portalDiscovery.ts`、`crossShardColonization.ts`；过期、永久 Portal 及旧队列 |
| 27 | miner 在 link 满时转存邻近 Container 或放下溢出能量，恢复采矿阶段。 | `miner.ts`；满 link 回归 |
| 28 | 出生让路仅操作己方 Creep/PowerCreep。 | `mountSpawn.ts`；敌方 memory 为 undefined 不抛异常 |
| 29 | Invader Core 消失后，残留 Invader reservation 不再被当成玩家预定威胁。 | `remoteMining.ts`；保留玩家预定与高级 Core 原有威胁边界 |
| 30 | 新鲜 Deposit 观察可同时缩短或延长 expiresAt，终态仍不复活。 | `depositDiscovery.ts`；延长到期与终态保护 |
| 31 | PB 消失后只在看见掉落 Power 时补 hauler；失去视野时请求观察并保留已有队伍。 | `powerBankHarvest.ts`；bank 消失不生成无收益运输者 |
| 32 | 本房矿物成交后立即退出资源购买循环。 | 市场每房一笔成功动作回归 |
| 33 | 两类采购的 transferCost 均扣除 terminalEnergyReserve 后检查。 | 市场终端手续费底线回归 |
| 34 | HUB 工厂清理按实际选中的生产配方判断需保留的输入。 | 跳过已满足队首后仍保留下一配方输入 |
| 35 | 有污染清理任务时不再对同一份旧产物发布第二个卸货任务。 | 合成换产物时仅一个旧产物认领 |
| 36 | homeDefense 接入 boost 补给与采购，补齐能量；homeDefender 可消费强化；专用 lab 不被常规合成抢占。 | 防御入口、能量/矿物双补给、合成互斥回归；同 lab 同 tick 只接受一个强化意图，lab 无路可达时继续防御 |
| 37 | 搬运源房切换时空载成员回收；删除侦察旗只记录一次取消并清队列。 | `flagHauling.ts`、`scoutFlag.ts`；现有搬运生命周期与侦察取消回归 |

## 引擎规则复核

[官方引擎 StructureFactory.produce](https://github.com/screeps/engine/blob/master/src/game/structures.js) 要求非零配方等级相等，且对应 Operate Factory 效果存在。[官方 Creep 实现](https://github.com/screeps/engine/blob/master/src/game/creeps.js) 返回敌方 creep.memory 为 undefined；对其字段赋值会抛错。withdraw 同时排除 nuker、power bank 以及敌方私有 rampart 覆盖的建筑。公共 rampart 继续按引擎允许取货。

控制器已经被 attackController 命中后，upgradeBlocked 会阻止激活 safe mode；本次在相邻敌 CLAIM 出现时提前触发，避免声称能绕过引擎限制。

## 验证

所有构建、类型检查和 Jest 在 `dsh` 独立目录 `/root/codex-jobs/20261017-screeps-scan-01a145fb` 执行；本机只编辑、轻量静态检查和传输。构建明确清除 DEST，没有发布凭据传输。

| 检查 | 结果 |
| --- | --- |
| 基线反例 | 原始生产源码配合 4 个新回归断言，4 个问题均复现 |
| 最终双配置类型检查 | build/test 两个 TypeScript 配置均通过 |
| 无筛选完整 Jest | **266/266 套件、2025/2025 用例通过**；失败、跳过、待办均为 0 |
| 测试完整性校验 | `JEST_TEST_INTEGRITY=PASSED`；磁盘、Git 测试清单与 Jest 发现集合一致，运行前后输入指纹一致 |
| 构建 | 通过；明确使用 `env -u DEST npm run build`，没有发布 |
| 本地/服务器身份比对 | **623 个源码、测试、脚本与构建配置文件全部一致**，包含 67 个本次改动文件 |
| 本地空白检查 | `git diff --check` 通过 |

构建主文件 `dist/main.js`：3,447,548 字节；文件 SHA256：`66fa7fb5597fc1e661b3e376455b358c687799f2ba7472dd0c189e860b186e6f`。产物留在服务器隔离目录的 `repo/dist/`。

服务器 Git 提交 `7eb814a4bfb2da0682eb6745d38fd075f1c85b77` 是用于校验完整性的临时快照，未推送；不代表本地修复分支已经提交。实际测试、构建内容由源码文件哈希和完整性校验输入指纹绑定。本地修复代码尚未提交、未部署。

可复核证据：

- [最终验证摘要及全部源码哈希](2026-10-17-scan-fixes/validation-summary.json)、[本地身份复核](2026-10-17-scan-fixes/local-identity.json)。
- [完整性验收结论](2026-10-17-scan-fixes/full-final/verification.json)、[全部 Jest 用例结果](2026-10-17-scan-fixes/full-final/results.json)。
- [Jest 完整日志](2026-10-17-scan-fixes/full-final/jest.stderr.log)、[类型检查日志](2026-10-17-scan-fixes/typecheck-release.log)、[构建日志](2026-10-17-scan-fixes/build-final.log)。
- [基线反例结果](2026-10-17-scan-fixes/first-red.json)、[基线反例日志](2026-10-17-scan-fixes/first-red.log)、[末轮边界回归](2026-10-17-scan-fixes/last-boundaries.log)。
- [原始扫描报告](2026-10-17-scan-fixes/原始扫描.md)。

验证范围为离线 Screeps mocks、架构约束、类型检查与构建；没有线上 tick 验收或 CPU 收益测量。无观察能力的 PB 行军回退依赖已知所有权情报，对未知房间不承诺新鲜敌情保证；已知敌房继续避让。

新增的持久字段仅为跨 tick 搬运拒绝目标和核心防御伤害/衰减快照。配置新增 `resourceControl.market.creditReserve` 与 `energyShadowPrice`，旧配置使用明确默认值；声明指纹基线随真实 schema 变化更新，测试完整性检查规则未放宽。

# 2026-10-18 剩余扫描问题修复

扫描基线与本轮起点均为 `5ea0b54d`；本地修复分支为 `codex/scan-fixes-20261018`。扫描报告作为待核实的问题清单使用，不把其中的临时探针、推荐命令或操作建议当成用户授权。

本轮处理报告汇总的 11 项高优先级问题，并修复附录中的生命周期、补料、建设及主要重复扫描问题。离线修复与完整回归完成后，用户在本会话授权提交与部署，正式发布版本为 `2026.10.18-1`。下述服务器验证提交仅用于绑定离线输入；正式发布另从已同步 `origin/main` 的干净提交在服务器构建，完整模块回滚、上传读回及 shard1 执行验收证据保存在忽略目录 `monitor-data/scan-deploy-20261018/`，避免发布后文档提交让 main 与运行提交分离。

## 高优先级逐项对应

| 报告序号 | 修复后的行为 | 主要文件 / 回归 |
| --- | --- | --- |
| 1 | 战争不再以历史 `spawnedAt` / `spawnOnce.queuedAt` 作为投入证明；只认本任务当前代的现役、孵化、队列，或当前装配代已打开的 boost gate。controllerAttacker 不为搭档提供豁免，其自身只能完成已排定的一次。 | `outboundMissionPolicy`、`war/production.reserve`、`spawnPlanner` |
| 2 | 已建立殖民任务保留仍归己方且有 Spawn 的母房；短暂防御只暂停。目标房不参加源房选择；换源时清掉旧路线，孤立配置解绑并保留活体。 | `colonization`；母房防御 + 目标已有 Spawn 的反例 |
| 3 | RESERVE 下允许同源、已拥有目标房的殖民 bootstrapping/managed worker，以及现存救援任务的 worker；本房防御仍阻止新外派。 | `outboundMissionPolicy`；陌生前缀及防御反例 |
| 4 | 暂时 RESERVE / 防御只清支援矿工队列，保留身份；已部署矿工继续执行。失效策略、RCL6 停点和接班回收仍生效。 | `colonizationSupport`、`colonizerHarvester` |
| 5 | 核心清除后保留针对 Invader 预定的 reserver；执行 `attackController`，清零后改为 reserve。没有实际威胁时运输者可恢复。玩家预定仍受安全边界保护。 | `remoteMining`、`remoteMiningReserver`、`remoteMiningCarrier` |
| 6 | defending、suspended 等所有未 abandoned 外矿均计入每房上限。 | `remoteMining`；两个状态分别验证 |
| 7 | abandoned 冷却到期后重新评估邻房；冷却期间不重开。旧配置清理降为定期执行，保留活体引用。 | `remoteMining`；冷却前后回归 |
| 8 | boost 的矿物及能量需求扣除目标 Lab 的已接受在途货物；在途不再被当成库存消失。 | `carrierCargo`、`powerBankBoost` |
| 9 | boost 可行性按 Storage + Terminal 总现货计算；每轮搬一个来源，余量下一轮继续，不会错误要求外房供体。 | `powerBankBoost`；500 + 400 库存反例 |
| 10 | Spawn 始终可由普通 carrier 补能；Extension 仅在 PC 当帧实际提交有效补能意图后让位，并核对寿命、ops、冷却及房间。PC 可从库存取回 ops，Extension 优先于 Storage，Storage 效果接近结束才重放。 | `powerCreepControl`；ops 枯竭回归 |
| 11 | 无效 feed 先退原 Storage，再尝试本房 Terminal / Container；退货同步转移容量账本，保留原货物来源。移动超过 50 tick 或没有接收点时解除任务并安全清货，不永久抱货。 | `carrier`、`localCarrierDestinationCapacity`；原仓退回与满库暂存回归 |

## 附录问题对应

### Treasury / Terminal

| 原编号 | 本轮处理 |
| --- | --- |
| M1 | feed 身份移除可增长的 amount；同 ID、同创建时刻、同来源/路由/资源/原因的 merge 保留货物身份，数量仍由实时需求上限约束。 |
| M2 | 在途货物改用每 tick 的目的地索引；保留同 tick pickup / delivery intent 账本。旧 preload 板的唯一候选仍实时核验，不缓存可能变化的授权结论。 |
| M3 | 先匹配任务路由再检查连续 lane 所有权，普通任务不再各自扫描所有权任务库；现有不可变账本证明继续复用。 |
| M4 | 同一次采购候选检查共用一份快照与上下文；遇到与 amount 无关的失败立即退出。内存硬字节门仍实时序列化，不以旧 tick 或未跟踪同 tick 写入的结果代替授权检查；离散候选保留既有费用与许可边界。 |
| M5 | 全快照只对实际枚举的现货读取 Store，仍保留缺货资源的显式零键；extractor 使用 tickContext 的结构索引。Nuker 改为只抓 G。 |
| L1 | legacy GC 对空值、非法 expiresAt 判空；增加 `repairProductionReservations()`，只有原条目全部修正且整库校验通过才解除 corrupted 锁存，不自动删除责任。 |
| L2 | reservation adapter mode 移到聚合循环外。 |
| L3 | 同一 blocker 不重复 bump；ResourceControl 以任务值指纹判断实际变更后再使承诺索引失效。 |
| L4 | 临时缺失端点改为 pending + receiver_capacity blocker，保留操作者意图。 |
| L5 | 对端 payload 确实更新才刷新本地观测时刻，陈旧远端可自然到期。 |
| L6 | 每轮采购复用订单列表，支持达到最小成交量的小单；购买量扣除部分内部供给，同轮多房不重复花同一份订单量。 |
| L7 | 有处理器房间的 Power 导出保留 200 缓冲，减轻阈值附近来回调运。 |
| L8 | 自动平衡能量同时保留 Terminal 手续费底线。 |

### 工业

| 原编号 | 本轮处理 |
| --- | --- |
| M1 | 非 HUB 分解只检查下一批原料；总目标继续决定是否需要生产。 |
| M2 | 新 battery 解压请求向上对齐到 50；旧任务不足一批的尾数结束，缺来源的 loading 最多等待 500 tick。 |
| M3 | 跨房 G 规划改为每 25 tick 且只采 G；能量和 G 在途统计共用目的地索引。 |
| M4 | 过期的暂停观测仍按实际库存与压力判断；库存降到溢出线以下即可恢复，不要求市场重新写观测。 |
| M5 | Synthesis、boost、Nuker 及产物卸货共用在途索引，不再对每台 Lab 单独全扫 creep。 |
| L1 | 只强化尚未有 boost 的有效部件；准备身份/实验室缺失连续 100 tick 后解绑回收，不无期限等候，也不放行无强化出击。 |
| L2 | 取消无条件 suppressSpawnSupply。 |
| L3 | 为实际尚未完成、等级匹配的工厂目标调度 OPERATE_FACTORY，并避免效果仍有足够时长时重放。 |
| L4 | OPERATE_STORAGE 效果剩余大于 50 tick 时不重放。 |
| L5 | 跨房 reagent 需求扣除目标 Lab 在途。 |
| L6 | 同 Treasury L7。 |
| L7 | done / cancelled / failed 工厂任务保留 5000 tick 后定期清理。 |
| L8 | HUB upgrader 仅在确有 boost prep 时释放；内容相同的配置不反复重建。 |

### 殖民 / 跨 shard / 房间经济

| 原编号 | 本轮处理 |
| --- | --- |
| 殖民 M1 | 本 shard claim 前检查 GCL、敌方所有权和玩家预定，并记录 blockedReason；跨 shard 使用目标 shard 的房间摘要预检，claim 最多重试三轮。 |
| 殖民 M2 | 删除丢失房间的 claim/room 信号；必须在本次任务观察到对端推进后，才接纳与 payload 同时段的新鲜所有权/Spawn 信息。摘要上限从 24/32 提高到 512。新鲜信号确认失地时退回 claim 阶段。 |
| 殖民 M3 | 未实际出生的 bootstrap 队列因防御清除时立即复位派遣标记；已观察到出生或孵化的队伍保留等待。 |
| 殖民 M4 | Portal 评分计入出口到目标房距离；两段总距离超过 8 房或出口未知时不派 CLAIM。该距离是寿命预检，不能证明真实路线耗时。 |
| 殖民 M5 | 关键工地不再移除 RESERVE；worker 数量单独按关键建设需求计算。 |
| 殖民 M6 | RESERVE 下普通经济出生不为战争队首额外让能量。 |
| 殖民 L1–L4 | 现有 rescue 任务不因初建 Spawn 提前删旗；侦察最多等待 5000 tick，放弃会移除旗；去掉 claimer 每 tick 删队列再插队；空房 haul 收尾不重建配置。 |
| 殖民 L5–L6 | 母房防御不再取消 bootstrap 身份；已出发的跨 shard claimer 锁定源房和 Portal。rescue / flag haul 同样保留有效母房。 |
| 殖民 L7 | RESERVE 房集合、战争现役成员索引、按 shard 的远端解析均按 tick 复用；旗帜数量变化及自动旗移动会使缓存失效，队列和成员退役标记仍实时读取。 |
| 殖民 L8 | completed/failed 保留 5000 tick 后清理；长期 blocked 转 failed。重新插旗可重建终态任务。跨 shard bootstrap 沿用其明确派遣入口，未扩大普通出生豁免。 |
| 外矿 M1 | controller link 获得当前 RCL 的规划配额后不再重放临时 Container，避免拆除后的下一轮再次占位；Link 工地仍沿用既有施工 cadence。 |
| 外矿 M2 | 远端施工每 25 tick 执行；在途 cargo 与房间结构查询尽量使用共享索引。 |
| 外矿 M3 | 普通 Rampart 修理采用固定的 50k 阶梯，活跃任务只粘到该阶梯，随后重新选最低目标；紧急修理继续由塔负责。 |
| 外矿 M4 | 无效/冲突 HUB 旗仅提示并移除，不覆写在用 Hub 状态；有效旗合并保留现有 cfg/runtime 字段。 |
| 外矿 L1–L2 | Link 至少积累 400 能量再发，并登记同 tick 已占接收容量；Source Link 必须与采集工作位相邻且激活。工作位读取独立成模块以避免循环依赖。 |
| 外矿 L3 | 保留目标房内道路规划范围；这是现有规划边界，不把母房规划器另行接管的路段当作本轮缺陷。 |
| 外矿 L4–L5 | suspended 恢复同时检查主动威胁；容量不足两个 CLAIM 时不新增无净预定收益的 reserver。 |
| 外矿 L6–L7 | HUB upgrader 避免相同配置重写及无效 boost 释放；pickup 换目标主动释放旧 claim。 |

## 验证与边界

所有 TypeScript、Jest 与构建在 `dsh` 的 `/root/codex-jobs/20261018-screeps-scan/` 隔离目录执行。本机只编辑、静态查询和传输。服务器源自 `git archive 5ea0b54d`，没有传输 `.secret.json` 或部署凭据。构建显式清除 `DEST`。

- 原始生产源码 + 新反例：**12 条反例全部失败**，覆盖 11 项高优先级；该定向反例运行的其余用例未选择，不作为完整回归。
- 退货容量、战争豁免和出生调度：**5 套件 / 46 用例通过**。
- 早期非最终整套回归因后续源码已修正而主动中止；原日志与原因保留，不作为通过证据。随后完整一轮发现 6 个失败套件（7 条断言）；修正 RESERVE 同 tick 缓存失效、补足旧 Link mock，并让断言对应新的供能/规划/释放边界。修正后 7 套件 / 21 用例通过，再执行最终完整回归。

| 最终检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 生产 strict 与测试两份配置均通过 |
| 无筛选完整 Jest | **274 / 274 套件，2206 / 2206 用例通过**；失败、跳过、待办均为 0 |
| 测试完整性 | **JEST_TEST_INTEGRITY=PASSED**；磁盘、Git 与 Jest 发现清单一致，运行前后输入指纹一致 |
| 本机 / 服务器 | **1716 个源码、测试、脚本、配置及既有文档 / fixture 文件哈希全部一致** |
| `env -u DEST npm run build` | 通过，退出码 0；日志确认 Build only |
| 构建工作树 | 干净；服务器验证提交 `5a51cbe5a44c56186fc09694836fbcb4b40653cc` |
| 本机空白检查 | `git diff --check` 通过 |

本机、服务器及完整回归前后共同的 workspace SHA256：`88206cdda1c6c1b54a9407d4ded0c85be001b555836a92f45813b99c278db26d`。本说明文档在验收后填写，不计入上述 1716 项验证输入；其余输入逐文件一致。

构建产物保留在服务器 `review/dist/`。运行时 `main.js` 为 2,217,326 字节，映射模块 `main.js.map.js` 为 1,100,529 字节，合计 3,317,855 字节；离线 `.map` 另外保存。`main.js` 文件 SHA256：`0e6d2c2eec735bfc5e5516dcf087491d440e9a3bb2ec5a42e24cf35c5cd1079a`。这些是验证提交的产物，尚不是正式 main 发布产物。

可复核证据：

- [验证汇总与产物哈希](../../monitor-data/scan-fixes-20261018/evidence/validation-summary.json)、[全部本机输入哈希](../../monitor-data/scan-fixes-20261018/evidence/local-final-inputs.json)。
- [完整性结论](../../monitor-data/scan-fixes-20261018/evidence/full-final-4/verification.json)、[完整回归结果](../../monitor-data/scan-fixes-20261018/evidence/full-final-4/results.json)、[完整执行身份](../../monitor-data/scan-fixes-20261018/evidence/full-final-4/execution.json)。
- [类型检查日志](../../monitor-data/scan-fixes-20261018/evidence/typecheck-final-5.log)、[构建日志](../../monitor-data/scan-fixes-20261018/evidence/build-final-4.log)、[构建退出码](../../monitor-data/scan-fixes-20261018/evidence/build-final-4.exit)。
- [基线反例](../../monitor-data/scan-fixes-20261018/evidence/baseline-red.json)、[边界回归](../../monitor-data/scan-fixes-20261018/evidence/boundaries-final.json)、[关键建设期断言](../../monitor-data/scan-fixes-20261018/evidence/critical-reserve-final.log)、[原始扫描报告](../../monitor-data/scan-fixes-20261018/original-scan.md)。

完整原始日志保存在相同的本机忽略目录和服务器任务目录。早期失败、被替代候选与主动中止的结果同样保留；最终结论只采用 `full-final-4` 及其相同输入的构建。


引擎核对依据：[官方 Creep 实现](https://github.com/screeps/engine/blob/master/src/game/creeps.js)的 claim / attackController / reserveController 边界，以及[官方 API](https://docs.screeps.com/api/)。Invader 预定存在时不能直接 reserve，因此实现先清除预定再恢复 reserve。

离线 mocks、类型检查与构建不代表线上 tick 健康或 CPU 收益；此处记录离线验收边界；正式发布的线上验收以 `monitor-data/scan-deploy-20261018/` 证据为准。

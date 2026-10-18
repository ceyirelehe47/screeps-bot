# 分批实施记录

总范围仍是 tasks.md 的原 20 项及关联 A1–A20。表中的总项勾选必须等完整生产接入、反例验证和发布验收全部具备后再更新。

## 防御、调度和基础所有权

`161a3ceb` 完成防御阶段前置、真实预算调度、逐房故障隔离、任务准入 owner 注册、安全区矩阵层、配置退役与 GC 的首批边界。服务器对该提交的完整回归通过 282 个套件、2263 条用例。

首次发布后的实际 shard1 验收发现：Screeps 每 tick 重建 Game 对象，调度器误把对象身份变化当成 heap 重置，T3/T4 因此持续被延后。已按完整保存模块回滚到 `4791a060`；完整模块读回和实际执行身份均确认恢复。控制台无异常不能替代功能验收。

`68ae46f3` 修正了上述判断，增加每 tick 替换 Game 对象的反例；修正后需重新执行完整回归、发布和有界功能验收。原提交的首次发布不记为成功交付。

## 配置与出生请求所有权（2026.10.18-5）

- 配置服务拥有 set、patch、detachSpawn、remove 写入；嵌套参数、身体和 spawnOnce 不可直接修改。现有生产写入方已迁移，类型检查及 AST 边界测试防止绕过。
- 配置读索引按 revision 构建，提供房间、角色、名称及条目；同 tick 写后刷新，旧快照保持不变。出生规划使用索引，不再反复 list 或枚举兼容 store。
- spawnRequests 是孵化队列唯一写入者，前插、去重、替换、消费和拒绝均通过集中入口。拒绝保留明确原因。
- 成功 spawnCreep 的本 tick 收据补足引擎 spawning 尚未更新的窗口，供活体保护与战争续航查询使用。
- 出生执行通过注册 owner 调用任务校验和实际出生登记，mountSpawn 不再导入 Deposit 或 war 任务模块；战争队列索引跟随请求 revision 失效。
- `57dbd79d` 在服务器通过完整 285 套件、2273 条用例与两套类型检查。干净 main 与 origin/main 同步后在服务器构建，完整模块读回匹配；shard1 实际执行身份及 tick 完成证据一致。240 秒窗口收到 58 帧、错误为 0。只读索引与队列的线上读取证明保存在忽略证据目录。
- 此版本仍继承跨旧版回滚的历史健康缺口误记，下一批修复恢复选择逻辑；当前 tick 连续完成，历史记录不作新故障证据。

原 20 项中的统一寻路内核、MoveProfile、完整缓存层、小队、执行协议与交通、市场 revision、冷数据与事件队列等继续保留，不以本批改动替代。

## 寻路与缓存（候选版本 2026.10.18-6）

- 所有生产显式搜索统一到 pathSearch，移除原生 findPathTo 分支；每 tick 总 ops 额度与规划子额度独立，异常也先扣预算，规划不能耗光后续 creep 执行额度。
- MoveProfile 将完整性、maxOps、reusePath 和 partialTtl 拆开；已迁移 travelRange 和 requireCompletePath。预算等待不记静态断路，完整性要求不触发翻倍重试。
- 静态矩阵和 travel 派生矩阵共用容量、TTL、布局 revision 和 clone 所有权；源容器与出口封边共用实现。保留 warGeometry 的退路证明数据结构，不重复维护 PathFinder 静态矩阵。
- TowerDrain 允许稳定约束和三 tick 路径复用；身体、互疗连接、塔能量/补给、守军和几何变化换 key，缓存路径的下一步仍重新校验。
- 测试 findPathTo 与 PathFinder 共用单房 A*，保留预算、硬障碍、动态障碍、出口邻接等反例；夹具不模拟跨房引擎或真实 CPU。
- 独立健康恢复与旧 profiler 检查点取较新完成证据；旧缺口保存在 legacyGap，避免跨版本回滚产生虚假的新故障。硬终止若丢弃整帧且 heap 丢失，仍只能推断完成 tick 缺口，不能承诺精确还原阶段。
- 完整回归、正式构建与上线验收仍待执行，不以专项测试替代。

## 稳定错峰与相位观测（候选版本 2026.10.18-7）

- 周期规划、清理和遥测已迁移 isDue(key, every)。塔扫描保留原有房间相位，轮询选取改用 tickPhase；生产边界检查防止恢复裸 Game.time 取模。
- 运输执行器与读模型共用 key，合成规划同相以复用物流索引；CPU profiler 与 PB 诊断使用相同采样 key。独立任务的稳定哈希相位分散。
- CPU summary 提供最多 100 个相位桶的样本数、均值和最大值；不把未采样相位记成零。console 与遥测可读取；采样窗口不等同于连续全 tick 性能证明。
- 旧测试夹具迁移为明确的逻辑 tick 加稳定相位，保留执行点、非执行点、TTL、错相位和读取时钟反例。候选仍待完整回归和正式发布。

## 完整项证据归并

- 第 10、11 项：`57dbd79d` 的配置与出生请求生产迁移、revision 索引、类型/AST 边界、完整回归及 shard1 实际发布证据齐备，整项勾选；不是把部分实现算作完成。
- 第 19 项是已上线能力的重新取证，不是本轮新增收益：shard1 在 tick 74402242 运行 `57dbd79d`，permitChain 分段 schema=1、mode=segments、active epoch=1，segment 81/82/83 承载 JSON 813797 字节。逻辑 Memory 1724280 字符，RawMemory.get() 910355 字符（落盘读数与控制台属于相邻帧，不能逐字节相减当成本轮收益）。
- 现有 permitChainSegmentCodec、permitChainSegments 与 memoryStorage 套件覆盖校验、双 bank 未激活/下一 tick 读回、heap 重置恢复、预算与容量拒绝、投影失败保留内联数据。它们在 `57dbd79d` 的无过滤完整回归中通过；上线模块读回及实际执行证明也具备，因此第 19 项按既有实现完成验收。
- 最大逻辑分支 marketSaleAutomation 约 1.10 MB，其中 directAutomation 约 1.02 MB；已分段的 permitChain 仍在业务 Memory 中水合，不能把逻辑体积误判为 RawMemory 内联体积。creep Memory 约 17 KB，后续瘦身优先保证任务与货物恢复，不为了减少字段破坏生命周期。
- 其余复选项仍待整项生产证据；寻路/错峰候选与生命周期工作不会代替小队、执行协议/交通、市场等未完成项。

## 任务生命周期与退役（候选版本 2026.10.18-8）

- war、PB、Deposit、殖民/跨 shard、救援、外矿、殖民支援及 factory 的状态写入通过共同生命周期入口；合法状态由 owner 声明，转移统一记录时间及有界事件。资源运输 owner 的 patch/cancel 也登记转移并保留自动 revision bump，人工取消终态的既有 API 语义保留。
- 状态相同不重置阶段时间；副作用 entry 仅在全部完成后提交，失败可重试。已有 war entry 接入；其他终态清理保持各 owner 的幂等重试路径。
- 中央 GC 不再自行删除 war、rescue、Portal 或跨 shard 缓存，注册 owner 执行各自的删除规则。Rescue 母房消失先停止生产，活体与出生引用归零后再删除。
- 跨 shard 配置缺少 roomName 时采用实际 Spawn 房间准入；新 claimer 在 RESERVE 下不放行，已占领 bootstrap 按 owner 证据继续，防御仍阻止外出。Deposit 资格匹配 owner 当前合法整数世代，不硬编码 g0，旧代配置不借用。
- 共同退役入口迁移 war、PB、殖民与 workforce 编排；旧 _warRetireToRoom 迁移到 _recycleToRoom，保留角色参数。孵化中 suicide 请求保留到出生后，实际死亡前阻止继续业务，每个 actor 每 tick 最多提交一次。
- PB transfer 的 OK 只记录待确认收据，下一 tick 按 cargo 减少计数；同 tick 不重复提交。终态 owner 在 cargo 或 transfer 收据未结算时保留，配置停止补员，结算后更新最终历史。
- runtime.events 最多 128 条，TTL 5000；出生受理、死亡、退役和转移接入。只读消费者获得 sequence/cursor，容量淘汰、TTL 与 Memory 重置后的游标缺口明确返回 gap；这些事件是观察记录，不代替实时金融/出生授权。
- 19 套件、290 用例的生命周期接入检查通过；PB 货物、共同退役、bootstrap 与 mount 的 6 套件、61 用例通过。最终退役幂等与货物确认改动再次通过 5 套件、58 用例及两套类型检查。本候选仍须按确切提交执行完整回归、构建与发布验收。


## F：逐房隔离与调和门控（待验收）

- 普通逐房/逐任务执行隔离；核弹未知输入保留原任务和预约，停止发布部分全局需求；Power Spawn 失败保留旧搬运任务且暂停跨房分配；合成失败撤回 producer 完整性快照，保留运输与 generation。
- workforce 调和按配置/出生 revision、角色成员与到岗交接事实门控；成功后才记录，回退时间和周期刷新可恢复；矿工交接改为纯候选计算，由 workforce owner 集中退役。
- 规划、资源控制、合成、出生规划、塔防、Hub 与 boost 的 GC 规则回到各领域 owner；中央清理器只调度，不再读取任务数据和运行时子树。
- 尚在服务器专项、类型及反例验证阶段，不能计为完成或上线。

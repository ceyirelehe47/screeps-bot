# Empire Treasury Core Rewrite — Design（III 修订版）

日期：2026-09-05（Core Rewrite III 修订；II/I 版语义保留为本文件历史基线）。本文写现行实现事实；旧设计文档保留为历史（`../empire-treasury-rearchitecture/`）。III 修订性质：在 II 内核上完成边界修复——端到端授权一致性（同一份完整上下文贯穿接纳/执行/rearm/端口）、独立发布确认目标（写入载荷不充当自身证明）、观察接管闭环（已确认未入观察的效果由原聚合承担，世界序判定覆盖）、端口调用前预算预扣与子预算公平、完整值校验与逐槽空间预算——不是第二次净重写，不恢复旧多层证明体系。

## 1. 核心模型

一项未完成工作 = 一个有界活跃聚合（`Memory.runtime.treasuryCore.active`，键 = attemptId，上限 64）。只有该聚合内当前 attempt 的正向许可（heap-only dispatch permit）可以进入动作调用。历史明细（ring，上限 128）不授予任何权限。所有安全依赖关闭后工作退出活跃集合。

### 1.1 阶段状态机（kernel/commands.ts 纯转移）

```
pending ──dispatch_start──▶ dispatching ──dispatch_result──▶ closing(committed)
   │ │                          │                                │ beginTick 清理
   │ │                          └─recover(保守)─▶ outcome_unknown │
   │ │                                             │ settle      ▼
   │ │                                executed/not_executed    退出 + ring
   │ │                                             ▼
   │ │（cancel_pending：正面确认未开始；有义务→closing，无义务→退出+ring）
   │ └─跨 tick sweep（旧许可失效后按预算安全取消——§6.1）
   └─（不可从其他阶段回到 pending；只有 rearm 生成新 attempt）
                                             closing(not_executed)
                                                     │ 清理完成
                                                     ▼
                                                retry_ready ──期限/放弃──▶ 退出 + ring
                                                     │ executeRearm
                                                     ▼
                                              新 attempt（generation+1）
```

不变量（store 校验强制）：closing/retry_ready 必须有与 outcome 结论一致的证据；outcome=unknown 只出现在 pending/dispatching/outcome_unknown；**ring 与 active 的重叠/重复只产生 ringDegraded 诊断（非权威历史不可信，以 active 为准）**；active 内部的结构矛盾（相反证据/缺证据/发行不自洽）→ unhealthy 阻断。安全四态与 ring 层分离（§1.7）。

### 1.2 单一写入口与发布确认

一切持久变更经 `applyTreasuryCoreStateCommand`（commands.ts 纯转移）+ `writeTreasuryCoreMemory`（发布确认写协议，III 修订为角色分离）：

```
可信旧安全状态 baseline（clone）
→ 独立草稿 draft 上执行 mutate
→ 固定独立预期安全快照 expected（mutate 之后、写入之前深拷贝——
  与 draft/读回对象不共享任何可变嵌套引用）
→ draft 作为写入载荷交给存储边界
→ 读回当前状态与 expected 深度精确比较 + 安全校验
```

- **独立预期目标（R4/§5.1）**：写入边界若原地把载荷改写（如 dispatching→pending）并返回同一引用，读回 === draft 时与 draft 比较自身恒等——因此比较目标必须是 expected，不是载荷本身。初始化（initializeTreasuryCoreStore）与全部安全发布（接纳/结果/取消/清理/rearm/预算预扣/终态）使用同一契约。
- **基线漂移检查**：mutate 期间持久根被替换或修改（重入推进）→ 拒绝陈旧草稿覆盖。
- **条件回滚（§5.2）**：发布失败时仅当当前持久值仍属于本次失败发布（等于写入载荷、或写前存在而写后缺失——丢写所致）才恢复 baseline；已出现更新的合法安全推进时保留该事实、不覆盖、报告失败。无条件 rollback 会抹掉重入期间别人的合法推进。
- shape validation（合法形状）≠ publication acknowledgement（本次发布成功）。调用前发布失败 → 零调用、保持 pending（许可未消费，可重试或安全取消）；调用后结果发布失败 → 不回滚 pending、不恢复已用许可，保守 unknown 兜底。恢复、清理、取消、期限关闭没有旁路（架构测试守护 runtime importer 唯一性）。

### 1.3 受控 dispatch（三种事实分离）

```
许可校验（WeakSet 对象身份 + 冻结完整性 + tick + runtime generation
          + 许可与聚合完整身份逐项比对 + adapter 注册身份匹配）
→ dispatching 发布（持久 + 发布确认；失败 → 零调用、保持 pending）
→ permit 置 consumed（同 tick 重入/重复/多 facade 拒绝）
→ 动作恰好一次（adapter.execute，参数来自冻结签发快照）
→ invocation / external-accept / settlement 三种事实分别持久
```

- adapter 声明执行语义：`settlesOnAccept`（默认 false）、`nonOkOutcome`（默认 "unknown"）。
- 结果持久失败 → 保守兜底推进 outcome_unknown；endTick/beginTick 再尝试恢复。
- **事后结算只经受控对账端口**：`settleUnknownOutcome({attemptId})`——结论由内核经 `reconcileOutcome` 端口（facade 装配的注册 reconciler + 当前有效观察 + 持久 durable facts）得出；调用者不可传结论。`external_settlement_receipt` 自报通道已删除（类型与运行时均不存在）；跨 reset 的 reconciler 匹配标准 = kind + version + stable semanticIdentity（registrationId 含 global 内注册序号，不参与跨 reset 解释权）。

### 1.3a 最终执行门禁（facade.executeAuthorizedDispatch，III）

许可对象有效 ≠ 当前可执行。进入 kernel 调用边界之前依次复验（任一失败返回 `blocked`——动作调用 0、不消费许可、记录保持 pending）：

1. **共享授权窗口**：`lifecycle.lastEndTick === Game.time` → 阻断（持久共享事实——多实例/重复 beginTick 不得重开已关闭窗口；恢复与安全清理按预算继续，§1.8；下一 tick 正常入口开新窗口）。
2. **统一判定复验**：与接纳同一公式同一上下文（真实 contract 身份 + 许可携带的经验证 owner 快照），**排除本笔自身占用**（本笔 pending 是"既有责任继续兑现"，不自我双扣——其它 attempt/工作/owner 的责任全部保留）；policy 按当前注册与**当前业务值**重新计算（同注册下 reserve 收紧同样阻断，不只比对注册身份）。
3. **fresh 观察**：复验使用当前世界的 fresh 观察（beginFreshObservation，额度 8/tick，耗尽退回本 tick 缓存快照）——同 tick 内结构消失/重建必须被拦截。
4. **结构 incarnation**：签发时观察的结构绑定快照（permit.structureBindings）与当前观察逐一比对（位置存在且 structureId 一致）；观察不覆盖动作目标同样拒绝（接纳端口前置检查）。

### 1.4 身份与许可（签发快照封闭）

- attemptId：`tk1_<frontier>_<hash16>`，frontier 单调不回退；分配失败烧掉序号；溢出拒绝分配不回绕。
- 身份事实全集：actionKind / adapterVersion / adapterRegistrationId / adapterSemanticIdentity / canonicalDigest / postingsDigest / retryFactsDigest / durableFacts。任何字段冲突拒绝推进，原事实保留。
- **permit / rearm permit 是私有品牌对象 + WeakSet 注册 + 签发快照整体深冻结**：canonicalArgs、postings、经验证 ownerIdentity 快照与结构绑定快照（structureBindings）都是签发时的独立冻结副本（嵌套不可替换）；调用者对真许可的修改抛错（strict 赋值）或无效——不能执行 5000、不能换目标、不能延寿。实际执行参数与复验上下文都来自同一冻结签发（permit.postings / permit.ownerIdentity），不从公开可变字段重新派生。
- workKey（`biz:` 前缀）在活跃集合内排他。

### 1.5 Retry 与安全取消

- 只有 exact not-executed + 清理义务全部确认后才进入 retry_ready（期限 5,000 tick）。rearm 必须绑定同 retryFactsDigest、产生新 attemptId 与 generation+1；**rearm 与普通接纳使用同一授权事实口径（§1.6）——不继承前代余额或 policy 豁免**；失败不消费权利、不产生可执行 child。过期的是 retry 权利；执行未知的记录不能被 TTL 驱逐。
- **pending 安全取消（§6.1）**：`cancelPendingWork` 命令正面确认（phase=pending 且 invocation/external 均为空）后才取消；dispatching/unknown 不能被取消成未执行。有清理义务 → 进入 closing（pending_cancellation 证据），义务经既有幂等释放协议完成后直接退出（不生成 rearm 权利）；无义务 → 同一命令原子关闭（ring abandoned）。跨 tick 失效 pending 在后续 beginTick 按预算轮转取消（sweepCursor 游标；同 tick 接纳的不当作旧残留）。完整 reset 后旧许可一律无效——仍为 pending 的工作走同一取消路径；业务需要继续时走正常新授权（不实现许可复活/延期票据）。

### 1.6 统一授权事实口径（authorizationFacts.ts，III 修订）

**判定只此一份**：接纳、rearm、kernel 容量端口（checkAdmissionCapacity 携带完整上下文——真实 contractId/digest/actionKind 与经验证 owner，不存在匿名第二口径）与执行前复验（§1.3a）消费同一公式。共同事实：

- 有效观察（本 tick shared observation / 复验 fresh observation，含世界序锚点）；
- 现有资源运输承诺（pendingOutgoing 任务流出，房间级单份）；
- 合法生产 reservation（经验证的 exact owner 可排除自己的那一项；authorize options.owner / permit.ownerIdentity）；
- policy/withhold（resolver 缺失/抛错/非法 fail closed；**scope 合计累计口径**——见下）；
- 活跃聚合占用投影（pending/dispatching/unknown + **未被当前观察覆盖的已确认效果**：流出占存量、流入占接收容量）。

**Policy 累计（R1/§4.2）**：reserve 对 (resource, rooms scope) 有效。可供新工作使用的额度 = scope 合计观察 − scope 合计占用 − scope 合并业务承诺 − scope 合计生产预留 − 保留额；比较对象是**该资源候选流出的 scope 合计**（跨房间累计、同一候选多腿合并消费政策余量；共享池不按房间复制余额、范围级承诺只扣一次）。物理位置约束（per (room,loc,res) 流出 × 存量、per (room,loc) 流入 × 接收容量）与范围保留额约束同时成立。

**同一责任唯一扣减归属（III：观察接管闭环）**：

| 责任状态 | 表达通道 |
| --- | --- |
| pending / dispatching / outcome_unknown | kernel 占用（active 权威） |
| committed 且效果未被当前观察覆盖 | 同一 kernel 占用（原聚合继续承担——多实例/完整 reset 无责任空窗） |
| committed 且效果已被观察覆盖 | 该观察（数字已含效果，不再扣占用） |
| not_executed / pending_cancellation | 无责任 |

覆盖判定**优先用受控世界序**（§6 语义）：观察构建序 epoch.worldSequence > invocation.worldSequence（调用边界世界序）→ 受控世界已在调用后真实更新且该观察构建于其后 → 效果已进入该观察（同步生效模型下 fresh 观察包含本 tick 已发生效果，不与占用双扣）。世界序缺失（旧记录/未提供）回退 tick 边界保守判定（observedAtTick ≤ invocation.atTick → 占用）。世界序在审计全局根 `__treasuryWorldSequence`（私有槽）单调维护：同步 adapter 写世界 / 测试宿主施加效果时 +1；"时间过去了"或"净余额碰巧相等"不构成覆盖。实例本地 applied overlay 不参与授权判定（仅作 query projected 展示缓存——它不能是已确认效果的安全载体）。

- 持久腿（worstCase）分方向成腿：**同一资源键的流出与流入不互相抵消**（Σmax(0,−delta) 与 Σmax(0,+delta) 各一条）；对候选原始腿按流出合计查存量、按流入合计查接收容量（同 tick 多笔不得重复占满接收空间；unknown 与未覆盖 committed 的可能流入占接收容量、不成可花费资产）。
- 接纳/查询的宽松展示选项（projected/incoming）不授予可花费资产，与严格判定明确区分；query 的 authorizationSafe blockers 与接纳阻断同源（owner/承诺完整性/policy 可用性/存储健康/窗口/reservation 健康）。

### 1.7 存储健康（安全层与 ring 层分离）

- 安全四态：`absent` / `healthy` / `unhealthy`（安全层损坏——原数据保留、写入阻断）/ `incompatible`（未知版本）。旧 `Memory.runtime.treasury.*` 业务数据存在 → legacy_store_present 阻断。初始化显式（首次 admit）。
- **ring 层（非权威历史）独立诊断**：ring 超限/损坏/重复/与 active 重叠 → healthy + ringDegraded（有界诊断），不阻断健康安全权威的恢复/对账/收尾；查询只报告 degraded 不修复；下一次成功写入前重建（丢弃）ring 层。ring 声称的关闭事实不构成独立 settlement 证据。
- 对外健康视图（kernelJournal.health）只给状态与有界诊断，不暴露 memory 引用；active/ring/counters 返回独立深快照。

### 1.8 恢复调度（公平游标 + per-tick 预算 + 端口调用前预扣，III 修订）

- 每 tick 操作预算 8（恢复扫描/状态发布/外部清理调用共享；**同 tick 多次 beginTick / 多实例经持久记账 recovery.budgetTick/budgetUsed 共享同一份额**）。
- 游标（recovery.sweepCursor/cleanupCursor）是调度元信息：轮转保证前面的任务永久失败也让后续任务在有限轮次获得机会（active ≤ 64、预算 8/tick → 可完成项最多 8 轮内被访问）；进度跨 reset 延续；失效可安全重建，不是完成 proof。
- 清理逐消费者幂等释放（每次端口调用消耗预算，无论成败）；端口缺失/未确认/抛错 → duty 保留（无默认成功）。释放成功但确认写失败 → 保留原义务，之后仅通过同一幂等 (consumerKey, attemptId) 重试。


**端口调用前持久预扣（R6/§7.1，III）**：每次外部释放端口调用**之前**先持久发布 budgetUsed=used+1——预扣发布失败则不调用端口（零调用）；端口抛错/返回 false/确认写回失败时该份额已消耗（不退回供重入再花）；预扣后硬中断保守损失本 tick 这一次额度，下 tick 正常恢复。预算记账单调不回退（每次写从持久现读取 max——重入/多实例推高后的值不得被本地旧值覆盖）。同 tick 重复入口/多实例/端口内重入经持久记账共享同一份额（实测端口调用总计 ≤8）。

**子预算（§7.3，III）**：dispatching 恢复 ≤2、跨 tick pending sweep ≤3、retry 期限关闭 ≤1 → closing 清理保底 ≥2——持续到来的取消流量不能饿死健康清理。公平界（实测）：64 条 closing 在每 tick ≥2 次真实推进下 ≤32 tick 全部首次服务；义务总界 = 总义务次数 ÷ 8/tick。
## 2. 模块布局

```
src/runtime/treasury/
  kernel/           核心（types/store/identity/commands/occupancy/kernel）
  authorizationFacts.ts  统一授权事实判定（纯函数；查询/接纳/rearm/复验共用）
  facade.ts         薄装配层（查询侧签名保持 + 写侧新 API + cancelPendingWork）
  actionContracts.ts adapter 注册表 + contract 构建（执行入口已退役）
  observation/commitments/canonical*/transactionId/durableClone/durableSnapshot/
  ownerIdentity/holderResolution/commitmentRevision/policyAuthority/adapterRetrySemantics
  shadow.ts         只读影子对账（查询侧兼容）
  testHarness.ts    纯观察通道（测试专用，架构守护）
test/mock/treasuryResetHarness.ts  共享完整 reset harness（测试专用）
scripts/baseline-red/              基线缺陷重现脚本（R04；显式运行，不入默认收集）
```

外部生产依赖不变（runtimeServices/main/resourceReservation/resourceControl/nukerControl/productionMonitor/logistics）；`src/main.ts` 零改动。schema v2：recovery 调度区、pending_cancellation 证据、双向腿语义。

## 3. 写协议与对象替换语义

写协议为 clone-write-readback + 发布确认（§1.2）：每次写回替换根对象。内核/facade 每次操作重读健康视图（无缓存引用失联）；外部协作者不得缓存 store 引用（A20 记录）。本契约是运行时/模拟存储接口契约，不证明真实 Screeps driver 的 Memory 与副作用原子提交。

## 4. 已声明的限制（部署阻断条件）

1. **真实经济 writer 保持禁用**：生产 adapter 注册表为空（runtimeServices 只 seal）。接入真实 driver 前需要受控的 external settlement capability（本轮已删除自报通道——新通道必须同等受控）。
2. **持久化模型假设**：内核在"已发布持久状态保留、heap 全部丢失后恢复"模型下安全闭环；"效果保留而最新 Memory 回退"的非原子窗口未获真实 driver 证明——真实 driver 禁用是结论而不是待办。
3. 外部消费者释放端口的生产装配未接线（无真实消费者注册；测试经 kernel ports 注入验证）。**无端口时非空义务的接纳被拒绝**——不存在"接受义务后再接入"的路径。
4. treasuryPerf 仍由 shadow 低频写入（诊断）。
5. **世界序模型边界（III）**：观察覆盖的世界序判定在"全部同步生效（受控测试世界：adapter 写世界时 bump）"或"全部 tick 后生效（真实 driver：效果进世界时无人 bump，判定保守占用至聚合退出）"两种模型下分别正确；**混合模型**（同一系统内部分效果同步 bump、部分不 bump）中无关效果的 bump 会使未覆盖效果被误判已覆盖——接入真实 driver 时必须全系统统一模型，该边界已写入部署阻断条件。
6. **完整 reset 的跨模块语义（III）**：resetModules 后新 runtime 不认旧模块构建的 contract/许可（WeakSet/registry 印记随模块缓存消亡）——重建后的新工作必须经新模块构建（harness handles.actionContractsModule）；这不是缺陷而是跨 reset 信任边界的体现。

## 5. 容量与预算（III：逐槽完整生命周期上界）

总预算 = **360,000 个 JSON 序列化字符**（字符数为权威口径；UTF-8 bytes 另行计量）。推导方法为逐槽完整生命周期上界（store.ts：treasuryCoreSlotWorstChars / treasuryCoreRingSlotWorstChars / treasuryCoreMetaWorstChars，C22 断言）：

```
64 × 单活跃槽完整生命周期上限 + 128 × 单历史槽上限 + 根元信息 ≤ 360,000
```

- 受控字符集（IDENTIFIER_PATTERN：字母/数字/`_.:@-`；payload 可打印 ASCII 且无引号反斜杠）→ 这些字段 JSON 序列化**零转义膨胀**，上界可精确推导；自由文本字段（lastError ≤96）按最坏 6× 转义系数（\uXXXX）计入。
- 单槽上界覆盖**全部阶段同时取最坏**（worstCase 16 腿 + 8 消费者 + durable payload 512 + evidence + lastError 6×…）——不能"先接纳所有短 pending、等它们变成长 unknown/closing 时无空间可写"。
- 接纳前检查：当前序列化 + 新槽完整生命周期上界 + 新历史槽上界 ≤ 总预算；任何状态演化都不超过槽上界（字段硬上限 + 受控字符集），已接纳工作收尾始终有余量。
- 恢复预算：总量 8/tick（外部端口调用）+ 子预算分层（§1.8）；状态转移/持久发布/扫描另有有界上界（每命令一次安全发布 + 每端口调用一次预扣发布）。
- 压力实测：10,000 完成工作终态 < 32KB；1,000 代 retry 链；固定 unknown 混合负载；满载最坏形态 ≤ 总预算（C22）。

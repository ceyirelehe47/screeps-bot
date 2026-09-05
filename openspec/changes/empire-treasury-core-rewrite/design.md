# Empire Treasury Core Rewrite — Design（IV 修订版）

日期：2026-09-06（Core Rewrite IV 修订；III/II/I 版语义保留为本文件历史基线）。本文写现行实现事实；旧设计文档保留为历史（`../empire-treasury-rearchitecture/`）。III 修订性质：在 II 内核上完成边界修复——端到端授权一致性（同一份完整上下文贯穿接纳/执行/rearm/端口）、独立发布确认目标（写入载荷不充当自身证明）、观察接管闭环（已确认未入观察的效果由原聚合承担，世界序判定覆盖）、端口调用前预算预扣与子预算公平、完整值校验与逐槽空间预算——不是第二次净重写，不恢复旧多层证明体系。

IV 修订性质：保留单一活跃聚合内核，修实观察责任退出（完整关闭条件进入删除命令边界）、旧授权视图失效、fresh 不足阻断、承诺完整性进门禁、成对清理预算、真实剩余义务持久化、世界序持久域与构造器实测空间上界（R1–R7，evidence/core-rewrite-iv/）——不是净重写，不恢复任何旧 proof 体系。

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

### 1.1a committed 聚合的完整退出条件（IV/R1/§4.1）

closing(committed) 退出活跃集合**至少同时满足**（在执行删除的命令边界
成立，不是 occupancy helper 或测试前置里的事实）：

1. **确定执行结论**：outcome=committed 且证据结论一致（validator 强制）；
2. **效果被可信观察接管**：kernel 编排层经 ports.observeForCleanup（facade
   从共享观察装配）取得观察证明——时间序（观察构建世界序 > 效果锚点世界
   序；晚到 reconcile 记录的锚点回退 external.atTick）**且**范围（worstCase
   全部位置 `room\0loc` 在观察覆盖集合内——部分适用观察不判覆盖，D12）；
   证明是数据不是谓词——调用者无法自报"已覆盖"或伪造大序号；
3. **外部安全义务全部关闭**：cleanup.consumerKeys 为空（真实确认得出，
   §1.8），空集合本身被持久写回（IV/R5——否则 rearm 复制旧集合）；
4. **删除发布成功**：同一发布确认写协议。

观察未覆盖（无观察端口/时间序未到/范围缺失）→ **不退出**：写回真实剩余
义务（可为空集合），必要资源与接收容量责任继续由原聚合承担（occupancy
投影不变）；重复 beginTick/endTick/cleanup 零写跳过（不花预算、不靠
ring/时间消除，D01）。not_executed 与安全 pending 取消**没有**"等待世界
效果"的义务——它们按剩余消费者与 retry 规则退出或进 retry_ready。

**世界序持久域（IV/R7/§4.3）**：受控世界序权威在
`Memory.runtime.treasuryWorldSequence`（单一安全整数，受控世界真实更新时
+1，bump 单字段直写——丢一次只落保守方向）。比较域 = Memory 持久域：
正常 tick / global 重建 / 完整 reset（heap 全清、Memory 保留）序号连续，
观察覆盖判定照常成立（D09：新运行时从新可信观察完成接管，不双扣、不
永久扣留）；整份 Memory 丢失时记录随之丢失，不存在需要判定的锚点（旧
备份回滚仍是未验证边界）。III 的 global 槽方案（`__treasuryWorldSequence`）
已退役——global 侧计数 reset 后归零，与 Memory 内旧记录的
invocation.worldSequence 跨域不可比（要么永久扣留、要么凭无关序号误判
覆盖）。

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

### 1.3b 执行/授权门禁的 IV 修订（fresh 不足、完整性、视图时效）

- **fresh 耗尽即阻断（IV/R2/§5.1）**：执行前复验要求**当前世界的 fresh
  观察**（额度 8/tick）；额度耗尽或构建失败返回结构化阻断
  `observation_unavailable`——动作调用 0、许可不消费、记录保持 pending
  （可安全取消）。**不存在"退回本 tick 缓存快照"的安全回退**（旧快照的
  结构 incarnation 与金额事实可能已过期）。下一 tick 或 fresh 可用时合法
  工作恢复可执行（D04 对照）。不增加 fresh 额度、不新建观察订阅。
- **完整性进所有真实门禁（IV/R3/§5.2）**：共同授权判定在数值检查之前
  消费承诺完整性——候选腿涉及的任何 (room, resource) scope incomplete
  （含 global incomplete 传导）→ authorize / dispatch 复验 / rearm 一致
  阻断（`commitment_incomplete`），与 query 的 blockers 同源；跳过坏记录
  后的剩余数值不构成完整账目。共同就绪门禁（commonReadinessGate）同时
  覆盖共享 reservation 迁移/健康状态。承诺索引按 revision 失效缓存。
- **观察视图时效（IV/R1 后半/§4.2）**：授权观察不得早于最新受控世界序
  ——ensureTickState 发现 `epoch.worldSequence < 持久世界序` 即重建观察
  （仅替换观察与承诺索引缓存，不重置 fresh 额度与许可审计——防借重建刷
  额度）。效果发生后持旧观察的实例在任何安全入口被强制刷新：聚合退出与
  旧视图失效组成同一安全边界（D02：A 执行 800 并退出后，旧观察实例的
  800 被新观察物理余额拒绝、200 有正当对照获准）。多实例共享同一 Memory
  持久事实（不按根对象引用分家）。

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

覆盖判定**优先用受控世界序**（§1.1a 持久域，IV 修订）：观察构建序 epoch.worldSequence > 效果锚点世界序（invocation.worldSequence；晚到 reconcile 记录无 invocation 时锚点回退 external.atTick 的 tick 边界）→ 效果已进入该观察（同步生效模型下不与占用双扣）。世界序缺失（旧记录/未提供）回退 tick 边界保守判定（观察 atTick ≤ 效果时点 → 占用）。世界序权威在 `Memory.runtime.treasuryWorldSequence`（IV：global 槽退役——跨 heap reset 连续，§1.1a）；“时间过去了”、“净余额碰巧相等”或“无关源序号变大”都不构成覆盖（D10/D12）。实例本地 applied overlay 不参与授权判定（仅作 query projected 展示缓存——它不能是已确认效果的安全载体）。

- 持久腿（worstCase）分方向成腿：**同一资源键的流出与流入不互相抵消**（Σmax(0,−delta) 与 Σmax(0,+delta) 各一条）；对候选原始腿按流出合计查存量、按流入合计查接收容量（同 tick 多笔不得重复占满接收空间；unknown 与未覆盖 committed 的可能流入占接收容量、不成可花费资产）。
- 接纳/查询的宽松展示选项（projected/incoming）不授予可花费资产，与严格判定明确区分；query 的 authorizationSafe blockers 与接纳阻断同源（owner/承诺完整性/policy 可用性/存储健康/窗口/reservation 健康）。

### 1.7 存储健康（安全层与 ring 层分离）

- 安全四态：`absent` / `healthy` / `unhealthy`（安全层损坏——原数据保留、写入阻断）/ `incompatible`（未知版本）。旧 `Memory.runtime.treasury.*` 业务数据存在 → legacy_store_present 阻断。初始化显式（首次 admit）。
- **ring 层（非权威历史）独立诊断**：ring 超限/损坏/重复/与 active 重叠 → healthy + ringDegraded（有界诊断），不阻断健康安全权威的恢复/对账/收尾；查询只报告 degraded 不修复；下一次成功写入前重建（丢弃）ring 层。ring 声称的关闭事实不构成独立 settlement 证据。
- 对外健康视图（kernelJournal.health）只给状态与有界诊断，不暴露 memory 引用；active/ring/counters 返回独立深快照。

### 1.8 恢复调度（公平游标 + per-tick 预算 + 端口调用前预扣，III 修订）

- 每 tick 操作预算 8（恢复扫描/状态发布/外部清理调用共享；**同 tick 多次 beginTick / 多实例经持久记账 recovery.budgetTick/budgetUsed 共享同一份额**）。
- 游标（recovery.sweepCursor/cleanupCursor）是调度元信息：轮转保证前面的任务永久失败也让后续任务在有限轮次获得机会（active ≤ 64、预算 8/tick → 可完成项最多 8 轮内被访问）；进度跨 reset 延续；失效可安全重建，不是完成 proof。
- 清理逐消费者幂等释放；端口缺失/未确认/抛错 → duty 保留（无默认成功）。释放成功但确认写失败 → 保留原义务，之后仅通过同一幂等 (consumerKey, attemptId) 重试（义务不跨 attempt 迁移，D16/D18）。
- **真实剩余义务始终持久化（IV/R5/§6.3）**：advance_cleanup 无论剩余非空还是为空都写回真实 remaining——进入 retry_ready 时 consumerKeys 必须持久为空；validator 强制 retry_ready ⇒ not_executed + 空义务 + 证据一致（矛盾状态在安全读取/命令边界拒绝、不自动清空，D20）；rearm 的 child 不继承父代义务（不存在 child 义务发行系统）。

**成对预算（IV/R4/§6.1–§6.2）**：每消费者单位 = “端口调用 + 对应确认命令”，进入外部端口前**持久预扣完整 2 份**（prepayReleaseUnitBudget：usedNow+2 ≤ 8 才可调用）；确认命令（成功确认、失败诊断——诊断就是本单位的确认命令）使用已预扣份额（applyPrepaidCleanupCommand 记账不递增）。总量仍 8/tick：无其他阶段消耗时一 tick 最多 4 个消费者单位、外部调用 ≤8 保持；8 义务记录两 tick 完成全部调用与确认、至多 3 个完整预算 tick 终态（D13）。预扣发布失败 → 调用 0；预扣后无论 true/false/throw/确认写失败份额不退回；硬中断保守损失该 2 份，下 tick 恢复。无外部消费者的安全状态推进仍按单命令份额（+1）。预算记账单调不回退（每次从持久现读 max）；同 tick 重复入口/多实例/端口内重入共享同一持久记账。

**公平游标的 IV 修订（D19）**：预算耗尽时清理循环**立即 break**（游标停在耗尽处，下一 tick 从其后记录开始）——continue 空转会推满一圈回到本 tick 起点，后方记录永远落在“预算已尽”访问位（结构性饿死）；§6.2 额度耗尽后廉价返回，不无限扫描。失败记录每条 2 份（成对单位）；子预算：dispatching 恢复 ≤2、sweep ≤3、retry 关闭 ≤1 → 清理保底 ≥2（≥1 个成对单位/tick）。实测（D19）：8 条永久失败（各 1 义务）+ 1 条 8 义务可完成 + 每 tick 新 pending 噪声，12 tick 内完成；64 条 closing 全部首次服务 ≤32 tick（III 界保持）。
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
5. **世界序模型边界（III；IV 修订比较域）**：世界序判定在“全部同步生效（受控测试世界：adapter 写世界时 bump 持久序）”或“全部 tick 后生效（真实 driver：无人 bump，判定保守占用至聚合退出）”两种模型下分别正确；**混合模型不支持**——接入真实 driver 时全系统统一模型（部署阻断条件）。IV 起比较域 = Memory 持久域（`Memory.runtime.treasuryWorldSequence`）：跨 heap reset 序号连续、判定照常（D09）；旧备份回滚/整份 Memory 丢失仍是未验证边界。
6. **完整 reset 的跨模块语义（III；IV 补充）**：resetModules 后新 runtime 不认旧模块构建的 contract/许可（WeakSet/registry 印记随模块缓存消亡）——重建后的新工作必须经新模块构建（harness handles.actionContractsModule）。IV 补充：完整 reset 清空全部 Treasury 运行时 global（含已退役世界序槽），宿主世界数值、外部接受记录、执行/释放轨迹独立保留——两类数据不得混淆。

## 5. 容量与预算（IV：构造器实测法上界）

总预算 = **360,000 个 JSON 序列化字符**（字符数为权威口径；UTF-8 bytes 另行计量，受控字符集下二者相等）。IV 修订推导方法（R6：III 手写公式系统性低估——字段键名两侧引号每处漏 2、数字按 13 位计而 validator 允许 16 位安全整数（负 delta 17 位）、漏计 invocation.worldSequence，按公式常量修正重算 ≈373,226 反超总预算）：**构造完整最坏合法记录（全部字段取 validator 允许极值）→ 真实 JSON.stringify 实测长度即上界**（store.ts：buildTreasuryCoreWorstWorkRecord / buildTreasuryCoreWorstRingEntry / treasuryCoreSlotWorstChars 等；D21/D22 断言）。上界本身就是一次真实序列化——键引号/冒号/逗号/括号/active 键/数字位宽全部按实际表示计入，不存在推导与实际表示漂移。

```
64 × 单活跃槽完整生命周期上界 + 128 × 单历史槽上界 + 根元信息 ≤ 360,000（构造器实测合计 ~343,500）
```

- 为使极值记录合法且总预算成立，validator 真实强制收紧（不是估算口径）：worstCase 腿数 16 → **12**、generation ≤ **9,999**、adapterVersion ≤ **9,999**；其余数字字段允许至 MAX_SAFE_INTEGER（16 位；带符号 delta 17 位）按实测计入。
- 受控字符集字段零转义膨胀；自由文本（lastError ≤96）按真实转义（每控制字符 6 倍）实测计入；超界 payload 整体拒绝、无 slice 截断后接受（安全事实不能被截成另一份事实，D21）。
- 单槽上界覆盖全部阶段同时取最坏（closing+not_executed+evidence+worstCase+invocation 含 worldSequence+8 消费者+最坏转义 lastError）——不能“先接纳短 pending、演化成长记录时无空间可写”。
- 接纳前检查：当前序列化 + 新槽完整生命周期上界 + 新历史槽上界 ≤ 总预算；已接纳工作收尾始终有余量（D22 真实接纳满载实测）。
- 恢复预算：总量 8/tick、成对单位 2 份（§1.8）；状态转移/持久发布/扫描有界（每命令一次安全发布 + 每单位一次预扣发布）。
- 压力实测（D23）：批量完成 + 合法 retry + 固定 unknown 混合，世界轨迹与独立参考模型一致；ring 淘汰不授予旧 ID 许可；全 heap reset 后接管退出、无重复调用。

# Empire Treasury Core Rewrite — Design（II 修订版）

日期：2026-09-05（Core Rewrite II 修订；I 版语义保留为本文件基线）。本文写现行实现事实；旧设计文档保留为历史（`../empire-treasury-rearchitecture/`）。II 修订性质：保留 I 的新内核，修实其基本边界（许可封闭、统一授权口径、生命周期闭合）——不是第二次净重写。

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

一切持久变更经 `applyTreasuryCoreStateCommand`（commands.ts 纯转移）+ `writeTreasuryCoreMemory`（发布确认写协议）：

1. 快照基线（clone）→ 在草稿上执行 mutate；
2. **基线漂移检查**：写入前 Memory 当前值必须与基线一致（重入导致目标基线变化时拒绝陈旧草稿覆盖已推进状态）；
3. 写入（根对象整体替换）；
4. **读回与草稿深度精确比较 + 安全校验**：读回是另一份合法旧值 / 单安全字段未更新 / 写被丢弃 / 安全层损坏一律视为失败并回滚。

shape validation（合法形状）≠ publication acknowledgement（本次发布成功）。调用前发布失败 → 零调用、保持 pending；调用后结果发布失败 → 不回滚 pending、不恢复已用许可，保守 unknown 兜底。恢复、清理、取消、期限关闭没有旁路（架构测试守护 runtime importer 唯一性）。

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

### 1.4 身份与许可（签发快照封闭）

- attemptId：`tk1_<frontier>_<hash16>`，frontier 单调不回退；分配失败烧掉序号；溢出拒绝分配不回绕。
- 身份事实全集：actionKind / adapterVersion / adapterRegistrationId / adapterSemanticIdentity / canonicalDigest / postingsDigest / retryFactsDigest / durableFacts。任何字段冲突拒绝推进，原事实保留。
- **permit / rearm permit 是私有品牌对象 + WeakSet 注册 + 签发快照整体深冻结**：canonicalArgs 与 postings 是签发时的独立冻结副本（嵌套不可替换）；调用者对真许可的修改抛错（strict 赋值）或无效——不能执行 5000、不能换目标、不能延寿。实际执行参数与 overlay 结算都来自同一冻结签发（permit.postings），不从公开可变字段重新派生。
- workKey（`biz:` 前缀）在活跃集合内排他。

### 1.5 Retry 与安全取消

- 只有 exact not-executed + 清理义务全部确认后才进入 retry_ready（期限 5,000 tick）。rearm 必须绑定同 retryFactsDigest、产生新 attemptId 与 generation+1；**rearm 与普通接纳使用同一授权事实口径（§1.6）——不继承前代余额或 policy 豁免**；失败不消费权利、不产生可执行 child。过期的是 retry 权利；执行未知的记录不能被 TTL 驱逐。
- **pending 安全取消（§6.1）**：`cancelPendingWork` 命令正面确认（phase=pending 且 invocation/external 均为空）后才取消；dispatching/unknown 不能被取消成未执行。有清理义务 → 进入 closing（pending_cancellation 证据），义务经既有幂等释放协议完成后直接退出（不生成 rearm 权利）；无义务 → 同一命令原子关闭（ring abandoned）。跨 tick 失效 pending 在后续 beginTick 按预算轮转取消（sweepCursor 游标；同 tick 接纳的不当作旧残留）。完整 reset 后旧许可一律无效——仍为 pending 的工作走同一取消路径；业务需要继续时走正常新授权（不实现许可复活/延期票据）。

### 1.6 统一授权事实口径（authorizationFacts.ts）

查询严格可授权结果、普通接纳、rearm、执行前复验共用同一判定。共同事实：

- 有效观察（本 tick shared observation）；
- 本 tick 已确定变化（applied overlay——已发生的世界效果）；
- 现有资源运输承诺（pendingOutgoing 任务流出）；
- 合法生产 reservation（经验证的 exact owner 可排除自己的那一项；authorize options.owner）；
- policy/withhold（resolver 缺失/抛错/非法 fail closed）；
- 活动 pending/dispatching/unknown 风险（kernel 占用投影：流出占存量、流入占接收容量）。

**同一责任唯一扣减归属**（tentative overlay 已删除——admit 后 active 记录即同 tick 扣减权威）：

| 责任状态 | 表达通道 |
| --- | --- |
| pending / dispatching / outcome_unknown | kernel 占用（active 权威） |
| committed（dispatch 时刻确认） | 本 tick applied overlay → 跨 tick 刷新观察 |
| committed（reconcile 确认，观察边界不明） | 保守保持占用至聚合退出 |
| not_executed | 无责任 |

- 持久腿（worstCase）分方向成腿：**同一资源键的流出与流入不互相抵消**（Σmax(0,−delta) 与 Σmax(0,+delta) 各一条）；对候选原始腿按流出合计查存量、按流入合计查接收容量（同 tick 多笔不得重复占满接收空间；unknown 的可能流入占接收容量、不成可花费资产）。
- 接纳/查询的宽松展示选项（projected/incoming）不授予可花费资产，与严格判定明确区分。

### 1.7 存储健康（安全层与 ring 层分离）

- 安全四态：`absent` / `healthy` / `unhealthy`（安全层损坏——原数据保留、写入阻断）/ `incompatible`（未知版本）。旧 `Memory.runtime.treasury.*` 业务数据存在 → legacy_store_present 阻断。初始化显式（首次 admit）。
- **ring 层（非权威历史）独立诊断**：ring 超限/损坏/重复/与 active 重叠 → healthy + ringDegraded（有界诊断），不阻断健康安全权威的恢复/对账/收尾；查询只报告 degraded 不修复；下一次成功写入前重建（丢弃）ring 层。ring 声称的关闭事实不构成独立 settlement 证据。
- 对外健康视图（kernelJournal.health）只给状态与有界诊断，不暴露 memory 引用；active/ring/counters 返回独立深快照。

### 1.8 恢复调度（公平游标 + per-tick 预算）

- 每 tick 操作预算 8（恢复扫描/状态发布/外部清理调用共享；**同 tick 多次 beginTick / 多实例经持久记账 recovery.budgetTick/budgetUsed 共享同一份额**）。
- 游标（recovery.sweepCursor/cleanupCursor）是调度元信息：轮转保证前面的任务永久失败也让后续任务在有限轮次获得机会（active ≤ 64、预算 8/tick → 可完成项最多 8 轮内被访问）；进度跨 reset 延续；失效可安全重建，不是完成 proof。
- 清理逐消费者幂等释放（每次端口调用消耗预算，无论成败）；端口缺失/未确认/抛错 → duty 保留（无默认成功）。释放成功但确认写失败 → 保留原义务，之后仅通过同一幂等 (consumerKey, attemptId) 重试。

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

## 5. 容量与预算（精确推导）

字段上限：worstCase ≤16 腿、consumerKeys ≤8×128 字符、durablePayload ≤512、lastError ≤192、evidence source ≤64、未知字段拒绝（顶层/嵌套）、计数器饱和 9,999,999,999。

最坏序列化推导（字符数 = JSON.stringify 长度，受控 ASCII 布局下同 UTF-8 bytes）：最坏单记录 4,776 + ring 条目 262 + 根骨架 550 → 64 active + 128 ring 满载合计 **339,813**；集中常量 `TREASURY_CORE_TOTAL_CHAR_BUDGET = 360,000`（≈6% 余量）。接纳前校验：当前序列化 + 新聚合最坏估算超预算即拒绝（新工作阻断，已接纳工作收尾不受影响——单记录最坏从 admit 起固定）。恢复预算 8 操作/tick（§1.8）。canonical args 上限沿用 canonical encoding（深度 16 / 文本 4,096 / 数组 256 / 键 64）。

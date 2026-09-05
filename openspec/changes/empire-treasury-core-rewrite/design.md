# Empire Treasury Core Rewrite I — Design

日期：2026-09-05。本文写现行实现事实；旧设计文档保留为历史（`../empire-treasury-rearchitecture/`），两个目录不同时宣称自己是当前实现规范。

## 1. 核心模型

一项未完成工作 = 一个有界活跃聚合（`Memory.runtime.treasuryCore.active`，键 = attemptId，上限 64）。只有该聚合内当前 attempt 的正向许可（heap-only dispatch permit）可以进入动作调用。历史明细（ring，上限 128）不授予任何权限。所有安全依赖关闭后工作退出活跃集合。

### 1.1 阶段状态机（kernel/commands.ts 纯转移）

```
pending ──dispatch_start──▶ dispatching ──dispatch_result──▶ closing(committed)
   │                            │                                │ beginTick 清理
   │                            └─recover(保守)─▶ outcome_unknown │
   │                                                 │ settle     ▼
   │                                     executed/not_executed   退出 + ring
   │                                                 ▼
   └─（不可从其他阶段回到 pending；只有 rearm 生成新 attempt）
                                             closing(not_executed)
                                                     │ 清理完成
                                                     ▼
                                                retry_ready ──期限/放弃──▶ 退出 + ring
                                                     │ executeRearm
                                                     ▼
                                              新 attempt（generation+1）
```

不变量（store 校验强制）：closing/retry_ready 必须有与 outcome 结论一致的证据；outcome=unknown 只出现在 pending/dispatching/outcome_unknown；同一 attemptId 不得同时存在于 active 与 ring；ring 内 attemptId 唯一。结构矛盾 → unhealthy，阻断一切写入，原数据保留。

### 1.2 单一写入口

一切持久变更经 `applyTreasuryCoreStateCommand`（commands.ts 纯转移函数）+ `writeTreasuryCoreMemory`（clone → 写 → 读回验证 → 失败回滚）。恢复、清理、期限关闭没有旁路（架构测试守护 runtime importer 唯一性）。

### 1.3 受控 dispatch（三种事实分离）

```
许可校验（WeakSet 对象身份 + tick + runtime generation + 身份匹配 + adapter 注册身份匹配）
→ dispatching 发布（持久 + 读回；失败 → 零调用、保持 pending）
→ permit 置 consumed（同 tick 重入/重复拒绝）
→ 动作恰好一次（adapter.execute）
→ invocation / external-accept / settlement 三种事实分别持久
```

- adapter 声明执行语义：`settlesOnAccept`（默认 false——接受不构成无条件完成证明）、`nonOkOutcome`（默认 "unknown"——不凭失败状态释放风险）。
- 结果持久失败 → 保守兜底推进 outcome_unknown；endTick/beginTick 再尝试恢复。
- 事后结算 `settleUnknownOutcome`：adapter_reconcile 结论由 facade 调用注册 reconciler 得出（调用方不可传，防伪造）；external_settlement_receipt 为显式外部通道（本轮真实 driver 禁用）。

### 1.4 身份与许可

- attemptId：`tk1_<frontier>_<hash16>`，frontier 单调不回退；分配失败烧掉序号（burned 计数），不为洞建永久记录；溢出（>9,999,999,999）拒绝分配不回绕。
- 身份事实全集：actionKind / adapterVersion / adapterRegistrationId / adapterSemanticIdentity / canonicalDigest / postingsDigest / retryFactsDigest / durableFacts。任何字段冲突拒绝推进，原事实保留。
- permit / rearm permit 是私有品牌对象 + WeakSet 注册；跨 tick、跨 runtime generation、非签发对象一律无效。
- workKey（`biz:` 前缀）在活跃集合内排他——同一业务任务不存在两个可能执行的当前 attempt。

### 1.5 Retry

只有 exact not-executed + 清理义务全部确认后才进入 retry_ready（期限 5,000 tick）。rearm 必须绑定同 retryFactsDigest（改变动作参数/adapter 语义的 retry 拒绝）、产生新 attemptId 与 generation+1、消费后旧许可失效。过期的是 retry 权利；执行未知的记录不能被 TTL 驱逐。

### 1.6 资源与容量

- 持久腿（worstCase）为带符号 canonical posting 腿（同键合并、零腿剔除）：流出腿（负）参与存量占用，流入腿（正）参与接收容量检查，reconciler 获得完整事实。
- 占用规则：pending / dispatching / outcome_unknown / closing(committed) 保持占用；closing(not_executed) / retry_ready 不占用。占用是活跃集合成员资格的投影（occupancy.ts 派生，无第二权威）。
- 接纳检查（facade）：物理观察 − 本 tick tentative/已发生 overlay − kernel 活跃占用 ≥ 流出；正流入 ≤ 接收位置剩余容量；policy resolver 的 withhold+strategicReserve 参与额度（resolver 缺失/抛错/非法决策 fail closed）。

### 1.7 存储四态与健康

`absent`（从未初始化——查询零写返回空视图）/ `healthy` / `unhealthy`（损坏——原数据保留、写入阻断）/ `incompatible`（未知版本）。旧 `Memory.runtime.treasury.*` 业务数据存在 → 内核报告 legacy_store_present 并阻断写入（不解析、不擦除、不迁移）。初始化是显式操作（首次 admit 触发）。

## 2. 模块布局

```
src/runtime/treasury/
  kernel/           新核心（types/store/identity/commands/occupancy/kernel）
  facade.ts         薄装配层（查询侧签名保持 + 写侧新 API）
  actionContracts.ts adapter 注册表 + contract 构建（执行入口已退役）
  observation/commitments/canonical*/transactionId/durableClone/durableSnapshot/
  ownerIdentity/holderResolution/commitmentRevision/policyAuthority/adapterRetrySemantics
  shadow.ts         只读影子对账（查询侧兼容）
  testHarness.ts    纯观察通道（测试专用，架构守护）
```

删除 165 个旧协议文件（清单见 authority-retirement-map.md）。外部生产依赖全部落在保留模块（runtimeServices/main/resourceReservation/resourceControl/nukerControl/productionMonitor/logistics），`src/main.ts` 零改动。

## 3. 写后读回与对象替换语义

写协议为 clone-write-readback：每次写回替换 `Memory.runtime.treasuryCore` 根对象。内核/facade 每次操作都重读健康视图（无缓存引用失联）；**外部协作者不得缓存 store 引用**（A20 测试记录了该约束）。

## 4. 已声明的限制（部署阻断条件）

1. **真实经济 writer 保持禁用**：生产 adapter 注册表为空（runtimeServices 只 seal）。接入真实 driver 前，external_settlement_receipt 通道必须升级为受控 capability。
2. **持久化模型假设**：内核在"已发布持久状态保留、heap 全部丢失后恢复"模型下安全闭环；"效果保留而最新 Memory 回退"的非原子窗口未获真实 Screeps driver 证明——本模型下跨 tick 重发不能被排除，因此真实 driver 禁用是结论而不是待办。
3. external consumer 释放端口已接线的语义是幂等确认（本轮无真实消费者注册；测试经 kernel ports 注入验证）。
4. treasuryPerf 仍由 shadow 低频写入（诊断）。

## 5. 容量与预算

活跃 64 × 最坏记录（16 腿 + 192 错误 + 512 durable payload + consumer keys）+ ring 128 + 元信息。压力实测：10,000 完成工作终态 < 32KB；满载最坏形态 < 260KB（测试上界断言）。恢复预算 8 条/tick（公平推进，满载不阻断已接纳工作收尾）。

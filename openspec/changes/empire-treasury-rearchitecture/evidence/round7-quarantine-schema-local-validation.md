# Round 7 — Quarantine Closure & Schema Activation 本地验证证据

> 本文档记录第七轮（Treasury Round 7）的本地确定性验证结果。**未部署到
> Screeps、未接入任何真实 Game writer、未合并 main、无 force push。**
> 本仓库 GitHub 无 CI 工作流——以下全部为本地验证（非 CI passed）。

## 范围与基线

- 起始 HEAD：`ee1ff59`（第六轮终点；任务书所述 `22e381a` 为上次审查时点，
  实际远端已前进至 `ee1ff59`，以实际 HEAD 为基线，未 reset/rebase）。
- 最终实现 commit：`b785ade`（其后仅有 docs/evidence 与 budget 锚点提交）。
- 测试预算基线（起点）：210 suites / 964 tests。
- 测试预算新值（本轮后）：213 suites / 1045 tests（+3 suites / +81 tests，
  未删除任何既有测试）。

## 本轮 commit 清单

| commit | 内容 |
|---|---|
| `1521d0d` | docs(openspec)：Round 7 规范先行（proposal Round 7 段、design 3.9 节、spec 8 个新 Requirement、tasks 第 13 节；顺带修复 design.md 遗留 NUL 字节） |
| `23e1ddc` | fix(treasury)：quarantine 权威闭环——版本化 store v1 + 全局 write blocker + fault-slot 预留 + 容量保守方向 + callback-throw execution unknown 状态机 + writeAdmission 视图 + write-fault phase 拆分与 marker 形状契约 |
| `605f56d` | refactor(treasury)：post-observation fault resolution 证据协议（evidence/guard、active handle 检查、resolution tick receipt、tombstone、显式 repair） |
| `b785ade` | fix(reservations)：canonical owner identity v4 + schema activation gate + 结构化 mutation + 冻结 list + GC corrupted 标志；feat(treasury)：readiness 专测、性能 fixture、架构守卫 |
| （后续） | docs(openspec)：tasks 勾选 + 本 evidence；test(budget)：213/1045 锚点 |

## 关键不变量（实现位置）

1. **全局 quarantine write blocker**：`facade.prepareTransaction` 门禁顺序——
   receipt 幂等 → 同 id `transaction_quarantined` → store 损坏
   `quarantine_store_fatal` → 任意 unresolved/overflow `quarantine_write_blocked`
   （全部先于 Game callback）；write-fault marker 不是唯一锁来源
   （`treasuryQuarantineBlockers` 独立判定，query authorizationSafe /
   writeAdmission 同口径）。
2. **fault-slot 预留**：prepare admission 要求 持久 entryCount +
   activeHandles < 64（`quarantine_capacity_exhausted`，O(1)，先于 receipt
   admission）；写入路径满载返回 rejected（`quarantineTreasuryTransaction`
   不再置 overflowed 丢 identity）；legacy overflowed 只有
   `repairTreasuryQuarantineStoreForResolution`（全量验证后、满载拒绝）
   可清除。
3. **quarantine schema v1 健康契约**：store {version:1, entries,
   entryCount, overflowed?}；global reset 后首次 load 全量验证（key 编码/
   digest 16hex/phase 枚举/locationKind/resource ∈ RESOURCES_ALL/delta 非
   零安全整数/聚合溢出/entryCount 一致）——损坏 fatal fail closed（原数据
   不删、写入拒绝、聚合空、blockers blocking、resolution 拒绝）；轻量
   health 探测 O(1)（查询零写，entry 级损坏由 load 显式检出——与 receipt
   同款契约）；单一 canonical deltas（容量由派生，删除双权威）；聚合按
   store revision 缓存。
4. **write-fault marker 形状契约**：`validateTreasuryWriteFaultMarkerShape`
   （transactionId/digest/phase 枚举/tick/status/kind/source/detail ≤192）；
   损坏 marker 一律视为存在 unresolved fault（`isTreasuryWriteAdmissionLocked`
   fail closed）；phase 拆分 commit 类 vs execution-unknown 类。
5. **容量保守方向**：per location 占用 = max(0, Σ deltas)——正净流入减少
   free capacity（`projectedFreeCapacity` 与 commitments `capacityDelta`
   回调统一扣减，receiver headroom 同口径）；负流出不增加 free capacity；
   正资源 delta 不乐观计入 spendable、负流出计入 committed。
6. **callback throw = execution unknown**：抛错不 abort——立即 faulted +
   marker（phase `action_threw_execution_unknown` + 有界 detail）+
   durable quarantine + 锁定后 rethrow；同 id 再执行 callback 零调用
   （handle_faulted）；Game 非 OK 且 abort 失败立即隔离（phase
   `action_returned_non_ok_abort_failed`，与 throw 严格区分）。
7. **post-observation resolution**：验证链 = 形状 → store load 验证 →
   定位（tombstone/receipt 双通道幂等）→ digest → active handle 检查
   （`active_handle_present`）→ 当前 tick > 故障 tick → 已建立故障后
   shared observation → evidence 观察 strict 晚于故障 tick 且不晚于当前 →
   conclusion 匹配 → phase 允许性（not-executed 仅 execution-unknown 类）；
   still_uncertain 保持隔离；resolve-as-committed 以 **resolution tick**
   写 receipt（actionTick 保留于 tombstone）；tombstone 有界 256 +
   retention 惰性清理 + 超限 fail closed。
8. **reservation schema v4 激活先于一切 mutation**：
   `ensureReservationSchemaActivated`（空店初始化/v1v2v3 迁移/失败与未知
   版本/corrupted 拒绝）挂 `facade.beginTick` bootstrap + 每个 mutation
   入口自检；memoryCleanup 保留 17 tick 幂等兜底（非唯一路径）；全部
   mutation（typed 与 deprecated adapter）经同一 `preflightMutation`——
   无混合 store。
9. **canonical owner identity v4**：token = `ow2:<kindCode>:<nsLen>:
   <namespace><id>`（长度前缀，冒号/Unicode/空格/空串无歧义）；identity =
   kind+namespace+id（roomName/lifecycleRef 是 metadata）；kind-specific
   收紧（ls namespace 必填、非 ls 禁止）；迁移以验证过的 entry.owner 为
   权威重建 key（v3 旧 key 用 v3 token 核验，不解析反推）。
10. **mutation 权威**：结构化结果全验证（房间形状/资源/amount/ttl/
    expiresAt 溢出/owner/gate）；非法与失败零写入；实际 mutation 才 bump
    且恰好一次（adapter 转发单次 bump——修复第六轮双重 bump）；list 返回
    冻结深拷贝；GC malformed 不删除、置 `resourceReservationsCorrupted`
    持久标志（显式 repair 解除）。
11. **write readiness 与余额完整分立**：`query` 返回独立
    `writeAdmission {ready, blockers}`（context/owner/commitment/migration/
    corrupted/receipt health+容量/quarantine health+slot/unresolved/
    fault/lifecycle/tick）；readiness=false 不影响数值字段；prepare 独立
    复查。

## 新增/修改的 Memory 字段

- `Memory.runtime.treasury.quarantine`：升级 schema v1（新增 `version: 1`、
  `entryCount`；entry 的 `resourceDeltas`+`capacityDeltas` 合并为单一
  `deltas`；`overflowed` 保留为 legacy 损坏标志）。上限 64 条 + fault-slot
  预留；清理只有显式 resolution/repair。
- `Memory.runtime.treasury.resolutions`（新增）：resolution tombstone
  （"r:"+transactionId，上限 256，写入时惰性清理 resolvedAtTick 超过
  5000 tick 的过期项）。
- `Memory.runtime.treasury.writeFault`：新增可选 `detail`（≤192 字符有界
  异常摘要；phase 枚举拆分）。
- `Memory.runtime.resourceReservationsOwnerVersion`：扩为 `2 | 3 | 4`（v4 =
  canonical owner token）。
- `Memory.runtime.resourceReservationsCorrupted`（新增）：GC 发现 malformed
  entry 的有界损坏描述（显式 repair 才可清除）。

## 新增指标（facade.metrics）

quarantineEntries / quarantineSlotsReserved / quarantineSlotsRemaining /
quarantineStoreHealthy(bool) / quarantineAdmissionRejections /
unresolvedQuarantines；resolutionCommitted / resolutionNotExecuted /
resolutionUncertain / resolutionRejected；executionUnknownQuarantines；
reservationSchemaActivationFailures / reservationMutationRejections。

## 验证命令与真实结果（全部本地执行）

| 命令 | 结果 |
|---|---|
| `npx jest --config jest.config.cjs src/runtime/treasury/` | 19 suites / 334 tests 全过（含新增 authority/readiness/activation/resolution 重写） |
| `npx jest --config jest.config.cjs`（全量） | **213 suites / 1045 tests / 1045 passed / 0 failed / 0 pending / 0 todo**（97.6s） |
| `npm run typecheck` | 0 error（build + test 两套 tsconfig） |
| `npm run build` | 成功（dist/main.js 4,749,735 bytes；deploy bundle sha256 `2ac4736b…`；dist 未提交） |
| `node scripts/verify-jest-budget.mjs` | 见最终 budget 锚点提交（213/1045，requiredBaselineCommit 指向含全部实现与测试的前置 commit） |
| operation-count 性能 fixture | quarantine blocker 检查 O(1)（1/32/63 条 unresolved 的拒绝路径 fullScans 增量均为 0）；slot admission O(1)（第 64/65 个 prepare 零额外扫描）；query 聚合 revision 缓存（8 次重复查询零额外全扫） |

## 架构检索（全部为空）

1. 生产模块 import faultResolution：空（facade metrics 聚合走独立的
   resolutionEvents 模块）；
2. 生产模块 import compat：空；
3. `clearTreasuryWriteFaultForRepair(` 调用形态：空（未回归）；
4. `Memory.runtime.resourceReservations[` 直写（resourceReservation.ts 之外）：空；
5. 自拼 reservation 持久 key：空（唯一权威 makeReservationStoreKey）；
6. quarantine store 直写（quarantine.ts 之外）：空；
7. dist 提交：空。

架构测试（treasuryWriteArchitecture 11 用例 + invalidation boundaries 5
用例）守护上述边界。

## 测试增量明细（+81）

- 新文件：treasuryQuarantineAuthority 16、treasuryWriteReadiness 7、
  treasuryReservationActivation 4；
- 重写/扩展：treasuryQuarantine 6→13、treasuryFaultResolution 9→17、
  treasuryTypedOwnerMigration 19→33、resourceReservation 2→20、
  treasuryWriteAdmissionPerformance 6→9、treasuryWriteArchitecture 7→11、
  treasurySafeExecute（throw 语义重写）、treasuryWriteFault /
  treasuryCommitmentCompleteness / memoryCleanup（协议适配）。

## 未完成 / 明确不做（本轮）

- 未接入任何真实 Game writer（ResourceControl/terminal/carrier/lab/
  factory/market 均未迁移）；spendable 未驱动任何真实行为。
- 未部署到 Screeps、未合并 main、未 force push。
- 真实 ResourceControl writer 迁移、1000 tick live shadow、live CPU
  canary、ReceiverCapacityLedger 全量整合、Budget Service、旧库存系统
  删除——全部未开始（OpenSpec 对应任务未勾选）。

## 残余风险（如实声明）

1. 本轮全部为本地确定性静态测试——不构成线上验证；真实 Game 环境的
   Memory 序列化行为、跨 tick 分布式时序未覆盖。
2. fault-slot admission 与 receipt pending 上限同为 64：正常路径 quarantine
   slot 在 receipt 之后独立触发（reason 区分），但两上限耦合的运营语义
   （64 并发 prepared 即封顶）需在真实 writer 接入前复核。
3. resolution evidence 是协议级 fixture（conclusion/observationTick/source）；
   各 Game API 的业务对账器（如何从世界状态证明"已执行/未执行"）未实现，
   需要后续轮次配套。
4. legacy overflowed 修复路径要求满载时先 resolution——人工流程未建工具化
   入口（当前只有协议函数 + 测试）。
5. query 的轻量 health 探测不检 entry 级损坏（由下一次 load 显式检出）——
   与 receipt 同款契约，但意味着"损坏发生后、下次 load 前"的短暂窗口内
   blockers 只有 entryCount 维度（该窗口内 unresolved>0 仍阻断；空 store
   损坏不可见——实际影响限于损坏的空 store，风险极低）。

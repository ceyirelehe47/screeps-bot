# Room Defense Focus-Fire Coordination Sidecar

## 为什么

Tower 与主防 Creep（homeDefender）各自独立评分选择攻击目标（towerControl
的 net 伤害评分 / hostilePriorities 的 body 优先级评分）。同一 tick 塔群
集火 X 而防御者攻击 Y 时火力分裂，敌方治疗只需分别抵消两路伤害；分火
判定不含防御者输出；治疗无紧急度仲裁（任一擦伤 creep 吸走全部塔）；评分
平手依赖 find 顺序（非确定）。

## 做什么

- 新增独立模块 `src/runtime/defenseFocusFire.ts`：纯函数 engagement
  planner（每房间每 tick 唯一 plan）+ 快照采集 + Memory.runtime.
  defenseEngagement 持久化。
- 联合伤害预算：Tower 距离衰减 × TOUGH/boost 有效伤害比 + 防御者近战/
  远程输出 - 敌方 range-aware 治疗。
- 过量伤害控制：主目标累计分配 ≥ hits × 1.15 后分火次级目标。
- 紧急治疗仲裁：重伤（缺口 ≥ 35% hitsMax）优先占用塔，上限为攻击塔一半。
- 确定性：id 字典序稳定排序与决胜；打乱输入顺序产生相同 plan。
- 接线：homeDefense 生产 plan；towerControl / homeDefender 消费 plan
  （保留既有执行入口与 fallback 独立逻辑）。

## 不做什么

- 不改变 Treasury 的任何 store schema / proof / marker cleanup / Receipt /
  Resolution / writer kernel 语义。
- 不新增散落直接 Game API 调用点；planner 只输出目标与 actor 分配。
- 不部署；不接入 terminal/market/lab/factory/物流等经济 writer。
- 不改变防御者走位决策（safeZone/rampart 逻辑沿用）。

证据：`evidence/tower-primary-defender-focus-fire-local-validation.md`。

## Round 22 Remediation III — Stateful Focus Allocation

### Kill feasibility 三分类
- `killable_this_tick` / `positive_pressure` / `suppression_only`：killBudget =
  ceil((hits + incomingHeal) × 1.15)；只有全部可参与攻击 actor 的顺序模拟
  有效伤害达到完整预算才是本 tick 可靠击杀；killExpected=true 当且仅当
  primary 分类 killable 且实际分配伤害达到预算（净伤害为正不再等价于
  可击杀）。
- 候选优先级按桶：可靠击杀桶（HEAL 核心 → 拆墙 WORK → 威胁 → 低当前
  血量 → 小过量 → 稳定 ID）→ 正净伤压制桶（净伤害评分）→ 共同压制桶。

### Primary actor 分配
- 确定性 greedy：对 primary 的边际有效伤害降序（稳定 key 决胜），TOUGH
  状态随分配顺序推进；达到预算即停（最少 actor / 最小过量）；移动中
  Defender 边际为 0 不计入预算但保留共享 combat target 的定位 assignment。

### Stateful secondary
- 目标级分配循环：secondary 达自身 killBudget 才切 tertiary；当前目标
  无法由全部剩余 actor 击杀时全部剩余共同压制该目标（不切换第三目标、
  不逐 actor 各自选敌——确定性拆火）。

### Combat target 与 engagement position 分离
- hostile 快照携带接敌位置（inside=直接接敌 / boundary=最近合法
  rampart——由采集方按既有 safeZoneHelpers 防线系统给出，planner 不建立
  平行站位模型）；Defender 的 approach 消费该位置（boundary 前往合法
  rampart，不为追共享目标绕过 Rampart/离开 safe-zone）。

### Shared live fallback
- plan 持久化候选顺序（fallbackTargetIds）；目标失效时每房间每 tick 至
  多一次共享解析（fallbackResolution 运行期写回 plan；Tower 与 Defender
  消费同一缓存；计数有界随 plan 每 tick 重写）；无合法 fallback 共同
  空转等待重规划（不回退独立评分）。

### Emergency heal 按实际治疗量选择
- 对每个伤员计算每座可用塔的实际治疗量（距离衰减感知）；治疗量降序、
  Tower ID 稳定决胜；满足保守需求即停——剩余塔全部进入攻击预算。

### Operation-count
- planner 每房间每 tick 一次（消费不增加调用）；fallback 多消费者单次
  解析；候选评分 O(hostiles×actors) 有界；无指数子集搜索。

## Round 22 Remediation IV — Front-aware Defender Allocation

### Tower 与 Defender 不同的 target eligibility（十三节）
- Tower：房间级火力调度（任意合法 hostile）；
- Defender：默认只对其 assigned front 的 hostile 集合可用（`defenderFrontEligibility` 单一语义源——eligible 集合预计算，planner 内层 O(1) 判定）；未分配 front 的 Defender 采用 room-scope 保守默认；跨 front 增援只允许既有协调系统显式标记（reinforcementAllowed）；
- Target killability 只计入该 target 实际可用的 Defender——借另一 front 的 Defender 不可虚构本 tick 击杀能力；多 front 时 Defender 不被房间级 primary 拉离本 front。

### Zero-primary-damage Defender 再利用（十四节）
- 对当前 target 本 tick 伤害为 0 的 Defender 不再作为 positioning follower 提前消费——保留在 remaining 池，下一个 target 重新计算（对 Primary 为 0、对 Secondary 为正/可击杀的 Defender 参与 Secondary）；
- 全部可执行伤害分配完成后进入 positioning 阶段：按自身 front 选择防守 target（eligible 集合内按计划候选顺序；combat target 保留给下一 tick 规划）、分配独立 engagement position；防御性残余 Tower 分配不再提前消费零伤害 Defender。

### Per-defender 唯一 Rampart 分配（十五节）
- `defenderRampartAllocation`（确定性 stable greedy，纯函数、无 PathFinder）：Defender 按 primary 优先 → secondary → slot 决胜排序；候选按未占用（含他属 occupied 标记）/到目标距离/到 Defender 当前距离/ID 决胜；每候选至多一 Defender；已站合法候选保留；候选不足明确 hold（不重复分配、不追逐边界外 hostile）；
- 采集层（homeDefense）提供 per-hostile 候选集合（boundary ramparts 稳定排序 + 他属占用标记）——复用既有 safeZoneHelpers 防线系统，planner 不建立平行防线模型。

### Room-level fallback revision（十六节）
- `engagementFallbackRevision`：任一 consumer 发现 assigned target 失效时，每房间每 tick 至多生成一次完整修订计划（不再返回单一全局 fallback target）；
- Tower 按房间级修订目标（fallback 候选 ∩ 存活）或明确 idle；Defender 按 front-local 替代（plan 持久的 defenderFronts.eligibleTargetIds ∩ 存活）或明确 hold——不跨 front、不回退独立评分；紧急治疗 assignment 原样保留；
- 多 target 失效/多 consumer（Tower 与 Defender 任意顺序）消费同一 revision；第一个请求来自某 front 不把其它 front 的 Defender 错误转向；多房间完全隔离。

### Fresh plan 是消费权威（十七节）
- towerControl：fresh plan 存在即权威——即使 focusTargetId=null（no-hostile / no-attack-actor）也服从（emergency heal 执行、攻击塔明确 idle）；stale plan 才走既有独立逻辑；
- homeDefender：defenderEngagements[slot] 存在（含显式 hold / targetId=null）即完全由 plan 决定（attack/ranged_attack/engage_position/hold 都不回退旧独立评分）；defenderAssignments 不再作为回落（缺失 assignment 不隐式区分参与）；slot 不在 plan = planner 明确未让该 actor 参与——保留既有独立行为。

### 确定性与 operation-count
- 同快照（任意来源顺序/hostile/front 输入反转）产生同一 plan（defenderFronts.eligibleTargetIds 按计划候选顺序确定性构造）；
- planner 每房间每 tick 一次；revision 每房间每 tick 一次生成；Rampart 分配 O(Defenders×候选) 稳定 greedy（无指数匹配、无 PathFinder）；每房间每 tick 只构建一次 hostile 快照。

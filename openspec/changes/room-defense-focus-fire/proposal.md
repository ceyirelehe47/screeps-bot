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

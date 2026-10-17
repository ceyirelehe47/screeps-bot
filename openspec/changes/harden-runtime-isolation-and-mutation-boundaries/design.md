## Context

基线为正式版本 `2026.10.17-12` / `55bef29`。参考文档基于 `ddd4999`，其中半截路径和共享 Spawn/console 辅助已在当前代码修复。市场仍由旧执行器写入，新方案仅 dryRun；物流仍为 shadow。

## Goals / Non-Goals

本批目标是修复出口与承诺失效的正确性缺口、限制单房异常影响，并收集调度建议。保持 T0 防御每 tick 重试、主循环顺序和业务放行规则。不实施真实降载、市场切换或持久进程表。

## Decisions

1. 出口使用同房多目标 PathFinder 搜索，候选出口来自实际地形与共用移动矩阵。其余边界禁止经过；返回路径通过共用 traffic 执行。搜索预算耗尽有界重试一次，仍有局部路径时允许推进但不把局部终点当出口。空路径的暂时预算失败不封禁房间；可证明无路的失败记录 20 tick 排除。
2. 安全区包装抽为共用选项解析，出口搜索与普通移动都使用相同约束；逐步许可继续在实际发出 intent 前检查。
3. 重规划取消入口放在 resourceTransferTasks 模块，保持原 status/updatedAt/lastError 审计字段与取消条件，只补 Treasury revision 失效。测试以同 tick 的真实 Treasury 服务前后读取为准。
4. 防御逐房回调隔离；异常统计保存在有界 heap，重复错误限频日志；每 tick 仍执行，不建立 T0 熔断器。异常日志自身失败不能阻断后续房间。
5. 调度 shadow 复用现有 profiler 顶层采样边界和 CPU 读数，仅将假设延后阶段写入现有 latest 样本；不额外调用 getUsed，不改变执行、返回值与异常语义。

## Risks / Trade-offs

- 多目标出口路径可能与旧 tie-break 不同 → 用遵守矩阵、地形、maxOps/incomplete 的测试搜索器验证实际移动与边界语义。
- 硬 CPU 终止不能被 JS catch 捕获 → 隔离只保证可捕获的房间异常。
- shadow 阈值未经长期数据校准 → 只作为诊断，不执行延后，也不据此宣称 CPU 收益。
- 单房临时 creep 阻挡可能恢复 → 动态阻挡不写长期排除，保留局部进展及后续重搜。

## Migration Plan

服务器隔离目录完成类型、完整回归与构建；合并并同步干净 main 后构建正式产物。保存完整模块回滚，以发布前线上身份与模块哈希保护上传，再读回全部模块并验证 shard1 实际运行身份和有界健康。发现回归时恢复保存的完整模块并重新验收。


## bcd1d92 复核修订

- 静态矩阵的 incomplete 且 ops 未耗尽，即使有非空 partial 也立即排除本跳转；只有动态 creep 绕行或确实预算不足时允许局部进展。缓存出口的重新搜索必须完整抵达，首次完整 verifiedPath 使用相同的完整性缓存键。
- 地形成本集中解析并显式传给两个 API 与路径键。默认采用道路友好的 2/10，保持当前 PathFinder 分支和官方引擎 Room.findPath 的道路语义；显式业务成本保持原值。依据 https://github.com/screeps/engine/blob/master/src/game/rooms.js#L238-L246 。API 文档中的 1/5 与此包装行为有出入，本批以显式值消除隐式差异。
- 塔的单塔计算和动作都隔离，失败的塔不阻断同房其他塔。房间级隔离继续处理共享防御数据错误。故障摘要由 runtimeIsolation 单写 Memory.runtime.defenseFaults，最多 8 条、TTL 1000 tick、消息至多 240 字符；healthy 路径不创建摘要，profiler 关闭时仍记录并清理，不增加通知副作用。
- bcd1d92 复核批次只修移动和防御，RESERVE 在途 war/deposit 放行当时未实施；该遗漏由本节之后的补员修订处理。市场与其他业务政策保持现状。


## RESERVE 补员修订

用户确认继续补齐已承诺任务。RESERVE 仍阻止启动新任务，防御模式保留原有拦截。war 必须匹配 source/target 和当前 generation，并具有既有排队、强化 gate、实际孵化/活体或成员出生记录；仅 staging/clearing 状态不足以证明投入，因为首个 Spawn 前也会进入这些状态。旧代配置不得借用当前代或相反。通用 spawnPlanner/mountSpawn、war 自有排队与强化准备共用判断，避免只修一个关口。

Deposit 保持单代、单 creep 且死亡即结束的语义：仅已受理 spawning、g0、同源 taskId/configName/args 的 owner 免于 RESERVE 清队；原有 spawnReadyAt 当 tick、完整路径、经济性、body 和 spawnOnce 门继续执行，不新增死亡补产或第二代。

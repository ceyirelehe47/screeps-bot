## Context

发布基线是 main `bb2ffcba`、市场 r8；许可链已使用 segments，物流诊断目前需读线上确认。市场实际规则包含原矿正常/溢出/清仓分层，不使用附件中已过时的 r7 数值。

## Goals / Non-Goals

**本轮目标：** 完成可上线的 S4 dryRun 新内核和 S5 等价复用；建立按 lane 的可追踪差异、预算与有界状态，使多天对照可以实际开始。

**后续阶段：** live 执行器、静默切换、移除旧根和数万行旧模块、提高成交上限。它们需要多天样本和切换前的连续两 tick 静默证明。本轮不把这些任务提前打勾。

## Decisions

1. 新模块放在 `runtime/market/`。政策是普通数据，价格继续使用现有可信价格运算；保护量只通过现有 Protection 账本和统一溢出函数计算。首次 dryRun 保持 1000 的对照成交量，政策覆盖只作用于观察。
2. 在 V3 第一遍完整挑单完成后暂存事实引用；在原交易编排结束后才消费。运费只读取旧 full-read 已计算的 memo，不调用旧 callback，不增加旧预算计数，也不重新读盘口。缺少运费、源数据或预算时记为不可对照，不能当成一致。
3. 对照采集受模式、bucket、单次 CPU 和采样间隔约束。结果写在新 `Memory.data.market`，有 schema、lane 上限、旧 lane 剪枝和 20 条审计环。记录可比样本、选单/保护/价格差异及时间跨度，不能用“运行多天”替代样本覆盖。
4. S5 使用明确参数保留变体：Spawn 负载是“正在孵化算一项+队列长度”；优先 active 与 planned-load map 是不同调用策略。配置/活体查询保留原数据源和房间范围；公共 helper 不擅自扩大查询范围。
5. console 字符串输出通过共用 JSON 包装器复用，保留参数、Raw 返回对象、缩进、名称与导出。能量默认值只合并完全同值且语义相同的项；hubProgress 的 20k 与当前 roomEnergyPolicy 的 25k 不能直接合并。
6. 物流 shadow 如果线上启用，则保留其诊断，直到有明确停用决定或替代证据。三个市场安全闩保留在原生产流程，未来切换时显式迁入新流程。

## Risks / Trade-offs

- 观察挤占 V3 预算 → 延后到生产决策之后；cost memo 只读；独立 CPU 上限，异常隔离且记录失败。
- 只比较选中项掩盖保护/价格偏差 → 对输入覆盖的 lane 逐项比较保护量和 floor，并分别计数；不完整样本不算一致。
- 无限 lane/审计膨胀 → 固定上限、失去覆盖后的 TTL、审计环和运行时字节验收。
- helper 看似同名但语义不同 → 自动清点后逐个对照；保留 active 偏好、planned load 和来源边界；服务器完整回归。

## Migration Plan

先归档旧市场根和活动 segment，读 pending/自有卖单/控制状态。首发只开启 dryRun，V3 是唯一交易写入者。保存全模块回滚，main 对齐后用服务器干净构建上线，读回及实际 shard 验收。

多天对照通过后，再实现受控执行器及交易确认，停旧写入并连续两 tick 确认无在途；复制 trustedFloors，归档并清除旧根，移除旧 import，再观察限额放开。任何未知 pending、坏状态或报价差异均阻止切换。回滚先核实当前身份与在途状态，恢复归档模块/状态并重新验收，避免双写。

## 2026-10-21 明确授权的正式接管

用户要求直接切换，不再继续等待监控天数。已有对照跨多次发布分别保留，未假称连续多天或独立执行已验证。本次完成执行实现与服务器验证后，按有界线上成交确认验收接管；旧模块删除和扩大限额仍是后续独立工作。

- 调用链保持原 main 阶段：marketSalePreflight 在 cutover 所有权下进入 compact preflight，ResourceControl 读取新补货授权，原 marketSaleAutomation 阶段调用 compact live。旧直接入口也检查所有权，避免双写。
- 所有权粘性保存在 Memory.data.market.live，配置 mode=off 只停止新成交，仍对账。Memory.cfg.market.cutover 绑定部署提交、授权文字、本地旧根/segment 归档哈希和当前两条 lane 的 Controller/Terminal 身份。
- 原 data.marketSaleAutomation 保留且不再承载新 arbiter/WAL。新根接收可信地板、动态地板锚、未过期历史确认、冷却高水位；旧 pending、隔离、staging/reservation、自有卖单或未过期 claim 任一不空均拒绝接管。连续两个实际 tick 静默后激活。
- 新采集不读取 V3 staged input；复用经过验证的纯定价、EMA/日限幅、生产保护 adapter 和统一 arbiter。新盘口独立读取；历史有有界缓存；同轮运费 memo 独立计算。planner 保留原 maxCpu=3 预算，含采集的 live 周期预算为 15，执行前另留 5 CPU。预算超限的计划不交易。
- 切换仅接管 E1N57:L 与 E4N58:X，保留 r8 单笔 1000、普通/溢出/清仓规则、全局与 lane 冷却、滚动窗口及生产/能量储备。先落 prepared pending，再经账号/Terminal claim 和最终订单、生产保护读取提交；异常和未知返回保留同一 pending。
- 引擎逐笔 outgoing transaction 确认实际数量、运费和净额；收据保留 UTC 日期与 lane，支持逐 lane/日核算，计数不把 OK 当确认。收据及审计分别限制 1024/20，满容量停止新单；长期窗口不靠丢弃有效收据放宽限额。
- Exposure 和 Terminal 补货授权切到新根；与旧 segment 的可用性解耦。未观察的旧停采闩保留，避免只接管两个 lane 就清掉其它矿物的暂停状态。三处旧市场安全闩继续强制关闭，出生和移动策略不改。
- 补货目标的实际规划入口同时识别 compact 所有权，不能继续要求旧 mode=direct。新执行器复用 Terminal readiness 的完整逐项校验：同 tick、授权 revision、Terminal 身份、64 项以内去重贡献、完整能量储备与未完成补给状态；缺失证据时不推进 planning 时钟，避免与 ResourceControl full cycle 错相。执行前再次验证动态能量储备。
- 回滚先 mode=off，等待新 pending 获得权威确认，归档新根与成交收据；核对当前模块身份后恢复完整旧包及旧模式。移除新所有权前再次确认无 pending/claim，不覆盖未知在途，不直接恢复陈旧全量 Memory。

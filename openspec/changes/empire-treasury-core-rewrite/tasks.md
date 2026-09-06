# Tasks — Empire Treasury Core Rewrite

## Core Rewrite IV · Remediation II（2026-09-06 完成）

承接 Remediation I（0f5965e）及其源码审查的三项实现缺口与三项验证缺口（任务书 treasury-core-rewrite-IV-remediation-II-implementation.md；验收索引 F01–F20）。

- [x] 影响范围审查（subagent：occupancy 消费方仅 facade 五路径、rotationCursor 全仓零测试引用、A08 incompatible 场景两条路径均 rejected、performTreasuryFullReset 新增输入纯增量、budget 需清单+脚本双更新、Defense 冻结零耦合、external 锚点不得补世界序等两条实现风险提示）
- [x] 红灯基线：R1（流出 1000/800/200/201 + 流入 100/80/20/21 固定数值）、R2（真预扣后确认前硬断点快照内 cursor 未前移）、R3（absent/incompatible/unhealthy 三态 × 两 preflight 均落 valid）在 0f5965e 上 6/6 红灯（evidence/core-rewrite-iv-remediation-ii/baseline/r1-r3-*.log）；修复后转绿并转为持续回归（test/baseline/treasuryRemediationIIBaseline.test.ts）
- [x] 工具契约反例：V1（效果前 Memory 配效果后世界 900≠1000）、V2（reloadKernel 后旧许可仍 valid）、V3（拦截器卸载回滚已放行预扣 budgetUsed 0≠2）以旧工具形态复现红灯（baseline/v1-v3-*.log + scratch 重现器 patch 快照；新工具以 F13/F14/F15 契约测试承担持续回归）
- [x] 工作流 D（断点配对/完整 reset/拦截器）：harness 增 captureTreasuryHostBreakpoint 原子捆绑（Memory JSON+世界+tick+世界序+事件截断）与 performTreasuryKernelFullReset（内核装配面——与 service 面共享同一 reset 核心：JSON 重载+jest.resetModules+退役 global 清理）；配对一致性校验（Memory 世界序≠捆绑序即拒绝）；roomSpecsWithWorld 修复“快照缺失结构被 RoomSpec 复活”；共享存储拦截器（liveValue 卸载契约+onAllow 硬断点钩子）；事件驱动 exact oracle（treasuryExactOracle：结论从宿主事件/分支世界序推导，不从固定返回值/生产 outcome 来）
- [x] 工作流 A（R1 统一覆盖语义）：新建 kernel/coverage.ts 共享纯判定（锚点链 invocation→external→invocationBoundary + 世界序优先/tick 严格大于兜底/无可比事实保守）；occupancy 占用投影、commands.observationTakesOverEffect、beginTick committed 清理门三处消费同一判定（消除三处各自演化）；closing+committed 仅边界（正常恢复状态）在观察越过边界序时不再重复扣减——记录保留与占用投影分离
- [x] 工作流 B（R2 同次发布）：prepayReleaseUnitBudget 同一次安全写发布 budgetUsed+2 与记录内下一服务位置（重读健康当前记录；经既有 expected 读回确认后才调端口）；确认命令不再携带 rotationCursor（命令字段移除——不得用旧调用栈值覆盖较新位置）；预扣失败调用 0/义务不减；单字段篡改被独立 expected 拒绝
- [x] 工作流 C（R3 健康门禁）：两个 preflight 在 absent/incompatible/unhealthy 一律明确拒绝（可解释 reason；纯读不初始化不修复；ring 单独 degraded 不伪装核心损坏）
- [x] F01–F20 验收矩阵（kernel 16 + service 15；F16=E10 V2 改造形态、F19=全仓最终验证；E02 重写为配对断点两分支+事件 oracle、E06–E10 循环改完整 reset、E08 换共享拦截器、reloadKernel 降级 jsonRoundtripKernel 序列化探针）；F20 三生产负向变体（旧 occupancy/游标移回回调后/preflight healthy-only）各自语义红灯后还原全绿
- [x] 全仓回归与预算（数字见 evidence/core-rewrite-iv-remediation-ii-local-validation.md；Treasury 定向与 test/baseline 独立归类汇总）

## Core Rewrite IV · Remediation I（2026-09-06 完成）

承接 IV（aea7035）及其源码审查的四项实现缺口与三项验证缺口（任务书 treasury-core-rewrite-IV-remediation-I-implementation.md）。

- [x] 影响范围审查（subagent：手写 fixture 清单/下游读者/clone 形状假设/调用链/fresh 观测点/reset 调用方/budget 结构；预计红测 top5 与实际 7 文件 19 红一致）
- [x] 红灯基线：R1–R4 + V2 反例（5 用例）在 aea7035 上 5/5 红灯（真实路径快照/合法 8 义务/真许可克隆；evidence/core-rewrite-iv-remediation-i/baseline/：日志 sha256 31b01eb0、源码快照 sha256 887bf3f8、退出码）；修复后 5/5 转绿并转为持续回归（test/baseline/treasuryRemediationIBaseline.test.ts）
- [x] 工作流 A（R1 调用边界恢复）：`invocationBoundary` 与 pending→dispatching **同次发布**（单命令原子；语义="调用已获准进入，此后可能发生"，不是 executed 也不是 external.accepted）；dispatch_result/recover/settle 保留不改写；观察接管 anchor 链 invocation→external→invocationBoundary；rearm child 从 null 起步不继承；validator 强制 dispatching/outcome_unknown ⇒ 边界非空、invocation/external 存在 ⇒ 边界同在、pending 零调用侧事实（缺锚点旧记录明确拒绝不修成健康——不兼容数据不在线迁移）
- [x] 工作流 B（R2 记录内公平）：cleanup.cursor 持久轮转位置（随成对预算的确认命令推进；true/false/throw 都前移；调度元信息不证明义务完成）；beginTick 消费者遍历从 cursor 旋转（不再每 tick 从第一项开始）；**预算耗尽 break 前也持久化已尝试位置**（否则失败前缀每 tick 重新占据——实现中发现并修复的缺陷）；集合缩小/回绕按取模安全重定位
- [x] 工作流 C（R3+R4）：executeRearm 对非空 externalConsumers 结构化拒绝（先于父代权利消费与高成本处理；非法类型 invalid input 不抛错；父代保持 retry_ready、capability 随后可用于合法请求）；kernel 只读 preflight（dispatch/rearm 许可 WeakSet 真实性/tick/generation/未消费/活跃记录）前置到 facade 消耗 fresh/policy **之前**（克隆/过期/已消费/已退出工作的许可零增量）；preflight 结果不是可复用执行凭证（真正调用边界终验仍在 executeDispatch）
- [x] 工作流 D（V1/V2/V3 验证缺口）：performTreasuryFullReset 增加 memorySnapshot 参数并**无条件 JSON 重载**（指定断点严格使用该快照；缺省入口快照立即重载——消除"取了快照却没用"）；D11 从手填 dispatching fixture 改为**真实执行路径断点捕获**（adapter 入口/效果后快照）；D19 推进循环逐 tick JSON 重载重建运行时；D23 RETRIED 分支真实化（60 对 parent/child 完整 retry 链：not_executed→清理→retry_ready→capability→新 contract→executeRearm→child 实际执行）
- [x] E01–E20 验收矩阵（kernel 13 + service 11；E01/E03=D11 改造版，E05–E10/E19=kernel 文件，E02/E04/E11–E18=service 文件；E20=五负向变体各自语义红灯后还原全绿——evidence/negative-variants/ patch+红日志+还原绿日志）
- [x] 既有测试适配（7 文件 19 红：手写 fixture 补 invocationBoundary/cursor 的合法持久形态；A04/A12/B20/B25/C22 直改记录同步补边界；runtime.d.ts 镜像类型 + memoryDeclarationBoundaries 指纹更新 2d2cd73f→1e376a50）
- [x] 全仓回归 225 suites / 1289 tests 零失败；worst 构造器含新字段极值实测 ≤360,000（满 64/128 构造 343,817 字符，bytes 另报=chars——受控全 ASCII）

## Core Rewrite IV（2026-09-06 完成）

- [x] 侦察与红灯基线（subagent 交叉验证七缺口全部定位；b6c87c1 干净 worktree：8 缺陷反例红灯 / 8 合法对照绿，evidence/core-rewrite-iv/baseline）
- [x] 工作流 A（R1/R7）：committed 完整退出条件进入 advance_cleanup 命令边界（时间序 + 范围 + 义务空 + 发布成功；无观察端口保守保留，D01/D12）；观察视图时效（epoch.worldSequence < 持久世界序 → 重建观察，聚合退出与旧视图失效同边界，D02/D03）；世界序持久化（Memory.runtime.treasuryWorldSequence，global 槽退役；跨 heap reset 接管不双扣不扣留，D09/D10）
- [x] 工作流 B（R2/R3）：fresh 耗尽即阻断（observation_unavailable，无旧快照回退，D04/D05）；承诺完整性 + reservation 迁移/健康进全部真实入口（authorize/dispatch/rearm 与 query 同源，D06/D07/D08）
- [x] 工作流 C（R4/R5）：成对预算（预扣 2 份/单位、确认与失败诊断 0 份额；8 义务 ≤3 完整预算 tick 完成，D13/D17）；真实 remaining 持久化（retry_ready ⇒ 空集合 validator 强制，D14/D15/D20）；公平游标 break——D19 发现并修复两个实现层缺陷（预算耗尽 continue 空转致游标回原点结构性饿死；失败诊断 +1 份额挤占后方记录）；断点/丢写/reset 语义（D16/D18）
- [x] 工作流 D（R6）：槽位上界构造器实测法（真实 JSON.stringify；validator 真实收紧腿数 12/generation·adapterVersion ≤9999；满载实测 ≤360,000、bytes 另报，D21/D22）
- [x] D01–D24 验收矩阵（treasuryRewrite4Acceptance 20 + treasuryRewrite4Lifecycle 12）；D24 负向变体三件套红灯（A:2 红 / B:1 红 / C:1 红，语义断言失败）后还原全绿；D23 混合规模模型（世界轨迹与独立参考模型一致 + 全 heap reset 接管）
- [x] 既有 A/B/C 套件适配（C01 语义演进注明依据；C03 fixture 走真实 mutation API；C16 成对预算 8→4；B19/A20 上界适配；kernel 直调测试补 observeForCleanup 端口）
- [x] 全仓回归 222 suites / 1260 tests 零回归；budget 更新 220/1228 → 222/1260；schema 保持 v3（treasuryCore 子树结构不变，新增独立键 treasuryWorldSequence）

## Core Rewrite III（2026-09-05 完成）

- [x] 影响范围侦察（subagent：授权链/发布链/观察投影/调度预算/解码五位置；R1–R9 全部定位到 383ffc1 源码）
- [x] 红灯基线：R1–R8 反例（17 用例）在 383ffc1 干净 worktree 上 13 failed / 4 对照 passed（evidence/core-rewrite-iii/baseline/：基线 SHA、脚本、verbose 日志、命令与退出码）
- [x] 工作流 A（R1/R2/R3）：policy scope 合计累计口径（池 1000/保留 900 的累计越界被拒）；kernel 容量端口携带完整上下文（真实 contract 身份 + 验证 owner + 复验排除本笔，无匿名裁决）；facade 执行门禁（共享窗口 lifecycle.lastEndTick/统一判定复验/fresh 观察/结构 incarnation 比对；blocked 前置状态调用零、许可不消费）
- [x] 工作流 B（R4/R9 部分）：writeTreasuryCoreMemory 独立预期快照（mutate 后深拷贝；原地污染/换旧值/丢写全部识别）；条件回滚（仍属本次失败发布才恢复 baseline，较新推进不覆盖；初始化同一契约 + 条件撤销）
- [x] 工作流 C（R5）：closing(committed) 在观察覆盖前继续占用（世界序 epoch.worldSequence vs invocation.worldSequence 优先、tick 边界兜底）；test adapter execute 真实写受控世界（同步生效模型）；多实例/reset 无责任空窗（C12/C13/C15）；harness 重装房间保留世界效果
- [x] 工作流 D（R6/R7 部分）：外部端口调用前持久预扣预算（预扣失败零调用；份额不退回；记账单调不回退）；子预算 2/3/1/清理保底 2（持续取消流量不饿死清理）；ring 非数组/坏元素贯穿 metrics/kernelJournal/预算命令（degraded 时空历史视图、写前重建）
- [x] 工作流 E（R8）：完整值校验（invocation/external/evidence/lifecycle/retryDeadlineTick/durableFacts 白名单与数值；受控字符集零转义膨胀；budgetUsed ≤8）；schema v3；逐槽完整生命周期序列化上界推导 + 总预算 360,000（C22 断言 + 真实满载实测）
- [x] C01–C24 验收矩阵（treasuryRewrite3Acceptance 58 + treasuryRewrite3Lifecycle 7；世界序审计全局槽 __treasuryWorldSequence 通过 ABI 边界）
- [x] 既有 A/B 矩阵适配（schema v3 fixture/sweep 子预算/预扣语义/世界真实更新参考模型/B19 满载观测量）——Treasury 19 套件 393/393
- [x] 治愈复验：基线反例（fixture 升 v3 + R2 用 synthesis: 命名空间修正）在修复后代码 17/17 全绿（evidence negative-variants/baseline-healed）
- [x] C24 负向变体三件套（去累计 policy 3 红/载荷作发布目标 1 红/调用后计预算 3 红）各自红灯后还原，58/58 恢复
- 注：II 轮 evidence 的 validation-head 指向中间 6daf3bc、bundle hash 与最终说明不一致——保留为历史（III 报告已注明）；II 轮"A05–A08 等价"在 v3 下 fixture 已同步升级。

## Core Rewrite II（2026-09-05 完成）

- [x] 影响范围侦察（subagent：生产调用方仅 main.ts/productionMonitor/runtimeServices；爆炸面在 16 个 co-located 套件）
- [x] 红灯重现：B01–B28 矩阵先行版（42 用例）在基线 35ed7f8 上 26 failed/16 passed（R01–R03/R05–R11 全部复现；R04 经独立基线脚本证明 pending 无出口）
- [x] 工作流 A：permit 签发快照深冻结 + 执行前完整身份重验（R01）；发布确认写协议——基线漂移检查 + 读回深度精确比较（R02）；查询视图独立深快照、health 不泄漏 memory（R06）；external_settlement_receipt 删除、settle 收口到受控 reconcileOutcome 端口（R07）
- [x] 工作流 B：authorizationFacts 统一判定（查询严格口径/接纳/rearm/复验共用）；tentative overlay 删除（同一责任唯一扣减归属）；worstCase 双向腿；unknown 流入占接收容量；rearm 同严格（R03）
- [x] 工作流 C：cancel_pending + 跨 tick sweep（R04）；缺端口拒绝/保留（R05）；公平游标 + per-tick 持久预算（R08）；consumerKeys/未知字段/计数器饱和/总量 360,000 预算（R09）；ring degraded 隔离 + 写入重建（R10）
- [x] schema v2（recovery 调度区 / pending_cancellation / 双向腿）+ runtime.d.ts + 指纹更新
- [x] B01–B28 验收矩阵全绿（treasuryRewrite2Acceptance 42 + treasuryRewrite2Lifecycle 17：B03/B12/B13/B19/B25/B26）
- [x] 共享完整 reset harness（test/mock/treasuryResetHarness：JSON 快照安装为全局 Memory + jest.resetModules + registry 重装 + 真实 beginTick）
- [x] A03/A06/A16/A21/A22 等价性修正（R11：真许可篡改/多笔合计/全返回值遍历/完整 reset 语义）
- [x] 压力扩展：接收竞争序列（125 笔确定性上界→62 笔收紧后验证）、pending sweep 取消流（500 项）、公平性（B16 前 8 失败第 9 完成）
- [x] B27 负向变体三件套红灯验证（弱许可校验/忽略 unknown 接收占用/抛错当释放成功）后还原
- [x] evidence：core-rewrite-ii-local-validation.md + core-rewrite-ii/ 原始记录

## Core Rewrite I（2026-09-05 早些完成，35ed7f8）

- [x] 边界侦察、新内核 kernel/、facade 重写、165 旧协议文件删除、A01–A24 矩阵、压力与小模型、架构守护、Defense 冻结回归、evidence（见 core-rewrite-i-local-validation.md）
- 注：I 轮 evidence 中"A01–A24 全通过"的覆盖等价性在 II 轮审查中未成立（A03 只伪造新对象、A16 只测单笔、A21 未遍历 health、A22 未完整 reset）——II 轮已按 R11 修正并保留原 evidence 为历史。

## 明确不做 / 遗留（design §4）

- [ ] 真实经济 writer 接入（生产 adapter 注册表保持为空——部署阻断条件而非待办）
- [ ] 受控 external settlement capability（自报通道已删除；新通道必须同等受控，接入真实 driver 前置）
- [ ] 真实 Screeps driver 的"效果保留而 Memory 回退"非原子窗口验证（跨 tick 重发不能排除 → 真实 driver 禁用是结论）
- [ ] 旧 Memory 在线迁移器（按任务书不建：发现旧数据报 incompatible 阻断）

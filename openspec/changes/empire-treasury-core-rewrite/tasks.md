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

## Core Candidate Seal I（2026-09-07）

- [x] 影响范围侦察（subagent：H18 块 595–948 行与 H01–H07 零共享可整块改写；helper 放 test/mock 走既有 @mock 别名不触碰 tsconfig/jest 配置；风险深快照用 JSON 往返而非超限静默浅拷贝的 durableClone；budget 沿两 commit 锚点滚动流程；H18-TRACE 无自动化依赖；evidence 写文件为仓内首个 fs 测试 helper——仅环境变量设置时惰性 I/O）
- [x] 冻结起点核验（K01）：远端未前移（869149d）、工作树干净；本轮默认生产零 diff、构建配置/依赖零变更（例外仅当出现可复现生产反例，本轮未出现）
- [x] 工作流 A（K02/K03）：新增 test/mock/treasurySealEvidence.ts（检查点流水+原始端口事件、计数一律实际事件求和；unknown 风险白名单 13 字段深快照 JSON 往返脱离 Memory 引用、字段级比较定位 attemptId+字段路径、null 与缺失不互替；完整性核验对缺窗口/缺终态/序号段落不符/事件计数不一致/风险覆盖缺 ID 报 problems；TREASURY_SEAL_EVIDENCE_DIR 控制导出——未设置时全部断言照常零 I/O、每 Jest 进程独立子目录、失败定格 incomplete 轨迹不补成功终态）；H18 J06 全程轨迹化：54 检查点（初始基线 + 12 观察×2 + 13 收尾×2 + 1 恢复×2 + close 前后）每检查点 healthy + 风险与基线逐字段比较，收尾/失败恢复段补齐份额≤8/释放≤4/失败项不提前消失/健康项不饿死断言，最终 close 段同 tick 累计释放核验，终态 20 条 unknown 风险与推进前独立基线逐字段一致（不只 ID+phase），全程成功 key 恰一次、失败尝试全部先于宿主恢复；fixture 端口事件流化（releaseEvents 含 tick/成败/序号）
- [x] 工作流 B（K04）：40/10 表述纠正为固定 H18 fixture 的回归测试限值（非通用完成上界、8 份额/tick 是上限非最低服务量）；收尾段退出条件显式断言（remaining=1/closing=1），到达限值未满足即失败；VI 段与 test-migration-map §13 历史表述同步勘误（旧日志不改写，勘误说明历史口径）
- [x] K06 敏感性（测试侧）：合成完整轨迹六种破坏（缺中间观察窗口/缺终态/缺 post-close/事件缺失/风险覆盖缺 ID/finalClose 空）核验全红且定位问题；真实 fixture 形状风险漂移五种（worstCase 腿金额/调用边界 tick/identity 摘要/null→缺失/记录缺失，ID/phase/腿数不变）均定位到 attempt 与字段；J06 内嵌真实轨迹隔离副本删窗口自检 + 真实基线隔离副本单字段漂移自检
- [x] budget 滚动：236 suites/1417 tests（IVKernel 12→14），锚点 046e4c0
- [x] Agent 本地验证（K05/K07）：固定 VALIDATION_HEAD 62d6457 全量模板全绿——冻结/配置/Defense 三组零 diff、typecheck×2/build 0、KEY 五件 54/54、Treasury 32/571、Defense 11/118、全仓 236/1417、budget PASSED（锚点 046e4c0）；四个 trace 目录各 1 份 H18-J06.json 互不覆盖；尾段 status-after 首检因实施者验证期间归档 evidence 失败、移出后复检三步全过（final/tail-rerun.log，如实记录）；bundle b2999d8c（构建器嵌入身份，hash 只作追溯）（evidence/core-candidate-seal-i/final）
- [x] 第二干净 worktree 复验（K05）：独立 reviewer subagent（未参与实施）在 detached@62d6457 worktree（原 lockfile npm ci）实跑——冻结三组零 diff、typecheck 0、KEY 54/54、Defense 118/118（独立 jest cache/轨迹目录）、H18-TRACE 与主运行逐字段一致、轨迹机器核验 27 窗口检查点事件计数不符=0/风险 20/20 全 null diff/终态一致；工作树前后干净；Agent 侧审查不冒称外部人工审计（evidence/core-candidate-seal-i/revalidation）
- [x] 负向控制（K06）：两旧 patch 在 62d6457 git apply --check 干净可应用（无需等价变体）；一次性 worktree（npm ci 后即用即删）——heap-only：J01/J02 主用例+J03 坏 ring 3 红行为断言（exit=1）→还原 9/9 绿；zero-advance：J06 全轨迹版+H 推进系列 9 红、J05/零推进对照/敏感性仍绿（判别准确，exit=1）→还原 14/14 绿；测试侧敏感性六破坏+五漂移均红并定位（negative-controls 分开分类）
- [x] 独立审查（2026-09-07 Agent 独立验收结论 **ACCEPT**：K01–K08 全 PASS——冻结差异 7 文件亲跑逐行一致（生产/配置/Defense 三组零 diff，Defense 用真实平铺路径+cat-file -s 防空比对）、轨迹 54 检查点独立核验（事件计数不符=0、96=90+6、finalClose 25）、风险基线 20/20 全 null diff 且白名单与 §2.3 对应（抽查原始腿值在档）、限值断言与 J05 逐字节不变亲验、reviewer 两份轨迹 recordedAt 不同确系独立运行、四份变体日志数字一致且 IVKernel 亲复跑 14/14、budget 常量/manifest/jest-full 尾部三处自洽、git 线性 4 提交+远端未动+7a2ee36 全部非执行文件；4 低危 CONCERN——(1) 任务书原文件在验收机 Downloads 缺失，验收以清单+tasks §14 K 矩阵替代核对未见矛盾；(2) 失败尝试 tick 26 与恢复同 tick 的时序表述建议后续写恢复生效前窗口（事实按 (tick,seq) 全序成立）；(3) 变体 patch 系 VI 轮原 patch 复用（README 已标注 apply --check 干净），验收读日志+复跑绿侧未重 apply；(4) bundle hash 不同系构建器嵌入身份（口径诚实）；内核候选版不因此轮封板复验获得部署许可）

## Core Rewrite IV · Remediation VI（2026-09-07）

- [x] 影响范围侦察（subagent：admissionVeto 全调用点归类——三写入口须升级、接口导出面 heap-only 保留；readTreasuryCoreStoreHealth 四态下门禁行为顺序推导；lifecycle_closed 断言测试清单语义不变性核对；H18 helper 共享面/budget 条目/complete reset 模块身份陷阱三风险点）
- [x] R1 基线反例（干净 worktree 4ba065a，exit=1）：同 tick 成功关窗（closurePersisted=true、lastEndTick=T）→ 完整 reset → heap 否决随模块重建丢失 → 新 kernel.admit 错误 admitted（frontier+1/active+1）→ 新签发 dispatch 进入 adapter（adapterCalls=1）→ rearm capability 签发 ok + executeRearm 错误 admitted；两对照（未关窗/下一 tick）绿（evidence/…-remediation-vi/baseline TRACES）
- [x] V1 基线反例（同 worktree，exit=1）：旧 H18 fixture 被生产 validator 判 unhealthy（"closing 但结果未确定或无证据"结构矛盾）→ 12 tick 完整 reset 全部空转：释放 [0×12]、total 0、四阶段数量零变化——旧断言（≤4/unknown=20/失败义务在）在零推进下仍通过（测试前提无效的完整证据）
- [x] R1 修复：kernel 新增 admissionGateStatus 共享只读门禁（持久 lastEndTick===当前 tick 先查、heap 否决兜底；原因文本区分来源不冒充）→ admit/executeDispatch/executeRearm 三入口共用；facade admissionWindowOpen 改为消费 kernel.admissionGateStatus（两侧判定与文案统一）；门禁纯读零写、不进 requireWritableHealth、非健康核心退化 heap 单口径原拒绝不退化；修复后基线 replicator 治愈（admitted→rejected/lifecycle_closed/增量 0）
- [x] V1 修复（H18 整体重写，不放宽 validator）：64 条合法混合（30 closing×3 义务 committed/not_executed 混合+1 项持续失败义务/20 unknown 有调用边界/10 retry_ready exact not-executed 义务空/4 pending 无调用侧事实）validator 判 healthy（J05）；12 tick 完整 reset 观察段逐 tick healthy 前后核验、份额≤8、释放≤4、非零服务、pending 安全取消、20 unknown 按 ID 精确保留、成功义务不再调用、失败项不饿死健康项；40 窗口有限收尾（实测 13 tick；Seal I 勘误：40 系固定 fixture 回归测试限值而非通用完成上界，8 份额/tick 是上限非最低服务量）+ 宿主恢复失败端口后 1 tick 完成收尾 + closeWork abandoned 安全退出 + 终态只剩 20 条不对账 unknown；零推进负向对照（healthy fixture 下进度判别函数判 false——上限/保留断言单独绿不构成通过）
- [x] J 矩阵：J01（完整 reset 后 kernel admit/executeRearm 与 facade authorize 全拒 + 未关窗/下一 tick 对照 + 旧许可失效单独分类不以替代）；J02（真 P/R + 持久关闭 + 仅清 heap 否决的执行门禁隔离——动作 0/P 仍 pending/父代未替换/许可未消费经 preflight 直接验证）；J03（仅 heap 原因不冒充、unhealthy 拒绝不退化+查询零写、坏 ring 不阻断持久判定）；J04（关窗 tick 内清理推进/cancelPending/closeWork 可用+下一 tick 新业务成功）；J05/J06 见 H18 重写；J07 两负向变体（仅 heap 门禁→J01/J02/J03 持久判定 3 红行为断言非编译错；零推进→J06 红+H 系列进度红、J05/零推进对照仍绿判别准确；还原 21/21 绿）；J08 最终验证与主报告承担
- [x] 上轮 H18 观察项关闭：手工满载记录改用合法形状（本轮 V1），断言非空转；上轮报告的 H18 空转保证如实更正（见 test-migration-map §13.1），不改写历史
- [x] Agent 本地验证：typecheck/build/Treasury 32/569/Defense 冻结 11/118/全仓 236/1415/budget PASSED/固定验证 HEAD 2e15fe3（见 evidence/core-rewrite-iv-remediation-vi/final；主报告 …-remediation-vi-local-validation.md）
- [x] 独立审查（2026-09-07 Agent 独立验收结论 **ACCEPT**：八项全 PASS——基线反例 TRACES/行号与归档日志一致、R1 门禁逐行核对（无第二权威/无新持久字段/关窗发布时序未变）、J 矩阵断言非空转抽查、21/21 定向复跑且 H18-TRACE 与摘录逐字一致、budget/验证产物数字自洽、git 线性 + Defense 零 diff + 远端一致、任务书边界无违反；3 低危 CONCERN——commands.txt Defense 占位符已补交完整列表，.ts.txt 归档策略沿下轮待办，baseline-healed exit=1 系 V1 预期红已注 README；内核候选版不自动升级为部署许可）

## Core Rewrite IV · Remediation V（2026-09-07）

- [x] 影响范围侦察（subagent：performTreasuryFullReset 全调用点三类归类、kernel endTick 结构与 admissionWindowOpen 4 消费点、依赖关窗时序的 H/C/G 测试清单、attribution-probe 形态、budget 现状）
- [x] 前置卫生：5 文件历史 NUL 字节转 \x00 转义（零行为变化；grep/read 工具恢复可用）
- [x] 基线反例（干净 worktree fb5e44b，两脚本均 exit=1）：R1 对照绿+三反例红（回调内 lastEndTick=null/authorize admitted/dispatch 实际执行/丢写后跨实例 admitted/抛错后窗口仍开）；V1 TRACE 绿（世界回 1000 + J 含后来 effect + settle committed 错结论真实复现）+ REJECT 红（evidence/…-remediation-v/baseline；修复后复跑 R1 4/4 绿、V1 TRACE 红/REJECT 绿）
- [x] R1：endTick 关窗先行——请求即置模块级按 tick 失效否决标记（admit/executeDispatch/executeRearm + facade admissionWindowOpen 共享消费）→ publishTickClosure 安全写发布确认（幂等/结果如实）→ 关窗后现读驱动恢复循环 → 尾部只维护预算/游标事实并幂等重申关窗（事实一致跳过重复写）；closurePersisted 如实返回；嵌套 endTick 仍有界关窗
- [x] V1：performTreasuryFullReset 来源必备——配对一致性前置（伪造断点保持既有口径）；oracle 断点缺 eventBranch（含普通数组通道）拒；显式旧 memorySnapshot+oracle 拒；非 oracle 不受限；kernel 面不宣称 exact；F17 调用点等价迁移
- [x] 跨用例污染治理：resetTreasuryCoreStoreForTest 清模块级生命周期事实（否决标记跨同 Game.time 用例残留——30 处误红由此修复）；G02 断言等价重组（closurePersisted 字段）
- [x] I01–I10/I13 矩阵（VKernel 11 + VService 8：含成本四 fixture 实测）；I11/I12 由既有 G/H/F/C 套件全量回归承担；I14 负向变体两件套（R1 晚关窗→I01/I03 红、V1 删校验→I07/I08 红；还原 11/11、8/8 绿）；I15/I16 由最终验证与主报告承担
- [x] 取证修订：上轮 attribution-probe.ts 转 .txt 非执行归档（README 注明二分依据；历史不改写）
- [x] Agent 本地验证：typecheck/build/Treasury/Defense 冻结集合/全仓/budget（见 evidence/core-rewrite-iv-remediation-v/final）
- [x] 独立审查（2026-09-07 Agent 独立验收结论 **ACCEPT**：八项全 PASS——基线反例在 fb5e44b 干净 worktree 独立复现且红灯行号/细节与归档日志一致、R1/V1 逐行核对、I 矩阵断言抽查非空转、19/19 定向复跑、负向变体红→还原绿、git/验证纪律与取证修订闭合；内核候选版不自动升级为部署许可）
- 下轮待办（独立验收 CONCERN，低危）：VKernel I02 的 `activeBefore + 1 - 1` 冗余写法清理（断言有效，纯风格——涉可执行文件须随下轮验证）；evidence 树历史源码存档（如 treasuryR4BaselineReplicators.baseline.ts 依赖后缀约定不被收集）统一归档策略
- 观察（非本轮范围）：H18（IVKernel）的手工满载记录 outcome=null/closing 无 outcomeEvidence 不满足结构校验（store unhealthy）——其断言（unknown 保留/释放≤4/失败义务不删）在 unhealthy 下仍成立但部分为空转；下轮应改用合法记录形状获得非空转覆盖
- 观察（非本轮范围）：facade 旧栈 beginTick 不接线 releaseExternalConsumer 时，经 kernel 面接纳的消费者义务在 service 面清理中不释放（端口缺失保守保留）——与生产装配的差异仅测试可见

## Core Rewrite IV · Remediation IV（2026-09-06）

- [x] R1：独立 endTick 取得与 beginTick 同一推进所有权；嵌套 endTick 只关窗；尾部预算 max/游标现读写回
- [x] V1：删除公共 runWithInvocation；新增 executeTreasuryAdmittedDispatch 许可直连包装（身份/参数取自实际许可）
- [x] V2：marker 携带捕获来源 journal、adapter 暴露 journal；performTreasuryFullReset 恢复前核实来源关联
- [x] V3：宿主结果计划 + 同参数父子 + 结果写回前断点 + 完整 reset 恢复闭环（H15/H16）
- [x] H01–H18 矩阵（IVKernel 10 + IVService 12 + 重现器 3）；H19 全仓验证；H20 负向变体三件套
- [x] 旧 G 修订：G14 重组（错配→错误配对拒绝、嵌套→真实 adapter 嵌套）、G15 改名普通 rearm 回归、G02/G11 映射说明
- [x] 28 个 runWithInvocation 调用点迁移（III/IIService、IService）
- [x] evidence：baseline（三反例+轨迹）/final（固定验证 HEAD）/negative-variants（三变体红+还原绿）
- [x] 独立审查（2026-09-07 Agent 独立验收结论 ACCEPT；内核候选版不自动升级为部署许可）
- [x] ~~下轮待办（独立验收 CONCERN，低危）：performTreasuryFullReset 对"service 面 + 断点无 eventBranch + adapter 暴露 journal"组合明确拒绝~~（已由 Remediation V/V1 关闭：缺分支一律在对账前拒绝，I07 验收）

## Core Rewrite IV · Remediation III（2026-09-06）

- [x] 影响范围侦察（subagent：R1/R2 波及 kernel.ts 清理循环+commands advanceCleanup；V1/V2 波及 treasuryExactOracle/treasuryResetHarness 与 Remediation I/II service 测试调用点；cleaned 断言全为宽松 >=1）
- [x] 基线反例（干净 worktree 3f4e701，exit=1）：R1 重入轨迹 [D0,D1,D0,D1]、remaining 卡 [D0]、预算 8；R2 {ok:false} → retry_ready；V1 恢复 B0 借 B1 效果 committed；V2 同参数 A/B 事件全归 B（evidence/core-rewrite-iv-remediation-iii/baseline）
- [x] R1：模块级生命周期 guard（重入零推进/endTick 关窗保持）+ 当前义务逐项选择确认（现读 remaining、预扣绑定成员、按单位确认、批末 released[] 删除）+ triedKeys 防同访问重复 + 预算耗尽停在耗尽处（D19 防空转饿死回归修复）
- [x] R1 游标：advanceCleanup 集合缩小重定位到同一下一待服务成员（基于记录现值，无对应关系保守保留）
- [x] R2：严格成功（returned === true；对象/包装布尔/Promise/thenable/getter 不释放不读取）
- [x] V1：断点携带 journal.captureBranch() 不可变事件副本；harness 安装断点后 reopen 从副本重开独立分支（封闭视图 baseLength∪epoch；废弃分支不因 cut 增大重现）
- [x] V2：runWithInvocation 受控调用作用域（许可身份+参数逐次核对；无作用域/不匹配 unlinkedCalls 诊断不归属；嵌套栈/异常弹栈/reset 清空）
- [x] 旧测试迁移：IIService/IService 调用点（registerAttempt/recordCut/startBranch → runWithInvocation/captureBranch）；F06/F08 cursor 断言改下一待服务成员语义（§7.4 不保旧数字）
- [x] G01–G18 矩阵（treasuryRemediationIIIKernel 16 + treasuryRemediationIIIService 16；G03 修订为逐 tick 全注入——单 tick 只触达前 4 种返回值）；G19 由最终验证流程承担；G20 负向变体四件套（R1 guard 失效/R2 truthy/V1 不 reopen/V2 忽略参数核对）行为红+还原绿
- [x] Agent 本地验证：typecheck/build/Treasury/Defense 冻结集合/全仓/budget（见 evidence/core-rewrite-iv-remediation-iii/final）
- [ ] 独立审查（本轮交付后由独立 Agent 执行——本地验证不构成放行）

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

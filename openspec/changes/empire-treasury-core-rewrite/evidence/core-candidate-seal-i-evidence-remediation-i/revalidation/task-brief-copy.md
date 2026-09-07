# Empire Treasury — Core Candidate Seal I · Evidence Remediation I
## 无损风险快照、逐检查点实证核验与原始复验归档

**用途：交给开发 Agent 直接实施测试侧补修、验证、归档、commit、push。本文件自包含，无需读取此前聊天。**

编制日期：2026-09-07。状态：**待执行的封板证据补修，不是完成报告或部署许可。**

**任务身份：Core Candidate Seal I · Evidence Remediation I；验收索引 L01–L08。**承接 Seal I（K01–K08）的审查结果 `EVIDENCE_INCOMPLETE`；不是 Remediation VII，不是 Core Rewrite V，也不是让你重复确认原 Seal I 的 ACCEPT。

> 本轮只有三项工作：V1 保留原始风险字段的存在性与取值；V2 对每个检查点的实际风险快照重新核验，而不信任"已检查／无差异"标签；V3 补齐新的固定提交、第二干净执行上下文的原始复验产物。生产内核继续冻结。

---

## 1. 固定起点、继承结论与边界

| 项目 | 本轮基准 |
| --- | --- |
| Repository | `ceyirelehe47/screeps-bot` |
| Branch | `refactor/empire-treasury-rearchitecture` |
| 编制时重新核对的远端 HEAD／实施起点 | `7c790712315c0cdde75a262e62b7d728b86a5ed8` |
| 生产冻结基线，继续保留 | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| Seal I 最终验证 HEAD | `62d645743ac986b9f405cdfebb055e6d171c1d9b` |
| 当前预算引用锚点 | `046e4c06cc442b39b4f05ca48d2c604925c198e1` |
| 当前预算／上轮 Agent 提交的全仓结果 | 236 suites／1417 tests／1417 passed；failed、pending、todo、runtime errors 均为 0 |
| 上轮 Agent 报告的定向结果 | KEY 5 suites／54 tests；Treasury 32 suites／571 tests；Defense 冻结集合 11 suites／118 tests |
| 上轮主构建最终文件 SHA-256 | `b2999d8c2bc5ac898b1b7bcc305e4a5573a10b18424f646bbf4e7361c7017566`；仅作历史追溯 |
| OpenSpec | `openspec/changes/empire-treasury-core-rewrite/` |
| 当前证据模块 | `test/mock/treasurySealEvidence.ts` |
| 满载主用例 | `src/runtime/treasury/treasuryRemediationIVKernel.test.ts` 中 H18／J06 及 Seal I 敏感性用例 |
| 预算及校验器 | `test/test-suite-budget.json`、`scripts/verify-jest-budget.mjs` |
| 生产限制保持 | active 64；recent ring 128；核心 JSON 字符预算 360,000；生命周期每 tick 8 份逻辑预算；每项外部释放成对预扣 2 份，实际释放每 tick 至多 4 次；每记录最多 8 项消费者义务；worstCase 最多 12 腿；fresh 限额不变 |

编制时已重新读取分支、预算、验证锚点、风险提取函数、完整性检查尾部及 `revalidation/` 目录。[S1–S6] 上表测试数来自 Agent 已提交的运行证据，**不是文档编写方独立重跑的结果**。本轮反例来自源码审查，须由实施者实际运行确认，不把任务书描述充当已经执行的实验。

若远端已前移，先检查增量并记录真实起点，沿最新历史继续；不要退回上述 SHA，也不要重复修改后来已经修正的问题。生产冻结基线与实施起点、最终验证 HEAD、预算锚点分别记录，不混用。

### 1.1 当前结论不能被改写

**继续保留：**Remediation VI 的持久关窗与健康满载恢复已经通过限定实现审查；Seal I 未确认新的生产阻断缺陷，生产冻结保持；完整轨迹采集、独立深快照与新的运行记录已经存在。

**尚未完成：**风险提取把若干缺失字段转成 null；检查器能够跳过缺失的风险证据，也不重算中间快照；第二工作树目录虽有 reviewer 记录与轨迹，但原始测试输出未完整归档。当前状态为 `EVIDENCE_INCOMPLETE`，不是生产功能全部 FAIL，也不是 `SEALED_CANDIDATE`。

不得改写旧 ACCEPT 或删除旧日志。新增勘误明确旧结论的范围；不得宣称 reviewer 从未运行、生产已发生风险漂移或经济动作已重复执行，因为这些并未被本次审查证明。

### 1.2 变更范围

| 层面 | 本轮允许 |
| --- | --- |
| `test/mock/treasurySealEvidence.ts` | 无损提取、比较、逐检查点核验的最小修复；必要的错误定位和测试专用输出 |
| H18／Seal I 敏感性用例 | 补原始记录入口反例、真实轨迹隔离副本反例及合法对照；沿用现有主用例 |
| 其他测试侧文件 | 仅为上述补修与原始证据核验所需的最小辅助，不建立第二套回放／证明平台 |
| OpenSpec、证据、预算元数据 | 按实际变更与运行结果更新 |
| 生产 runtime、类型、状态转移、许可、存储、覆盖判断、oracle 装配 | **默认零源码差异**；不修改生产 testHarness，不解冻 kernel／facade |
| 构建配置、依赖与 lockfile、默认 Jest 收集、protected／Defense 集合 | 保持不变 |

**不新增生产持久字段、永久证明 store、第二套许可／余额／关闭权威；不扩容或扩大预算；不放宽生产 validator；不为美化代码清理历史工程。**证据格式由实现者选择，只固定下文的行为语义，不要求新增通用序列化 schema。

**不部署，不运行 `npm run push`／`npm run local`，不合并 main，不调用真实 terminal.send／Game.market／lab／factory／nuker／carrier 等经济 writer，不读取玩家 Memory 或凭证。**本文件允许的是 Git push。Defense 生产行为继续冻结。

若复验出现新的、可运行的生产安全或活性反例，保存未修改版本的反例、对照与轨迹并单独报告；不要把本轮证据工具问题作为解冻生产的理由，不悄悄扩大任务。本轮支持模型仍是受控同步效果世界、选定持久状态保留后的运行时重建，不证明真实 driver 非原子窗口、任意旧备份回滚、整份 Memory 丢失或实际 Screeps CPU，不声称数据库式 exactly-once。

---

## 2. V1：原始风险事实经提取、序列化后不得丢失差异

### 2.1 现有缺口与基线反例

固定起点的 `sealUnknownRiskOf()` 对 identity、worstCase、invocationBoundary、invocation、external、outcomeEvidence 使用了 `undefined → null` 转换。[S4] 当前敏感性用例却在**已经提取好的快照**上删除 invocation，再直接调用比较器，绕过了提取阶段。

必须先运行以下反例：

```text
从健康 H18 fixture 取得一条原始 unknown 记录，invocation 显式为 null
→ 对原始记录集合生成独立基线
→ 深复制原始记录集合，在副本中 delete 该记录的 invocation
→ 对这个"原始记录副本"调用 sealSnapshotUnknownRisk
→ 再调用 sealCompareUnknownRisk
```

当前源码预期把缺失又填成 null，返回空差异。修复后的断言必须识别对应 attempt 和 invocation 的存在性差异。**这是隔离的证据工具测试，不把被故意破坏的 fixture 送入生产后继续执行，也不要求生产 validator 放行它。**

对 external、outcomeEvidence 的基线 null 做同类入口测试。对非 null 的调用边界／identity／worstCase，保留删除或合法值变化的必要对照。不要只扩大底层 `sealDeepDiff` 的测试而仍绕过提取器。

### 2.2 最小实现契约

至少区分**字段不存在**和**字段存在且值为 null**。保留现有风险字段的实际取值和嵌套结构；不能用 null、空数组、零金额、缺省摘要等"修复"不可用输入。

存在性如何表达交给实现者：可以保留缺失键，也可以用测试内部的显式存在性表达；但必须在实际 JSON 导出／读取后仍可区分，且不会与合法原值混淆。不要实现支持任意 JavaScript 对象的通用序列化器；不可表示的异常输入可以明确报错／标记不可用，不能静默变成合法 null。

比较时须同时考虑存在性与值，不能仅遍历基线中恰好存在的键而忽略当前新增的风险字段。原始基线缺失所需风险事实时应明确拒绝建立"完整基线"，不能因为基线和当前都缺了同一事实就报告完整。基线按最初指定的 unknown ID 集合建立，只生成一次，与 Memory 脱离引用；任何检查点都不能重新从当前状态生成其"期望值"。

比较范围继续为已有语义：attempt／workKey、generation／parent、完整 identity、完整 worstCase 每腿、invocationBoundary／invocation／external、outcome／evidence／phase、消费者义务及归属。不得缩减白名单来消除红灯。沿用纯诊断字段的既有豁免；不要借本轮扩大豁免或让风险字段变成可变元数据。

错误应能定位 attempt、字段路径与存在性／取值差异。错误产物也须可序列化理解；不能让 `undefined` 在错误 JSON 中消失后，只剩一个无法解释的"通过／失败"标签。

### 2.3 必须保留的合法对照

未经修改的原始记录，重复提取、独立复制、JSON 往返、比较都应一致；合法 null 不应被当成错误。基线建立后修改原始副本不能改变基线。合法形状下修改一条 worstCase 金额、边界 tick 或 identity 摘要，应分别定位对应字段；ID、phase、记录数和腿数都不变。

本轮的完整证据路径是**原始记录 → 提取 → 深快照／JSON 往返 → 比较**。底层比较器单测可以保留，但不能冒充这条端到端测试。

---

## 3. V2：每个检查点必须用实际快照证明风险未变

### 3.1 三个固定反例

使用现有 H18 产生的一份完整真实轨迹作为合法底版；变体只作用于隔离副本，保持原件不变。先确认底版通过，再分别运行：

| 反例 | 仅改变的内容 | 修复后必须发生 |
| --- | --- | --- |
| A：风险证据整项缺失 | 某中间检查点的 `riskCheckedIds`、`unknownRisk`、`riskDiff` 变为 null；窗口、事件与终态不变 | 报告该检查点风险证据缺失，不能跳过 |
| B：实际漂移、标签仍报一致 | 中间检查点某 unknown 的 worstCase 单腿金额改变，ID／phase／腿数不变；覆盖标签完整，`riskDiff` 仍为 null，终态正确 | 从实际快照重算发现漂移，不信任标签 |
| C：中间报告差异、终态恢复一致 | 中间检查点保存非空风险差异，终态及其他检查点一致 | 不能因终态恢复而放行；原始快照与报告矛盾时也须报错，不能静默忽略 |

固定起点的函数只在 `riskCheckedIds !== null` 时检查覆盖，且不比较检查点 `unknownRisk`，中间 `riskDiff` 也未参与判定。[S5] 本轮先保存这些反例的实际结果，不据此断言历史真实轨迹已经发生漂移。

### 3.2 检查器必须核验的事实

**独立基线完整。**初始风险基线覆盖最初指定的 20 个 ID，并包含该比较契约要求的风险事实。不能从可修改的检查点标签临时改出更小的 expected ID 集合，不能把"缺记录"的占位内容当完整事实。

**每个应检查的检查点完整。**包括所有 observe／bounded／recovery 的重载后与推进后，以及最终 close 前后。实际风险快照必须存在、可解释并覆盖 expected ID 集合；键与记录的 exact attempt 归属一致。缺记录、null 快照、部分覆盖都应报出 checkpoint、stage／tick 和 attempt 等位置。仅有 `riskCheckedIds` 列表不等于有实际风险数据。

**逐点重算。**用检查点中的实际风险快照与初始独立基线逐字段比较。中间发生过风险变化，后面变回去也不能让这次保留性验收通过。终态同样要有实际内容支持，可以复用已核验的 post-close 快照，不强制重复保存一份终态风险数据。

**派生标签不能冒充原始证据。**若保留 `riskCheckedIds`、`riskDiff`，它们必须与实际重算结果一致；检查器不能只检查数量或只信任 `riskDiff=null`。注意：**`riskDiff=null` 可以继续表示"重算后无差异"，但它不是缺少 `unknownRisk` 的合法理由。**可精简冗余字段，但不得让原始风险快照变为可选，也不得让旧消费者继续依赖已删除的标签。

**纯核验，不自愈。**检查器不修改初始基线或输入轨迹，不自动补 null／缺字段，不从邻近检查点、当前 Memory 或终态补回缺失证据，不把失败轨迹改写为完成。缺失／矛盾时给出可定位的问题并拒绝。

保留现有窗口成对、次数、序号、事件计数、终态、失败标记及实际 closeWork 的检查。无需建设防恶意篡改的通用证据安全平台；本轮解决的是采集或归档错误不能被这个检查器误判为完整。

### 3.3 测试接线与格式边界

除 A／B／C 外，覆盖实际风险快照缺一个 ID、顶层可空字段被删除后经过落盘读取、最终标签与 post-close 内容不一致等直接相邻情形。合法底版、原值为 null 的记录、无漂移的全程轨迹必须正常通过，不能"一律报错"过关。

当前 `buildSyntheticSealTrace()` 的检查点允许 `unknownRisk=null`。修复后不能将这类合成底版继续叫作"完整风险证据"；要补合法风险内容，或把它明确用于欠缺证据的负向测试。不能为迁就旧合成 fixture 在检查器中加入 synthetic／test-name 特判。

完整性／风险敏感性测试须调用真实被使用的检查入口。对一份**先写入文件、再 JSON 读取**的本次合法产物也做核验，证明导出没有消除存在性或差异；未设置导出变量时所有普通断言仍执行。

证据格式尽量沿用已有表示。若不可避免地调整测试侧表示，明确其版本与读取规则，旧证据保留历史身份；不能默默把缺字段的旧报告补成新证据。主运行与 reviewer 必须使用同一固定提交的实现及其新生成的产物。

---

## 4. V3：第二执行上下文必须交付原始结果

### 4.1 旧结果如何处理

原 `core-candidate-seal-i/revalidation/` 有 README、reviewer-log 和轨迹目录，但未见对应完整原始测试输出。[S6] 不据此推断 reviewer 未运行，也不删除旧记录。

若原 KEY／Defense 输出仍在，可以按原 SHA、运行时间与来源补交为**历史复验产物**。若已丢失，注明无法补回；不得按摘要重造旧 stdout 或 Jest JSON。由于本轮会修改测试代码，**无论旧文件能否补回，都须对新的固定提交重新完成第二上下文复验**；新运行不能写成发生于旧 `62d6457…` 的原复验。

### 4.2 新复验的最小完整交付

未参与补修的 reviewer/subagent，优先在新 `VALIDATION_HEAD` 的独立干净 worktree 实跑。把**这份完整任务书或逐字副本及其内容 hash**交给它，记录读取位置；不能只给实施者的 K/L 勾选摘要。无需追补或虚构上一位 reviewer 当时读过什么。

每项实际命令保存：完整参数、执行目录与 SHA、Node/npm、退出码、原始 stdout/stderr、生成的原始 Jest JSON（适用时）。KEY 和 Defense 的命令必须列出真实完整文件路径，不以"跑五件／十一件"取代。轨迹核验保存实际输入文件、内容 hash、所用已提交检查器版本、命令和原始输出。

**最低复跑内容：**生产／配置／Defense 冻结检查；typecheck；本轮工具敏感性与 H18 所在套件；既有 KEY 五文件；Defense 冻结十一文件；对其自己新导出的 H18 文件执行落盘后核验。可以合并重叠的测试集合，但报告须映射实际收集，不能把五件报告重复累加成更多测试。

第二 worktree 使用独立输出目录和 Jest cache，不共享可写源文件或 fixture 状态；依赖下载缓存可共享。运行前后工作树干净，原始产物写到仓库外，**所有验证结束后才归档到交付树**。不要重复上轮"验证途中开始归档，最后才移出去重查"的流程。

如果没有独立 reviewer 能力，仍完成同提交的第二干净 worktree 实跑，但标明"同执行者第二工作树复现，独立审查属性未满足"。缺工具／环境时交付已完成部分并写清未运行项，不复制主运行日志，不默认创建新 CI。

### 4.3 产物必须相互对应

原始 Jest JSON 应是可直接解析的结果文件，不是混入 console 的文本；由真实 `--outputFile` 生成。JSON 总数、逐文件状态、失败／pending／todo／runtime error 与该次原始日志一致。多个运行各有目录，不能用同名覆盖；摘要从本次原件得到。

主验证、预算脚本自带重跑、reviewer 复验是不同运行，分别标注。若 budget 的临时 JSON 按原脚本正常清除，不为此修改校验器功能；保留其完整原始日志与退出码，且主验证／reviewer 的 Jest JSON 必须另行完整保留。

hash 用于产物身份和完整性，不证明断言正确。当前构建嵌入时间与 Git 身份，不要求不同构建与上轮同 hash；每次实际 build 各自记录。不能仅因生产零 diff 就声称所有测试产物都相同，也不凭 hash 差异断言生产逻辑变化。

---

## 5. 原 H18 的责任与限值保持

沿用 30 closing ×3 义务、20 unknown、10 retry_ready、4 pending 的 64 条混合 fixture，保留持续失败项、真实清理、完整 JSON 重载、最终合法 `closeWork`。不要复制一个更容易通过的新 H18 取代现有测试。

继续导出初始独立基线、全部 12 个观察窗口、全部实际追加窗口、失败恢复及最终关闭。每阶段检查健康、份额、实际释放、风险事实，成功义务不能再次调用；unknown 留存与其责任字段一起验证。实际数字从事件与持久状态采集，不能硬编码上轮的 54 检查点、96 次事件、13／1 窗口或 21,879 字符作为伪造产物。

40／10 是现有固定 fixture 的回归测试限值，**不是一般调度完成时间上界**。不改其数值、不放宽现有有效断言；文字与当前边界比较保持一致。发生同 tick 内先失败、后恢复端口时，按实际事件顺序说明，不能用"tick 必须严格更小"的文字替代真实调用先后。该表述修订不是新调度机制。

新的风险核验必须在本次真实完整轨迹上通过，并能对其隔离副本中的缺证据／漂移给出准确失败。测试失败时保留已采集轨迹，明确 incomplete 与失败位置，不在 finally 中补成功终态。

---

## 6. L01–L08 验收索引与执行顺序

| 编号 | 验收内容 | 必须实际证明 |
| --- | --- | --- |
| L01 | 原始记录入口的无损风险提取 | null→缺失在原始记录副本发生，经提取、JSON 往返、比较仍被定位；正常 null 与未变化记录通过；基线不随副本改变 |
| L02 | 检查点证据存在性 | 实际风险快照整项 null／缺失、少一个 unknown、仅有覆盖标签均不能通过；所有应检查点覆盖 expected 集合 |
| L03 | 逐点重算与标签一致性 | 实际金额漂移但标签报一致被抓住；中间非空 diff 不被正确终态掩盖；最终标签与实际 post-close 矛盾被拒；合法底版通过 |
| L04 | 真实敏感性与序列化路径 | 基线反例实际执行，错误来自行为而非编译／缺模块；变体从原始记录或真实轨迹隔离副本进入完整流程；落盘再读取仍能判断；输入未被检查器修改 |
| L05 | 真实 H18 全程证据 | 原规模／预算／限值不变；全过程健康与非零服务、风险逐点保留、真实退出；新完整文件核验通过，失败实验产物标为 incomplete |
| L06 | 生产冻结与固定主验证 | 相对869149d的生产／配置零差异；typecheck×2、build、KEY、Treasury、Defense、全仓、budget实际通过；全部执行改动在验证HEAD之前 |
| L07 | 第二执行上下文原始产物 | 新固定SHA、独立目录、完整任务读取记录、KEY／Defense原始日志＋Jest JSON、自己的轨迹及核验输出；身份独立性如实标注，不只交摘要 |
| L08 | 交付状态与历史范围 | 原功能通过不撤回，旧证据保留勘误；新旧锚点／运行／hash对应；实际未完成项明确；不授予部署许可 |

读取本文件后，先报告精确文件路径、标题、分支／HEAD、L01 与 L03 要验证的行为，然后直接实施，不等待再次授权。

**先基线、后补修、再新固定提交复验。**在干净起点上运行 V1 原始记录反例和 V2 A／B／C，保存合法对照及原始红灯。原始完整轨迹可由本轮基线定向运行生成，不需要为了取得文件而重跑旧全仓。若某反例实际不成立，提交最小可运行反证，不修改生产来制造红灯。

修复测试工具及用例后，用相同反例核验目标修复。已有"仅 heap 关窗／健康零推进"的生产负向变体不是这次缺口的替代证明；默认保留其 Seal I 历史结果，必要正常回归仍重跑。本轮不为凑矩阵再新增生产故障模型。

---

## 7. 交付目录与版本纪律

继续使用原 OpenSpec；本轮新证据根目录：

`openspec/changes/empire-treasury-core-rewrite/evidence/core-candidate-seal-i-evidence-remediation-i/`

| 位置 | 内容 |
| --- | --- |
| `task/` | 本任务完整原文或逐字副本、内容 SHA-256、实施者与 reviewer 的读取记录 |
| `baseline/` | V1／V2 的反例源码或非执行 patch、输入来源、起点 SHA、真实命令／退出码／日志；合法对照 |
| `freeze/` | 原生产冻结基线、实施起点、新验证 HEAD、完整差异清单与分类、零生产／配置差异输出 |
| `final/` | 主运行原始日志、Jest JSON、完整新 H18 轨迹、落盘核验结果、环境／hash／状态 |
| `revalidation/` | 第二工作树各项原始命令、退出码、日志、KEY／Defense JSON、自己的轨迹与核验结果、reviewer身份及任务读取记录 |
| `negative-controls/` | 对原始记录／完整轨迹的隔离坏副本、敏感性输出、还原后合法对照；不冒称生产漏洞 |

主报告使用 `evidence/core-candidate-seal-i-evidence-remediation-i-local-validation.md`；`tasks.md` 与 `test-migration-map.md` 新增 L01–L08，说明旧 null 敏感性只测比较器、旧完整性检查缺原始核验的覆盖差异。`design.md` 仅必要勘误，不再追加生产生命周期设计。

格式、内部 helper、是否按运行分文件由实现者决定。可以分片便于读取大轨迹，但必须有完整索引且不丢检查点；不要求新压缩协议、数据库或永久遥测。旧 `.ts.txt` 归档方式本身不是阻断项，不花本轮清理历史文件。

所有新测试、测试辅助、可运行核验脚本及预算常量都必须先提交，再固定 `VALIDATION_HEAD`。运行结果输出在仓库外；验证及 reviewer 运行全部结束后再把原始产物归档。**验证后只有日志／数据／说明／非执行 patch 可追加；任何可执行改动都必须重新固定并验证。**

预算取真实全仓结果，236／1417 仅为追溯基线，不要求维持或增加某个数量。不要给提交填其自身未知 SHA；预算锚点按既有规则选已存在代码／测试提交，验证 HEAD 与最终交付 HEAD另行记录。

---

## 8. 验证模板与 Git 推送

### 8.1 起点与安全准备

```bash
git fetch origin
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/refactor/empire-treasury-rearchitecture
git log --oneline --decorate -40
```

不 reset 已推送历史、不 rebase、不 force push、不 amend 已推送提交、不合并 main、不覆盖其他未提交工作。基线／敏感性实验使用隔离 worktree。缺依赖按原 lockfile 安装；不升级依赖、不改 lockfile。检查环境未设置部署目标，禁止读取部署凭证。

### 8.2 主验证（Bash／Git Bash）

完成并提交全部执行性变更及预算元数据后运行。下面沿用现有五个 KEY 文件；若新增了工具自测文件，必须加入真实路径与对应运行命令，不用未加载的测试名称冒充覆盖。

```bash
set -euo pipefail
unset DEST
FREEZE_BASE=869149dcdd6f2068572354917bf23c52727cf9b6
START_HEAD=7c790712315c0cdde75a262e62b7d728b86a5ed8
VALIDATION_HEAD="$(git rev-parse HEAD)"
EVIDENCE_TMP="$(mktemp -d)"
printf '%s\n' "$FREEZE_BASE" > "$EVIDENCE_TMP/freeze-base.txt"
printf '%s\n' "$START_HEAD" > "$EVIDENCE_TMP/expected-start.txt"
printf '%s\n' "$VALIDATION_HEAD" > "$EVIDENCE_TMP/validation-head.txt"
pwd > "$EVIDENCE_TMP/workdir.txt"
node --version > "$EVIDENCE_TMP/node-version.txt"
npm --version > "$EVIDENCE_TMP/npm-version.txt"
git status --porcelain > "$EVIDENCE_TMP/status-before.txt"
test ! -s "$EVIDENCE_TMP/status-before.txt"

run_logged() {
  local name="$1" rc
  shift
  printf '%q ' "$@" > "$EVIDENCE_TMP/$name.command.txt"
  printf '\n' >> "$EVIDENCE_TMP/$name.command.txt"
  if "$@" > "$EVIDENCE_TMP/$name.log" 2>&1; then rc=0; else rc=$?; fi
  cat "$EVIDENCE_TMP/$name.log"
  printf '%s\n' "$rc" > "$EVIDENCE_TMP/$name.exit-code.txt"
  return "$rc"
}

git diff --name-status --no-renames "$FREEZE_BASE" "$VALIDATION_HEAD" \
  > "$EVIDENCE_TMP/changes-from-freeze.txt"
run_logged production-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  src ':(glob,exclude)src/**/*.test.ts' ':(glob,exclude)src/**/*.spec.ts'
run_logged config-freeze git diff --exit-code "$FREEZE_BASE" "$VALIDATION_HEAD" -- \
  package.json package-lock.json rollup.config.js tsconfig.json tsconfig.build.json jest.config.cjs

run_logged typecheck npx tsc --noEmit -p tsconfig.json
run_logged typecheck-build npx tsc --noEmit -p tsconfig.build.json
run_logged build npm run build

test -f dist/main.js
node -e 'const fs=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(fs.readFileSync("dist/main.js")).digest("hex")+" *dist/main.js")' \
  > "$EVIDENCE_TMP/bundle-sha256.txt"

KEY_FILES=(
  src/runtime/treasury/treasuryRemediationIVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVIKernel.test.ts
  src/runtime/treasury/treasuryRemediationIVService.test.ts
  src/runtime/treasury/treasuryRemediationVKernel.test.ts
  src/runtime/treasury/treasuryRemediationVService.test.ts
)
for file in "${KEY_FILES[@]}"; do test -f "$file"; done
printf '%s\n' "${KEY_FILES[@]}" > "$EVIDENCE_TMP/key-files.txt"

export TREASURY_SEAL_EVIDENCE_DIR="$EVIDENCE_TMP/trace-key"
mkdir -p "$TREASURY_SEAL_EVIDENCE_DIR"
run_logged jest-key npx jest --config jest.config.cjs --runInBand \
  --runTestsByPath "${KEY_FILES[@]}" --json --outputFile="$EVIDENCE_TMP/jest-key.json"

export TREASURY_SEAL_EVIDENCE_DIR="$EVIDENCE_TMP/trace-treasury"
mkdir -p "$TREASURY_SEAL_EVIDENCE_DIR"
run_logged jest-treasury npx jest --config jest.config.cjs src/runtime/treasury/ \
  --runInBand --json --outputFile="$EVIDENCE_TMP/jest-treasury.json"

DEFENSE_FILES=(
  src/runtime/defenseFocusFire.test.ts
  src/runtime/defenseFocusFireStateful.test.ts
  src/runtime/defenseFallbackReallocation.test.ts
  src/runtime/defenseAllActorReservation.test.ts
  src/runtime/defenseGlobalRampartFootprints.test.ts
  src/runtime/defensePreallocationRampartOwnership.test.ts
  src/runtime/defenseStationaryRampartOwnership.test.ts
  src/runtime/homeDefense.test.ts
  src/runtime/towerControl.test.ts
  src/roles/homeDefender.test.ts
  test/memoryDeclarationBoundaries.test.ts
)
for file in "${DEFENSE_FILES[@]}"; do test -f "$file"; done
printf '%s\n' "${DEFENSE_FILES[@]}" > "$EVIDENCE_TMP/defense-files.txt"
run_logged jest-defense npx jest --config jest.config.cjs --runInBand \
  --runTestsByPath "${DEFENSE_FILES[@]}" --json --outputFile="$EVIDENCE_TMP/jest-defense.json"

export TREASURY_SEAL_EVIDENCE_DIR="$EVIDENCE_TMP/trace-full"
mkdir -p "$TREASURY_SEAL_EVIDENCE_DIR"
run_logged jest-full npx jest --config jest.config.cjs --runInBand --json \
  --outputFile="$EVIDENCE_TMP/jest-full.json"
export TREASURY_SEAL_EVIDENCE_DIR="$EVIDENCE_TMP/trace-budget"
mkdir -p "$TREASURY_SEAL_EVIDENCE_DIR"
run_logged budget node scripts/verify-jest-budget.mjs

run_logged diff-check git diff --check
printf '%s\n' "$(git rev-parse HEAD)" > "$EVIDENCE_TMP/head-after.txt"
test "$(git rev-parse HEAD)" = "$VALIDATION_HEAD"
git status --porcelain > "$EVIDENCE_TMP/status-after.txt"
test ! -s "$EVIDENCE_TMP/status-after.txt"
```

另保存**实际落盘轨迹的核验命令与输出**，调用本轮已提交的核验实现；不只在 README 勾选通过。核对所有 JSON 均能解析，测试确实收集且无 failed／pending／todo／runtime errors。保留原默认收集与所有保护集合；不新增 skip／only，不靠测试改名漏收集。完整全仓中实际重跑的历史压力如实记录，不照抄旧次数。

冻结检查还须分类 review `scripts/`、`test/` 等差异，防止把生产逻辑搬进排除路径来制造零 diff。Defense 七个生产文件单独核对零差异。

### 8.3 第二干净 worktree

```bash
REVIEW_PARENT="$(mktemp -d)"
REVIEW_DIR="$REVIEW_PARENT/worktree"
REVIEW_OUT="$REVIEW_PARENT/output"
mkdir -p "$REVIEW_OUT"
git worktree add --detach "$REVIEW_DIR" "$VALIDATION_HEAD"
```

reviewer 在该目录重新核对 SHA、干净状态与本任务内容，按原 lockfile 准备依赖，使用独立 cache／输出目录执行 §4.2。沿用上述 `run_logged` 方式，但日志与 JSON 输出到 `REVIEW_OUT`，不得指向主运行文件。落盘轨迹核验与所有新增工具自测同样保存原始输出。

第二运行完成前不归档回其工作树。若环境失败，失败原件保留、该项标记未完成；不能只写一张成功表格。主验证、第二运行、基线与负向检查的来源和退出码分开。

### 8.4 归档与推送

全部验证完成后归档证据、更新分层结论，再执行：

```bash
git diff --name-status "$VALIDATION_HEAD" HEAD
git diff --check
git status --short
git log --oneline --decorate -40
git push origin refactor/empire-treasury-rearchitecture
git ls-remote origin refs/heads/refactor/empire-treasury-rearchitecture
```

验证后新增可执行改动必须重新固定提交复验，不能因位于 evidence 下豁免。最终工作树干净；不提交依赖目录、缓存、凭证或真实玩家数据。查询验证提交 combined status／check-runs 和分支 Actions；空检查表示没有 CI 证据，不是 CI PASS。

---

## 9. 完成定义与停止条件

最终回复分别报告：

**生产状态：**既有两项功能修复继续沿用限定通过；相对冻结基线是否零生产／配置／Defense 差异。没有新生产反例就不改写内核。

**证据工具：**V1 原始字段差异不再被提取抹平；V2 每检查点实际风险存在且经独立基线重算，缺失／中间漂移／标签矛盾均被敏感性测试抓住；原始合法轨迹仍通过。

**运行取证：**L01–L08 的真实位置、命令、原始结果、新固定 HEAD、预算锚点、最终交付 HEAD；主运行与第二上下文各自的日志／JSON／轨迹／核验输出，以及 reviewer 的实际身份和任务读取记录。

**封板层级：**所有目标通过时报告"本轮证据补修完成，候选证据提交独立审查"；任何未补齐项仍写 `EVIDENCE_INCOMPLETE`。不得仅凭 Agent ACCEPT 代替审查，不因本轮交付自动宣称允许部署。

**部署边界：**本轮不授予部署许可，不接真实 writer，也不自动进入真实引擎适配。完成上述三项后停止，不启动新的功能补修、回放平台或架构工程。

---

## 附录：固定来源与代码定位

以下仓库内容均锁定实施起点 `7c790712315c0cdde75a262e62b7d728b86a5ed8`。按 SHA 与路径即可核对，不依赖聊天或旧任务附件。

| 编号 | 来源 | 用途 |
| --- | --- | --- |
| S1 | 分支最新 commit | 编制时确认仍为7c79071起点 |
| S2 | `test/test-suite-budget.json` | 编制时确认236／1417与046e4c0预算锚点 |
| S3 | `openspec/changes/empire-treasury-core-rewrite/evidence/core-candidate-seal-i/final/validation-head.txt`及主报告 | 确认62d6457验证锚点；历史结果为Agent提交证据 |
| S4 | `test/mock/treasurySealEvidence.ts`：sealUnknownRiskOf、sealSnapshotUnknownRisk、sealCompareUnknownRisk | 编制时重读undefined→null与实际比较路径 |
| S5 | 同文件：sealVerifyTraceCompleteness | 编制时重读riskCheckedIds的null跳过、中间风险不重算、terminal判定 |
| S6 | `evidence/core-candidate-seal-i/revalidation/`及reviewer-log.md | 编制时目录为README、reviewer记录和trace-key；区分记录与原始测试输出 |
| S7 | `src/runtime/treasury/treasuryRemediationIVKernel.test.ts`：H18／J06、buildSyntheticSealTrace、Seal I敏感性用例 | 原始记录与已提取快照的不同测试入口；全程轨迹及既有规模 |
| S8 | `package.json`、`rollup.config.js` | build与游戏push/local区别；时间与Git构建身份导致hash不能直接判逻辑差异 |

Defense 冻结生产文件：`src/runtime/defenseFocusFire.ts`、`src/runtime/engagementFallbackRevision.ts`、`src/runtime/defenderRampartAllocation.ts`、`src/runtime/homeDefense.ts`、`src/runtime/towerControl.ts`、`src/runtime/physicalRampartOwnership.ts`、`src/roles/homeDefender.ts`。

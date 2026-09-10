# Treasury Legacy Read Bridge I — 最小兼容候选

## 这份候选做什么

此分支以已经识别的线上源提交 `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c` 为基础。保留原38个主循环阶段及原业务源文件，只在末尾库存影子检查后、原 profiler.flush 前增加 `treasuryCompatRead`。默认关闭，不配置 Memory 开关，不主动部署。

本轮没有把当前整个 Treasury facade/kernel/lifecycle 接进旧 bot。复用的是 `01bd9831454950c4928df98dd8679692b55603e5` 中原有 `buildTreasuryObservation` 与 `buildTreasuryCommitmentIndex` 及其8文件运行依赖闭包。前者直接从 Game room Store 建立快照，后者按既有 canonical 规则读旧任务与预留。两份生产函数的语义未重写。

完整 facade 只读观察器仍留在主开发分支，保持已经通过的离线身份。本桥是它进入旧生产基础之前的更窄兼容检查，不伪装成完整 facade.query，也不假造 kernelJournal。

## 不拥有的能力

没有 beginTick/endTick、注册 policy/adapter、授权、发送、结算、迁移、清理、世界序递增或新的持久 Memory 根。报告恒 authorizesActions=false，spendable=null，facadeQueryRun=false。不把 observed−outgoing−reserved 自行拼成可支出数字。

旧 bot 原有经济与防御照常运行，其既有 Memory 写入和 intent 不属于新桥的只读保证。报告也不代表未来国库已具备线上写入条件。

## 构建与来源

`treasuryCompatReadCore.generated.ts` 由包内装配器从本地 Git 的固定对象生成，CommonJS 转译只用于一个静态函数表。没有 eval、Function 构造器、网络加载或外部 require；闭包越过8文件白名单即拒绝。只暴露两个读取 builder，内部模块加载器不对外导出。

生成文件带 @ts-nocheck，是已转译代码而非手写算法。它不代替原 TS 源码的类型验证；原源的既有验证归属必须保留，新桥/装配及最终候选需要独立验证。完整来源、原始 blob/SHA256、依赖关系、编译器版本与输出摘要在 `docs/treasury-compat-source-manifest.json`。不得手改生成物。

原源文件中某些未调用导出（例如 world sequence bump）仍可能出现在转译文本中；本桥没有导出或调用它们，不能把“只有读取可达路径”写成“字节中从未出现写函数”。实际可达性及 Memory 零写由测试验证。

## 读取语义

最多2房间×4资源。输入分别标记 absent/empty/nonempty/invalid/over_bound。两个旧表必须都是可读对象且各不超过256项，才构建承诺索引；不截取前256项后冒充全表，不以 `{}` 替换缺失、数组或 null。损坏条目交给既有 canonical completeness 规则，不清除原数据。

旧写入者不维护新 commitment revision，因此每个采样重建隔离的读取模块缓存与索引，不跨采样复用。只保留上一份已输出的端点 primitive 快照；这不是另一份账本。

主报告的库存来自实际 Store；新 observation 使用原房间对象独立稀疏枚举，不能从刚生成的直接读数反向造输入。旧 `runtime.resourceControl` 仅在 updatedAt 与采样 tick 一致时比较容量和选定 energy；过期、缺失和未来 tick 明示不可比较。矿物的房间合计不冒充特定端点库存。

读取 `getCapacity()`，不硬编码Storage=1M或hub=8M。ID/容量改变后，不再沿用旧净变化基线。缩容后库存超过容量可见；保留负 free 或饱和零的原读数，不由 used+free 反造capacity。不推断具体 Power 效果、运输费用或资源操作归属。

看到已有 treasuryCore 只报告 present_not_interpreted/activeCount=null，不擅自判断其为空，不推进其生命周期。此桥只覆盖旧resourceControl.tasks及resourceReservations，其他市场/物流义务仍由原系统拥有。

## 范围与成本

默认每100tick，bucket≥2000，读取预算2 CPU且至少保留5 CPU。预算为协作式；同步调用、序列化和日志不能被中途抢占。下一份报告提供上次含输出的实际成本。每条最多16384 UTF-8字节，超限输出完整省略通知、不保留未输出的隐形基线。

启用必须给定startTick/endTick，跨度最多1200tick；过期直接停止诊断，即使heap reset也不会延长绝对窗口。此 tick 窗口不是墙钟90分钟的替代；实际线上发布仍须另设外部墙钟收尾与回退安排。新增故障只停用新桥，不吞掉旧业务错误。

## 状态

装配完成不代表测试通过，测试通过不代表已部署。候选验收应报告 `COMPAT_READ_CANDIDATE_VERIFIED / NOT_DEPLOYED` 或具体失败。之前当前主开发分支的248/1539不能当成本旧基线候选的全仓测试数字。线上行为与CPU仍需后续限定发布验证。

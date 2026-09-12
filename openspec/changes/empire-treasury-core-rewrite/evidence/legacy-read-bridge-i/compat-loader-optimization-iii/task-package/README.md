# Compat Loader Optimization III

本包是完整实现交付：Agent 只执行固定测试、应用、整仓检查、归档与普通推送，不负责补代码。

CPU Diagnostic II 已取得四份有效诊断并完成恢复；四点完整业务样本仍为0。后续三个样本的 readerLoad 区间分别约0.5945、1.6840、1.1415 CPU。本轮优先减少这一入口内的重复模块初始化，不同时改直接读取、不提高预算、不安排新的线上运行。

## 实现

在固定生成核心的 wrapper 中，首次成功建造后复用6个经逐体审查的定义模块：configNormalize、resourceTransferTaskHealth、holderResolution、observation、ownerIdentity、types。定义中的 Game/Memory 查询仍在调用时读取当前全局值，没有捕获首次样本的输入。

commitmentRevision 是可变模块状态，继续每样本独立。commitments 闭包依赖该 revision，且从 RESOURCES_ALL 建立校验集合，因此也继续每样本初始化。每次返回新的 builder wrapper，每次 build 都产生新 observation/index/指标对象；无按 tick/revision 复用数据的快捷路径。

首次初始化成功前不发布共享定义；失败不留下可被下一次使用的半初始化缓存。共享导出不暴露到公开API。首次加载仍发生在采样准入后、readerLoad预算区间内；没有预热、提前加载或从报告中扣除开销。

8个 factory 正文与原依赖边逐字节保持不变，只替换 loader 尾部。仓库内包含作者模板、确定性生成脚本和经原 Git blob 核验的基线夹具，可以重新生成并检查输出。原来源清单的sourceCommit、sourceManifest保留；generated输出条目及新增wrapper溯源明确区分原始模块与本轮包装层。

## 边界

首次成功建造仍执行8个factory，并增加一次有限缓存发布工作；后续每次从8个降到2个。连续12次：96→30次factory执行。该计数不是CPU耗时、不是整体性能提升百分比，也不解决首点directRead约1.9702 CPU的问题。

CPU I读取算法、诊断检查点、运行装配、配置、2 CPU预算和直接读取语义保持不变。treasuryCompatRead.ts和treasuryCompatTypes.ts只修正注释中的定义缓存/样本状态区别。既有三个Node spec不改；Jest wrapper仍是原来的一项测试，只加运行新46项Node用例，Jest预算仍195 suites/685 tests。

本轮无token参数、无Screeps客户端、无候选上传、无恢复写入、无新的窗口。GitHub读取和普通Git推送只用于代码与证据交付。

制作方验证范围见validation/maker-validation.json；Windows整仓结果必须由Agent取得。任务步骤见AGENT-RUN.md。

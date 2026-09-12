# Compat Reader CPU Attribution I · v2

完整实现、两份补丁、固定测试及 Agent 验证任务书。只修复上一版的仓库测试集成，不部署。

三份 CPU 生产源码与 v1 逐字节相同。新增允许变更只有 `test/treasury-compat/helpers.cjs`，为读取器增加精确的 `./treasuryCompatCpu` 沙箱依赖边；未知导入继续失败，不使用假模块或宿主 require 回退。
原 spec、Jest wrapper、195/685 预算不修改。预算仍2、默认OFF、窗口0、生成核心与每样本缓存生命周期不变。

`AGENT-RUN.md` 是唯一执行任务书。工具识别干净基线、精确 v1 三文件脏状态或精确 v2 状态；输入不明确时拒绝，不自动恢复或清理工作树。

内容：
- implementation/：三份原字节 CPU 源码及一份仓库测试helper。
- baseline/：四份真实旧版TS文件及原版helper，均由固定Git blob核验。
- references/repository-tests/：原版未修改bridge spec，制作方直接执行的回归依据。
- patches/：0001三源码补丁（原字节）、0002 helper补丁（本版）。
- tests/：91项固定测试，包含原缺陷负对照、41项原版bridge子进程和安全续接反例。
- tools/：完整前检、快照应用、测试、真实核心A/B、完整仓库检查、归档与暂存字节复核。
- validation/：本版验证原件；v1-history/只是旧制包记录，不表示旧全量检查通过。

临时Git夹具使用局部换行参数，不屏蔽真实Git配置。本版已在Linux上针对system/global均core.autocrlf=true的环境对照运行，不冒称原生Windows。

制作方运行了真实helper+未修改的41项bridge断言及91项固定测试。**没有运行完整仓库195/685、Rollup、整组真实核心A/B或原生Windows**；这些仍由Agent在真实工作树执行固定门禁，不是继续实现任务。

无Screeps客户端、token、线上观察或恢复。普通输出24→12计数减少不等于CPU减半；上轮2.4981476000029943的真实引擎缺口仍未解决，CPU子阶段诊断尚未在线执行。

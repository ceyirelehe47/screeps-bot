# Compat Reader CPU Attribution I · v2 Repository Integration

实现与离线验收完成；本轮无新线上实验，无候选上传，无恢复 POST。

v1 未通过真实仓库全量检查：既有沙箱缺少 ./treasuryCompatCpu 的精确导入适配。v2 不修改三份生产实现，不删除或改写历史失败结果。应用输入快照与此前失败现场保留在工作树外。

Compat: 3292e152b0db465263e4f1fa5c9eac068394acef → 43b1b8e51caca0c17b975971a71fbbb0951823bf
Refactor evidence base: 0b09414f90c7144bbff61758fe7cf605576231e7

实际修改：三个与 v1 字节一致的 CPU 源文件，以及 test/treasury-compat/helpers.cjs 的精确沙箱导入适配；既有 spec、Jest 包装器和 195/685 预算不变。配置仍 OFF，预算仍为 2；生成核心、每样本缓存生命周期、市场/物流/Treasury 内核不改。

测试使用真实读取器源代码和模型端口；real-core characterization 使用固定 Git 核心及合成 Room/Memory。Node wall clock 与模拟 CPU 都不是 Screeps CPU。普通输出 UTF-8 计数由两次降为一次，不代表首点 2.498 CPU 缺口已修复。

已有线上样本仍为 1 条 raw / 0 条完整。新阶段诊断尚未在线执行，阶段瓶颈、首次与后续采样差异及真实净开销仍未知。下一轮须先审查本包结果，再决定受控性能实验；本包没有授权 0004。

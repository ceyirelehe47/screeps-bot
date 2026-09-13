# Compat Build Optimization VII

完整实现与固定验证包；执行入口为 `AGENT-RUN.md`。基线为 compat@cdecde02ec7d364141d71f45bf21dc23969deff0、refactor@04ca086c3d62db5f506389bc59c3fb1bb4b81b66。

本轮不继续优化加载器。完整任务索引按 scope/room 融合私有存储，observation 去除 entries 二元组及临时房间复制；所有索引仍立即完整构建，reservation/owner/expiry 和独立 Store 读取保持。preview、CPU 检查点和默认 OFF 不变。实现保证域、可逆来源与语义等价验证的区别见新源码文档。

包内包括 11 文件 payload、可应用补丁、基线切片、固定测试、跨平台工作流和制作方记录。Agent 不需要写代码。固定源切片 181 tests＋21 workflow tests；真实仓库要求 200 Node tests＋195 suites/685 Jest tests、两套类型检查和 build-only。不同层级不可相加。

制作方验证由 Linux/Node v22.16.0/TypeScript 5.8.3/Git 2.47.3 执行。Room、Memory、CPU 端口及工作流临时仓库中的历史检查记录明确为合成；并非官方引擎或生产重放。用户完整仓库、原生 Windows 和引擎 CPU 未在制作方环境执行。

严禁连接 Screeps、使用 token、上传、恢复或打开下一窗口；GitHub 的基线读取和普通推送不在这个禁令内。所有任务包及原始失败证据保留。本轮成功也保持 ENGINE_CPU_BUDGET_GAP_UNRESOLVED。

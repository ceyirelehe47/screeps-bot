# Treasury Full Cost FC1

执行入口：根目录 AGENT-RUN.md 与 tools/run.cjs。

本轮复用 R1 Core 和 preview，改动测量/保护适配器及相关测试元数据。旧 2/1.8 CPU 成绩线不再适用于 FC1；完整性、输入健康、scope 对拍、真实成本、恢复各自记录。10 CPU 是一次性探索的协作式暴露保护，不是产品性能合格线；入口要求 native headroom 55、阶段保留 25、bucket 2000。同步调用不能被 JS 抢占。

四条主报告外各附一个同 tick 成本收据，保留原始报告和数据读取。最后业务主报告的 afterRetention 尾部可观测；最后成本收据自身输出尾部仍未知。

根包无需另一个 ZIP。执行时从固定 Git 对象提取并认证 66 个历史执行器 payload，复用成熟的采集、上传、恢复与择时。

制作端验证边界见 MAKER-VALIDATION.json。全部真实仓库门禁与唯一在线实验仍由 Agent 执行。历史 R1 的失败结论不修改。

# Compat Reader CPU I · v3 closeout

完整实现的最小续接包。仅修复v2归档步骤17/18的规则冲突，保留已执行v2包、原77文件、原失败证据及既有compat源码提交。

执行 `AGENT-RUN.md`，不要重新执行v2源码应用或归档步骤。`tools/run.cjs` 提供包验证、37项固定测试、只读续接检查、补充装配、最终索引门禁、提交树核验与Git远端回读。

唯一已授权例外是整个SHA锁定的旧patch第73/78行空上下文。对其他文件仍执行原生检查；对这个文件也要求完整原生输出只有两处预期诊断。没有全局关闭whitespace、没有通配排除patch、没有改变生产代码。

`tests/fixtures/v2-bytes.json` 是原交付包的逐文件base64字节夹具；只用于隔离测试，不是Agent原始运行结果。模拟提交身份与模拟验收记录不得当作用户仓库或引擎证据。

参见 `validation/` 制作方原始结果和边界。Windows原生复测、真实暂存区、签名/钩子与GitHub推送仍由Agent完成。

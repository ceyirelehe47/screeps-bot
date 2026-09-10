# 本地验证范围

- `final-1.stdout.log`：63项Node测试通过，0失败/跳过。其中41项使用模拟读取端口验证真实新桥代码；22项验证装配器、依赖白名单、固定旧主循环字节和主循环模拟业务端口执行。
- `final-2.*`：TypeScript 5.8.3、小型Game环境声明、声明式builder占位下的4份手写TS模块严格检查。不是候选锁定依赖/真实8文件闭包的类型检查。`local-game-type-stubs.d.ts` 仅用于该本地检查，不复制进候选。
- `mutations.json` 及4组 `mutant-*.log`：取消缺失语义、伪造可支出量、意外写Memory、沿用变更前容量，均被bridge测试捕获。故障副本只在临时目录，不进入交付源码。
- `same-worktree-refusal.log`：拒绝把开发与候选指向同一目录。
- `commands.json`、`executed-summary.json`：命令与边界。目录中的round/first日志是开发过程记录，不用后一次结果覆盖前一次记录。
- `references/online-base-main*.ts`：从此前挂载源码推导旧版本并与本次GitHub读取的完整Git blob核对一致（main 5f6c49c… / test 2d2283b…）；测试使用这两份真实旧入口源码，业务端口仍是模拟。

交付环境完整Git访问DNS失败。没有在这里生成真实仓库8文件闭包，没有执行那10项real-readers测试、目标仓库完整类型检查/Jest/预算/Rollup、Windows实机或Screeps部署。测试没有跳过这些项目后声称通过；它们在任务书中作为Agent必做验收。

原算法闭包必须由固定Git对象现场生成，无本地stub替代路径。生成器要求目标和来源安装TypeScript5.9.3。此包为默认关闭的候选装配实现，不是已验收的线上发布产物。

# Treasury Read-only Observation I — implementation package

基线：`77d67d6a02cfb55029515e00503b598a78870ae5`。
仓库：`ceyirelehe47/screeps-bot`，分支：`refactor/empire-treasury-rearchitecture`。

这是已实现代码包，非空任务书、非部署包。先读 `AGENT-VERIFY.md`。

`changes.patch` 修改两个现有文件（main与其phase顺序测试）并新增六个文件。`files/`为补丁输出，`base/`只含经Git blob核对的两个原文件，不是完整仓库。`apply_patch.py`在真实固定SHA干净工作树上应用，绝不自动安装、commit、push或连接游戏。

新增观察器默认关闭，在正常main尾部复用现有Treasury的只读查询，观察限定范围的原始库存、占用、容量、健康与既有市场日志线索。没有新的持久账本、业务授权、发送或结算。不含另一套schema迁移/claim/receipt/retry平台。

## 已执行

- 最终局部Node测试54/54，无失败/跳过/取消；包含实际新增main/装配配合旧业务模拟端口的运行测试。
- 新三个模块在TypeScript5.8.3与选定局部API声明下的类型检查，零诊断。
- 四种临时副本变异均被测试检出：取消预留扣减、隐藏资源不一致、意外Memory写入、放任观察异常外抛。
- 两个原文件重建后的Git blob分别等于远端；补丁在另一份重建源码工作树执行check/apply后复跑局部测试。

## 未执行

实际生产facade的新增Jest测试（6个）、现有main Jest、项目锁定依赖/游戏类型的完整检查、生产bundle、全仓Jest、Windows新观察器环境测试、standalone/正式服务器和线上CPU成本。需要验收Agent按任务实际执行，不能以作者局部测试替代。

初轮测试49通过/2失败也原样保留：一个异常Store场景暴露了不必要的后续观察读取，现已将不可读端点提前结束；另一个main隔离用例错误地让原有beginTick服务入口也抛错，已只在新增观察器端口注入故障。之后补上配置冻结、输出省略不建立隐形基线及legacyStores显示，并通过最终54例。失败原件不改写。

默认只读仅指新增功能；既有bot业务/lifecycle/shadow/profiler仍然运行并可能写入其原有状态。不能因此把整个分支当成可无风险替换线上版本的只读脚本。

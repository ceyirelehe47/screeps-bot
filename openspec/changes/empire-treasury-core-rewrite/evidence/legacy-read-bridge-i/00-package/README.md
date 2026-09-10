# Treasury Legacy Read Bridge I — 最小生产兼容接入任务包

日期：2026-09-10。交付：代码模板、确定性候选装配器、测试与独立验收任务。

**本包不是待上传的生产 bundle。** 它在独立的旧生产基线工作树中生成默认关闭候选，由 Agent 原样生成并验证，不把主开发分支回退，不把全部国库/Defense 重构上线。

| 身份 | 固定值 |
| --- | --- |
| 仓库 | ceyirelehe47/screeps-bot |
| 当前来源分支 | refactor/empire-treasury-rearchitecture |
| 本次核对的开发 HEAD / 读取算法来源 | 01bd9831454950c4928df98dd8679692b55603e5 |
| 已识别线上源基线 | 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c |
| 新建候选 Git 分支 | compat/treasury-read-bridge-i |
| 交付状态 | IMPLEMENTED_LOCAL_CHECKS_ONLY / NOT_DEPLOYED |

## 设计落点

之前完整的只读观察器依赖当前 TreasuryService，而旧线上没有该装配。直接把它连入旧 bot 会带出 schema 激活、生命周期与其他基础改动。本轮采用更窄的兼容桥：只复用既有 `buildTreasuryObservation` 和 `buildTreasuryCommitmentIndex` 及8文件运行闭包，展示实物与旧任务/预留的读取结果，不生成可支出量，不冒充完整 facade 查询或 kernel 验证。

两份原算法从固定 Git 对象提取、按 TypeScript 5.9.3 转译；没有在包里重新手写它们的库存加法/承诺规则。旧主循环只加一条默认关闭 phase，旧经济、防御、Memory 生命周期与配置类型保持原样。看见未知数据时报告缺失或不完整，不迁移、不修复、不清零。

本次代码包含绝对 tick 窗口（启用时最多1200tick），全局 reset 不延长窗口；最多2房间×4资源；过期表、损坏表、缺表和空表分开表达；按实际 getCapacity 读取动态容量，ID/容量变化不沿用旧比较基线。

完整 Treasury 内核和完整 facade 观察器的既有通过仍保留；本桥通过不会自动升级为它们的线上通过。

## 使用

先阅读 `AGENT-VERIFY.md`。Agent 在完整本地仓库中另建旧基线工作树，分别安装锁定依赖后执行：

```sh
node /ABS/PACK/kit/assemble.cjs --source-repo /ABS/DEV --target-repo /ABS/CANDIDATE --check
node /ABS/PACK/kit/assemble.cjs --source-repo /ABS/DEV --target-repo /ABS/CANDIDATE --apply
```

工具只读本地 Git 并写指定工作树，不连接网络、不读取 token、不生成/切换 Git 分支、不 commit/push，也不进行任何游戏操作。不是给当前开发 HEAD 使用的普通补丁。

生成13个候选文件：修改旧 main 与原顺序测试；增加4个手写 TS 模块、1个带来源的生成模块、3个 Node 测试/辅助文件、1个 Jest wrapper、候选说明和来源 manifest。真实原算法在 Agent 完整仓库里生成；本包没有把局部 stub 当成生成物交付。

## 已执行与未执行

已在交付环境执行：bridge/assembler 局部 Node 测试、两个实际旧 main 文件的 Git blob 核对、旧主循环模拟端口下的顺序执行、使用 TS 5.8.3 和小型环境声明的新手写模块严格类型检查。具体命令、结果和限制在 `validation/`。

**未在此执行**：完整8文件原算法闭包的生成与其10项 real-readers 用例、目标仓库锁定依赖下完整类型检查、旧基线候选全仓 Jest/预算、真实 Rollup bundle、游戏执行或部署。实际 Git 检出仍遭 DNS 失败；生成器的本地测试使用明确标注的编译 fixture。不得将这些局部绿测写成正式候选通过。

## token 与免限流

用户已创建新 token；最新提交已记录旧 token 认证401、新 token 200。这一记录不需要通过重新寻找历史泄露值反复验证。新值只能从本地现有凭据读取。

本轮用户明确允许 Agent 自行通过官方流程解除该 token 的临时限流，无须重复请求此项授权。正确状态接口是官方 `/api/auth/query-token`，不是 `/api/auth/tokens`。仅打开解除页面不算成功；核对官方状态与必要读取。官方流程中的真人验证不可绕过。免限流授权不变成代码上传、Memory修改或资源发送授权。

## 主要材料来源

- 当前 Git HEAD：01bd9831454950c4928df98dd8679692b55603e5（凭据轮换记录）。
- 线上基线：06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c；对应 main blob=5f6c49c70d1c916ab47cda30884fddb1fab9931a、main.test blob=2d2283b8466c6427a2222b841d8fd72261374f02。
- 当前 observation.ts、commitments.ts、resourceReservation.ts：读取与写入生命周期分离；source-plan.json 固定读取闭包及来源。
- 上轮实时提取：旧任务/预留在所记录时刻为空、E4N58容量投影800万，不当作之后仍为空或直接 Store 原件。
- https://docs.screeps.com/auth-tokens.html （指定token临时免限流与状态接口；2026-09-10核对）。
- https://docs.screeps.com/api/ （Store容量接口）。

附件中的 bd9570d 旧检查点是早期裸 API 阶段历史，不覆盖本包版本/任务。不得返回去重跑早已通过的相同100H正常路径。

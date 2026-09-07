# Core Candidate Seal I · 负向控制（K06）

两类敏感性证据在此分开分类（任务书 §5）：

## 1. 测试侧敏感性检查（正常通过的 expect 用例）

位于 `src/runtime/treasury/treasuryRemediationIVKernel.test.ts` 的
`Seal I 敏感性检查（K06）` describe（2 用例）与 J06 内嵌自检：

- **轨迹遗漏检测**：合成完整轨迹（结构齐全的最小真实形态）先通过完整性
  核验；六种隔离副本破坏——缺中间观察窗口 / 缺终态 / 缺 post-close 检查
  点 / 端口事件缺失（eventsUpTo 与总数不符）/ 风险覆盖缺 ID / finalClose
  为空——核验全部返回 problems 并定位到具体缺失项。J06 内另对**本次真实
  运行轨迹**的隔离副本删除一个观察窗口做同样自检（不修改原运行数据）。
- **风险漂移检测**：真实 fixture 形状的基线深快照上做五种单字段漂移
  （worstCase 单腿金额 / invocationBoundary.atTick / identity.canonicalDigest
  / invocation null→缺失 / 记录整体缺失；ID、phase、腿数均不变），字段级
  比较全部失败且定位 attemptId + 字段路径；null 与缺失不互相替代。

这些用例证明**断言工具敏感**（能发现丢证据与同 ID/phase 的风险漂移），
不宣称生产已发生该错误。

## 2. 生产负向变体（Jest 非零失败，一次性 worktree，未提交进候选）

- 执行环境：一次性干净 worktree `git worktree add --detach <tmp> 62d6457`，
  按原 lockfile `npm ci`（exit=0）；变体只存在于该隔离目录，复跑后
  `git checkout --` 还原并清理 worktree（`git worktree remove --force`）。
- **变体 1（reused-heap-only-gate.patch，复用 VI 轮原 patch——在
  62d6457 上 `git apply --check` 干净可应用）**：删除
  `admissionGateStatus` 的持久关窗分支（仅剩 heap 否决单口径）。
  结果 `heap-only.run.log`：**exit=1，3 failed / 6 passed**——
  J01 主用例（完整 reset 后 admit/executeRearm/authorize 应全拒）、
  J02 主用例（持久关窗下真 P/R 应被拒）、J03 坏 ring 持久判定，
  均为行为断言红（非编译错）。还原后 `heap-only-restored.run.log`：
  **exit=0，9/9 全绿**。
- **变体 2（reused-zero-advance.patch，复用 VI 轮原 patch——同样干净
  可应用）**：恢复循环 `used` 初始化为每 tick 预算上限（份额视为已尽，
  生命周期推进替换为零推进）。结果 `zero-advance.run.log`：
  **exit=1，9 failed / 5 passed**——J06（Seal I 全轨迹版）红（非零
  服务/真实进展断言首先失败），H01–H07 推进系列 8 用例红；J05
  （validator 构成断言，与推进无关）、零推进负向对照、两个敏感性
  用例仍绿（判别准确）。还原后 `zero-advance-restored.run.log`：
  **exit=0，14/14 全绿**。
- 变体红来自目标行为断言（持久关窗 / 非零服务），不是编译失败、缺
  模块、零收集或 expected 全拒。

## 与测试侧检查的区分

| 类别 | 形态 | 结果形态 | 证明对象 |
| --- | --- | --- | --- |
| 测试侧敏感性 | `expect` 正常通过用例 | Jest 绿 | 核验/比较函数对坏输入敏感 |
| 生产负向变体 | 隔离 worktree 中的源码 patch | Jest 非零失败后还原绿 | 生产实现承载对应行为 |

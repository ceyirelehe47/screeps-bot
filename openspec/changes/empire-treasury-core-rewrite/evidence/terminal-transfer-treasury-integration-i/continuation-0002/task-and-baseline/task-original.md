# Treasury Terminal Integration I：本地实机续测任务书（Continuation 0002）

来源：用户会话附件（treasury-terminal-integration-I-local-engine-continuation-0002-task.md），
2026-09-10 由执行 Agent 逐字归档。执行时的原件正文见本轮交付的
`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-treasury-integration-i/continuation-0002/task-and-baseline/task-attachment.txt`。

## 关键要求摘要（不得替代原件，仅索引）

- 起点 `9aa1c4815ef01ff42ec0d0f205f6297315dc7811`；分支 `refactor/empire-treasury-rearchitecture`。
- 一轮新的本地真实引擎验收：国库接纳与占用 → 真实 terminal.send() → 观察 → 注册结算 → 占用解除与退出。
- 不重新应用 17 文件实现包；不重写 adapter/coordinator/停止控制器/国库。
- 开始前把 `enabled.ts` 恢复 false 并单独提交（准备期关闭，旧 true 不构成本轮授权）。
- 环境：新实验 ID `lab-ti1-0002`、合成用户 `lab-ti-user-0002`；新世界；不复用 lab-ti1-0001/ec0001 世界数据。
- §6.1：先明确本轮实际安装的 launcher 对 restart_interval 的解释并把它移出本轮准备与运行周期（可用足够大的正间隔），最终以运行进程参数为准。
- §6.2：地图/fixture 一次完成后统一停止并重启本次实验引擎相关进程；基线/身份/费用由真实玩家读数取得。
- §6.3：准备期完成屏障（真实引擎完成事件 roomsDone 等），不能只凭 paused=true。
- §6.4：inspect → initialize → observe-false 两 tick → arm 一次 → observe-armed 两 tick → facts（T0）。
- §7：首次固定 T ≥ T0+3；只改实验配置/开关/fixture 配对/证据 → 不再重复全仓 Jest；最终绑定后做类型检查、integration 定向测试、C02、实际源图构建、活动模块回读、第二树比较。
- §8：正式只装载一个 main（新 bundle），不得附带原 observer/single-shot/runIMain 组合；最多一次真实 API 调用（非"一次成功"）；固定窗口 T−2..T+20 共 23 样本，180 秒先到停止。
- §9：三问先行（是否到达 send 边界/是否到账且经国库/是否及时停止）；四层停止事实；结果标签不合并。
- §10：CLI 模板；证据分组建议（task-and-baseline / environment-and-readiness / control-and-validation / formal-and-closeout）。
- §11：Git 纪律（线性提交、不 reset/rebase/force push/amend；RUN_VALIDATION_HEAD 与 DELIVERY_HEAD 分离）。

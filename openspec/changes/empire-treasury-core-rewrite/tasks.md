# Tasks — Empire Treasury Core Rewrite

## Core Rewrite II（2026-09-05 完成）

- [x] 影响范围侦察（subagent：生产调用方仅 main.ts/productionMonitor/runtimeServices；爆炸面在 16 个 co-located 套件）
- [x] 红灯重现：B01–B28 矩阵先行版（42 用例）在基线 35ed7f8 上 26 failed/16 passed（R01–R03/R05–R11 全部复现；R04 经独立基线脚本证明 pending 无出口）
- [x] 工作流 A：permit 签发快照深冻结 + 执行前完整身份重验（R01）；发布确认写协议——基线漂移检查 + 读回深度精确比较（R02）；查询视图独立深快照、health 不泄漏 memory（R06）；external_settlement_receipt 删除、settle 收口到受控 reconcileOutcome 端口（R07）
- [x] 工作流 B：authorizationFacts 统一判定（查询严格口径/接纳/rearm/复验共用）；tentative overlay 删除（同一责任唯一扣减归属）；worstCase 双向腿；unknown 流入占接收容量；rearm 同严格（R03）
- [x] 工作流 C：cancel_pending + 跨 tick sweep（R04）；缺端口拒绝/保留（R05）；公平游标 + per-tick 持久预算（R08）；consumerKeys/未知字段/计数器饱和/总量 360,000 预算（R09）；ring degraded 隔离 + 写入重建（R10）
- [x] schema v2（recovery 调度区 / pending_cancellation / 双向腿）+ runtime.d.ts + 指纹更新
- [x] B01–B28 验收矩阵全绿（treasuryRewrite2Acceptance 42 + treasuryRewrite2Lifecycle 17：B03/B12/B13/B19/B25/B26）
- [x] 共享完整 reset harness（test/mock/treasuryResetHarness：JSON 快照安装为全局 Memory + jest.resetModules + registry 重装 + 真实 beginTick）
- [x] A03/A06/A16/A21/A22 等价性修正（R11：真许可篡改/多笔合计/全返回值遍历/完整 reset 语义）
- [x] 压力扩展：接收竞争序列（125 笔确定性上界→62 笔收紧后验证）、pending sweep 取消流（500 项）、公平性（B16 前 8 失败第 9 完成）
- [x] B27 负向变体三件套红灯验证（弱许可校验/忽略 unknown 接收占用/抛错当释放成功）后还原
- [x] evidence：core-rewrite-ii-local-validation.md + core-rewrite-ii/ 原始记录

## Core Rewrite I（2026-09-05 早些完成，35ed7f8）

- [x] 边界侦察、新内核 kernel/、facade 重写、165 旧协议文件删除、A01–A24 矩阵、压力与小模型、架构守护、Defense 冻结回归、evidence（见 core-rewrite-i-local-validation.md）
- 注：I 轮 evidence 中"A01–A24 全通过"的覆盖等价性在 II 轮审查中未成立（A03 只伪造新对象、A16 只测单笔、A21 未遍历 health、A22 未完整 reset）——II 轮已按 R11 修正并保留原 evidence 为历史。

## 明确不做 / 遗留（design §4）

- [ ] 真实经济 writer 接入（生产 adapter 注册表保持为空——部署阻断条件而非待办）
- [ ] 受控 external settlement capability（自报通道已删除；新通道必须同等受控，接入真实 driver 前置）
- [ ] 真实 Screeps driver 的"效果保留而 Memory 回退"非原子窗口验证（跨 tick 重发不能排除 → 真实 driver 禁用是结论）
- [ ] 旧 Memory 在线迁移器（按任务书不建：发现旧数据报 incompatible 阻断）

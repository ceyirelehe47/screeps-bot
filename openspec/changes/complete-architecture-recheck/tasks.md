## 原 20 项完整范围

以下完成标记必须代表整项验收；局部进展只写在条目说明中，不提前勾选。

- [ ] 1. 统一 PathFinder 内核，完整路径可选，完整性与预算独立，结构化失败原因，partial 使用适当 TTL（A4、A17、A20）
- [ ] 2. 出口选择与执行共用矩阵，严格房间路由缓存，静态断路退避保留，同 tick stuck 幂等（A2、A11）
- [ ] 3. 出征准入按意图及 owner 注册，共享层不读任务 Memory，统一防御角色与 RESERVE 快照，拒绝原因可追踪（A3、A16）
- [ ] 4. 防御前置，T0–T4 真实调度，看门狗独立于 profiler，预测后续关键阶段预算（A7、A19）
- [ ] 5. coreDefense/defenseMode 及普通逐房阶段隔离；T0 每 tick 重试，T2–T4 有界熔断；持续故障告警和半写状态收敛（A1、A13）
- [ ] 6. 统一路径测试替身，覆盖 findPathTo、预算、动态/静态障碍及 move 覆盖/出口切换计数（A11、A20）
- [ ] 7. 安全区为独立缓存矩阵层，稳定策略 key 和 revision，策略拒绝区别静态断路（A8）
- [ ] 8. Memory 子树单写者与 owner GC 注册；crossShard/deposit 活体保护；resourceTransfer patch API 自动 bump revision（A9、A14）
- [ ] 9. TickContext 唯一全量读取入口，cargo 并入且同 tick 增量可见；调和器按 revision 门控并建立边界检查（A15）
- [ ] 10. 出生请求统一入口与配置服务写入，迁移生产调用方并约束直接写入
- [ ] 11. CreepConfig revision 读索引；出生规划不重复 list，全索引同 tick 写后读一致
- [ ] 12. 声明式进程表及 isDue 哈希错峰，迁移裸 Game.time % N，边界检查防止新增（A10）
- [ ] 13. MoveProfile 显式移动语义，迁移调用方，解决 travelRange 无效参数
- [ ] 14. 路径缓存分层与布局 revision，战斗稳定 costCallback key 和可复用路径（A12、A20）
- [ ] 15. 任务生命周期库及集中退役所有权；共享 boostParts 口径；迁移任务状态直写（A5、A6）
- [ ] 16. 小队抽象，迁移 PB pair 与战争协同，保留边界同步和失败恢复
- [ ] 17. creep 执行协议、粘性动作/休眠及 tick 末交通解算，避免 intent 覆盖
- [ ] 18. 市场预检按 revision 门控且保留实时安全校验；shadow/dryRun owner 和毕业/删除条件（A18）
- [ ] 19. Memory 冷数据迁 segment，激活/未激活/重置恢复与容量边界验收
- [ ] 20. 有界事件队列、creep memory 瘦身与迁移兼容，活体/出生/跨房生命周期验收

## 全范围交付门

- [ ] 21. 服务器类型检查、无过滤完整回归、正式构建与映射验证
- [ ] 22. 干净 main 与 origin/main 对齐；完整回滚、模块读回、shard1 实际执行身份和有界健康验收
- [ ] 23. 按 1–20 逐项检查生产接入、反例与证据，缺少任意项不能宣告整体完成

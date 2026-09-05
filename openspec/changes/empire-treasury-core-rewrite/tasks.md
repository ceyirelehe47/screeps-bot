# Tasks — Empire Treasury Core Rewrite I

## 已完成

- [x] 边界侦察：facade 对外 API/生产调用方/main 装配/旧 store 拓扑（7 处外部生产 import 全部落在保留模块）
- [x] 新内核 kernel/（types/store/identity/commands/occupancy/kernel）：单一写入口状态机、heap-only 许可、三种事实分离、单调发行、有界 retry、近期环
- [x] facade 重写接入（查询侧签名保持；写侧 authorize=admit+permit / execute=受控 dispatch / settle / rearm / close）
- [x] actionContracts 精简（执行入口退役；adapter 执行语义声明 settlesOnAccept/nonOkOutcome）
- [x] 旧协议栈 165 文件删除 + 旧 81 测试套件退役（authority-retirement-map.md）
- [x] testHarness 重写为纯观察通道；test/setup.ts 旧装配清理
- [x] runtime.d.ts treasuryCore v1 替换 + boundaries 指纹更新（必要兼容修复）
- [x] 基础测试恢复 11 suites/130 tests（test-migration-map.md §1）
- [x] A01-A24 验收矩阵 41 tests（真计数先行自证）
- [x] 压力：10,000 完成 / 1,000 代 retry 链 / 长期 unknown 混合 / 满载最坏体积
- [x] 小参考模型（2 槽/2 资源，独立判定 30 轮随机序列一致）
- [x] 架构守护 7 项（旧模块不复活/单一写入口/真实 writer 禁用/键权威/命令集封闭）
- [x] Defense 冻结回归 11 文件/118 tests 通过、生产文件零改动
- [x] evidence：core-rewrite-i-local-validation.md

## 明确不做 / 遗留（design §4）

- [ ] 真实经济 writer 接入（生产 adapter 注册表保持为空——部署阻断条件而非待办）
- [ ] external_settlement_receipt 通道升级为受控 capability（接入真实 driver 前置）
- [ ] 真实 Screeps driver 的"效果保留而 Memory 回退"非原子窗口验证（跨 tick 重发不能排除 → 真实 driver 禁用是结论）
- [ ] 旧 Memory 在线迁移器（按任务书不建：发现旧数据报 incompatible 阻断）

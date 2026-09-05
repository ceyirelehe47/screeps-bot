# Empire Treasury — Core Rewrite I

## 为什么

Remediation XII 审查（基线 `cf2ee7b`）判定 FAIL：恢复路径绕过 opening-bound verifier（R1）、verifier 折叠损坏为缺失（R2）、terminal 裁决取第一条（R3）、GRA replacement 不排除相反结论（R4）、测试用结果反推调用次数（R5）。这些不是孤例补丁能收敛的——旧实现把一项工作的生命周期拆散到 Ticket / Intent / Quarantine / Resolution / GRA / certificate / summary 等十余个持久权威里，每次补一轮就多一层协调例外。

用户已确认 Treasury 尚未部署、真实经济 writer 从未接线（生产资金走 `marketActionArbiter` 平行链路），因此选择净重写核心。

## 变更内容

- 新内核（`src/runtime/treasury/kernel/`）：一项未完成工作 = 一个有界活跃聚合；只有该聚合内当前 attempt 的正向许可可进入动作调用；历史明细不授权；所有安全依赖关闭后工作真正退出。
- 单一写入口状态机（admit / dispatch / settle / cleanup / rearm / close），纯转移函数 + 装配端口。
- 三种事实分离：动作调用发生、外部接口接受、世界效果确认。
- Retry 以 exact not-executed + 清理完成为前提，有界权利期限，不需要无限代证明。
- 新持久命名空间 `Memory.runtime.treasuryCore`（v1）；旧 `Memory.runtime.treasury.*` 业务 store 发现即报 incompatible 并阻断写入，不解析、不擦除。
- 旧多 store 权威（intents/quarantine/resolutions/receipts/attemptLineage/GRA/certificate/summary/ticket…）全部退役删除；`facade.ts` 重写为薄装配层，查询侧签名保持。
- R1–R5 转为 A01–A24 行为矩阵验收；真实调用计数 harness；小参考模型；压力测试。

## 影响

- Treasury 写路径完全替换；真实经济 writer 保持关闭（本轮不接生产 adapter）。
- 查询侧（observation/query/commitments/capacity）语义保持，productionMonitor 等只读消费者无迁移。
- `src/types/memory/runtime.d.ts` treasury 段替换为 treasuryCore 声明（必要兼容修复，指纹更新单列理由）。
- Defense 冻结清单内生产文件零改动。

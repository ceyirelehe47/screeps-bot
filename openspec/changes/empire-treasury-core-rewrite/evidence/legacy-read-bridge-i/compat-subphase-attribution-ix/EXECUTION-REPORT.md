# Compat Subphase Attribution IX

源码基线：ef23c464c83b90b413d43d07857f67d538f512a3
源码提交：57987cda22553fcdc842e8d4c72a98b6e94e00fb
证据父提交：77b82bff48e9f32a3ac035cf5e0888e1329b1046

本轮只为只读兼容 capsule 增加有界子阶段归因。九个子阶段嵌套在既有父阶段中；CPU 端口只在区域边界读取，不按任务、预留、资源键或查询逐项采样。

任务验证、健康判定、聚合与路由仍按 canonical 单循环执行，报告为一个 coarse commitmentTasks 区间，并附有原始整数工作量。预留 owner/expiry 为独立 coarse 区间。Observation 的 Store 枚举、快照、冻结及帝国汇总仍逐房间交错，未为了计时而改成第二算法。

20 场景在 diagnostics OFF 下与 Build VII 逐字节等价；四个 diagnostics ON 合成场景取得固定 12 个边界、完整投影和有界工作计数。所有测量均为 Node/合成输入，不是 Screeps 引擎结果。

配置保持 OFF、预算 2、窗口 0；没有连接 Screeps、使用 token、上传或恢复。CPU VIII 仍是 4 诊断 / 0 完整样本，恢复闭合；引擎缺口未解决。

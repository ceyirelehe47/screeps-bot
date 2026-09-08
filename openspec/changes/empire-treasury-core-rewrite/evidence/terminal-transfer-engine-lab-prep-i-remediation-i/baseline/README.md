# baseline/——Q01 基线复现原始材料

- `reproduce-baseline.cjs`：基线复现脚本原件（独立 Node 进程直跑；VM 沙箱按 CommonJS 装载旧产物——仓库 package.json 为 ESM，直接 require 会被误判为 ES module）。
- `baseline-run.log`：复现输出原件（旧产物三重身份核对 + 七场景矩阵）。
- `smoke-fixed.cjs`：修复后新产物的七场景冒烟脚本（实施期中间验证，正式验收以 probe.test.ts 与 final/ 主验证为准）。

复现结论（旧产物，三时点累计 send = 目标 tick 第 1 次 / 第 2 次 / 下一 tick）：

| 场景 | 轨迹 | 缺陷特征 |
| --- | --- | --- |
| S1 未武装 | 0/0/0 | — |
| S2/S3/S4 正常/非 OK/throw 对照 | 1/1/1 | — |
| S5 控制槽 setter 抛错 | **1/2/2** | 4 条 lab-control-write-refused 日志但 send 仍发生 |
| S6 控制槽静默丢写 | **1/2/2** | 零拒写日志（完全无痕） |
| S7 初始 4090 字符 note 记录 | **1/2/2** | 4 条超限拒写日志但 send 仍发生 |

正式可执行等价逻辑位于 `test/lab/terminal-transfer/probe.test.ts`（Q01 基线复现 it，VM 假端口同矩阵）。

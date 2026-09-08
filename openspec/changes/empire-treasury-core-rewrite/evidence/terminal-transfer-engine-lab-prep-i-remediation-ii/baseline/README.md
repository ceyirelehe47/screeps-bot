# Baseline — Lab Prep I · Remediation II（B1/B2 基线复现）

执行环境：起点工作树 `87507f42b1302e6f0e5916d9dfb5c3cca9d94790`（修改前）、Windows/Git Bash、Node（版本见下方日志）。

## 文件

- `reproduce-baseline.cjs`——复现脚本原件（本轮实跑归档）：
  - 旧产物身份核对（字节 / `git hash-object` blob / SHA-256 三重）；
  - **B1**：固定旧产物（remediation-i 归档 single-shot.js）在全新 VM 沙箱、正常合法场景下让 send 同步抛 `new Error("错".repeat(2048))`，send spy 入口内观察 attempted，三时点累计 send，并独立测量结果槽终态 JSON 的字符长度与 UTF-8 字节数（`Buffer.byteLength` 只作外部期望，不进被测实现）；
  - **B2**：`git show 87507f4:test/lab/terminal-transfer/controlRecord.ts` 旧源码经 TypeScript 转 CommonJS 后在 VM 执行取 `readControlRecord` 直接读取入口，预置受支持字段组成的超限记录（error=5000 个 ASCII x，无 note/extra/循环引用），断言读取零写（槽引用与 Memory 键不变），保留短 error 合法对照；另以旧产物 loop 对照（预置同记录只撞 already_stopped——读取健康误判）。
- `baseline-run.log`——本轮实跑原始输出。

## 复现结论（2026-09-08 实跑）

| 反例 | 旧实现行为（缺口） | 实测值 |
| --- | --- | --- |
| B1 非 ASCII 结果超限仍写入 | 结果 JSON 字符长度 2200 ≤4096 通过旧字符口径检查，UTF-8 字节 6296 >4096 仍写入控制槽（syncResult/stopped 落槽，write-refused 0 行） | send 三时点 1/1/1；send 入口内 attempted=true；槽终态 2200 字符 / 6296 UTF-8 字节 |
| B2 受支持字段超限读取为健康 | 旧 readControlRecord 只做存在性与形状检查，5145 字节记录返回 ok（读取零写）；产物 loop 只撞 already_stopped，不暴露大小问题 | 读取 ok/attempted=true；短对照（155 字节）ok；旧产物 loop 拒绝原因 already_stopped、零 send 零写 |

两个数字（2200/6296）为本轮实测，与任务书 §3.2 提到的上轮观察值一致；正式验收使用修复后的正确预期（`probe.test.ts` R 系列 it），不以旧缺口为绿灯标准。

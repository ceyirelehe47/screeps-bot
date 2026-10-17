## Why

架构复盘中的旧问题需对照当前版本逐项核实。当前仍存在出口选择与执行约束不一致、Hub 取消任务遗漏 Treasury 承诺失效，以及单房防御异常中断其余房间的问题，需要先补齐这些正确性边界。

## What Changes

- 出口选择直接产出与执行共用约束的路径；预算耗尽允许局部推进，真实失败才短期排除房间跳转。
- 将合成重规划取消任务收归运输任务模块，确保同 tick Treasury 承诺缓存失效。
- 塔和本房防御逐房隔离异常，限频报告，但每 tick 继续尝试关键防御。
- 在现有 CPU 采样中记录 T0–T4 降载 shadow 建议，不改变阶段顺序或实际执行。
- 补充预算、边界走廊、异常隔离和承诺失效的回归，并在服务器完成验证后按既有授权发布。

## Capabilities

### New Capabilities

- `runtime-boundary-hardening`: 出口路径、房间防御隔离与调度 shadow 的正确性边界。

### Modified Capabilities

- `resource-transfer-task-health`: 重规划取消任务必须同步失效 Treasury 承诺缓存。

## Impact

涉及 movement routing/pathing、运输任务所有者、Hub、塔、本房防御与 CPU 采样。保持现有出征规则、市场 dryRun、物流 shadow 和主循环顺序；本批不实施市场切换或真实调度降载。部署证据保存在忽略目录，主分支与实际发布提交对齐。

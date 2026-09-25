# Treasury Production T1：P1 只读终态核对（2026-09-26）

本记录仅更新 T1 的生产门槛状态，不重跑已完成的 FC1，也不执行 T1 上传、Memory 改动或 `terminal.send`。原工程终态和隔离引擎验收见 [最终状态](treasury-production-T1-final-status-20260925.md) 与 [引擎验收](treasury-production-T1-engine-acceptance-20260925.md)。

2026-09-25 20:19 UTC 的 `npm run monitor:once` 选中 shard1，tick `73942325`，部署 tag 仍是 `2026.8.29-6+5cef62c@2026-09-24T15:04:28.806Z`，不是 T1 候选 `69bf15cf`。故正式 writer 灰度尚未发生。当前 E3N59 为 pressure，storage/terminal 空位约 183,566 / 24,481；E4N58 Hub 为 emergency，两处空位均为 0。ResourceControl 摘要有 19 项 pending，0 项 manual；本次返回的 pendingTasks 列表中没有 `E3N59 → E4N58` 的 H 任务，E3N59 的 H 任务指向 E1N57 并被 `receiver_capacity` 阻断。摘要项数与列表长度不一致，故这里只判定**本次只读投影未提供符合 T1 切片的任务证据**，正式灰度前必须从 canonical 任务表重新核对，不能以此列表证明全量任务不存在。

T1 首片限定已有合法的 `E3N59 → E4N58` H 任务、至多 100 H 和 100 Energy 手续费。当前目标房间无空位且缺少可核实的匹配任务，维持 OFF 是正确终态。等市场 P0 的真实出货和容量恢复另行验收后，再依据当前任务、预约、terminal、CPU 与候选字节独立决定 T1 shadow/canary；不能为 T1 人造一条需求或把隔离引擎 CPU 视作正式预算。所有 active/unknown work 在交回旧 writer 前仍需按原 drain 协议对账。

## 22:35 UTC 更新

市场 P0 已另行上传，shard1 现役标签是 `2026.8.29-6+58cdfeb@2026-09-25T22:28:22.045Z`，仍不包含 T1 候选。tick `73944535` 的 E4N58 已从全满缓和到 pressure：storage 空位约 15k、terminal 空位约 24k；这改变了旧的「目标零空位」事实，但不是 T1 自动放行。进一步只读读取 `Memory.data.resourceControl.tasks` 全部 35 条 canonical 任务；H 任务仅有 `E3N59 → E1N57` 的一条 cancelled（剩余 45,011）和一条 pending（剩余 2,030），没有 `E3N59 → E4N58` 的 H 任务。故首片仍缺其要求的真实需求，T1 维持 OFF，不执行生产 send，也不重跑 FC1。

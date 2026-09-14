# Subphase Online X Retry I

这是一次完整闭环任务包，起点是已经修复 source manifest、但因上传前单次 `HTTP_TRANSPORT_ERROR` 而未部署的 Online X 终态。

本包不再修改 Treasury 读取实现，也不重复来源清单 remediation。新增实现只增强**上传前只读请求**的抗瞬时故障能力：账户认证、房间概览、活动分支和游戏 tick 在同一个总时限内最多尝试三次；候选 POST 与恢复 POST 仍各最多一次，永不自动重发。

离线门禁通过后，同一入口绑定新的四点窗口，执行 IX 九子阶段在线归因，随后恢复旧生产、完成独立 75 秒运行确认、归档并普通推送双分支。Agent 只执行固定实现和验收，不现场写实现。

固定起点：

```text
compat   d5e09b623de7391b3f69e51fb80cf7a852618509
refactor b6fffa20bfaaa8e6203dee25b09ff050048caa39
```

固定在线范围仍为 E3N59/E4N58、energy/H、四点、2 CPU，不追加第五点，不自动开启第二窗口，也不把 `partial_cpu_budget` 当作完整样本。

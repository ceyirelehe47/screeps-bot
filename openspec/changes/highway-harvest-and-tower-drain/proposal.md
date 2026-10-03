## Why

线上 E0N57 的 PowerBank 已发现超过700 tick却没有来源：远端来源持续寻路未完成，使可行近端来源也无法准入。用户同时要求由 E1N57 派出三个无强化25主部件双人扫荡小队、启动 Deposit 自动开采、修复低能量塔补给并用 Observer 接替纯视野 Scout。

## What Changes

- PowerBank 按安全路线长短安排评估，选择已完整证明可行的来源；其它未知来源继续等待，不否决已证明来源。
- 增加25 ATTACK与25 HEAL无强化双人模式，在真实出口受击、撤退、治疗、重新入房，塔重新补能时回到耗塔。
- 将作战、PowerBank、Deposit、外矿侦察纳入一个有界 Observer 调度器，保留普通轮巡机会。
- 首版 Deposit 单体兼任采集与运输，完整去返路径、冷却增长与TTL门控，实际卸货后计数；总并发最多2。
- 修复 Tower 补给无法从 Storage 取能的分支，保留 Terminal 授权边界。
- 覆盖内纯视野外矿 Scout 停止生产，长时间实际缺视野时恢复后备。
- 本轮部署后从 E1N57 派遣 E3N57、E2N54、E3N53；另以合适的强化小队清理 E5N56 一级堡垒，并回收资源。

## Capabilities

### New Capabilities

- `power-bank-source-admission`: 完整可行来源的有界准入。
- `tower-drain-squad`: 无强化双人边界耗塔。
- `shared-room-observation`: 多业务观察调度与外矿纯视野替代。
- `deposit-auto-harvest`: 有界 Deposit 自动采集运输闭环。
- `essential-energy-pickup`: 低能量塔的取能补给及 Terminal 边界。

### Modified Capabilities

无。

## Impact

涉及现有 PowerBank、War、Observer、carrier、remoteMining 模块，新 Deposit 角色和管理器、角色目录、孵化门、Memory类型和控制台只读状态。构建、测试在服务器隔离目录执行；不改市场、Treasury控制或生产Memory历史。用户已授权扫荡、Invader清理和回收；真实结果分别报告发现、评估、孵化、作战与交付阶段。

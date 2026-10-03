## Why

当前八个 Observer 只轮巡固定十个房间，Discovery 和任务/角色入口又拒绝名单外的 Bank。来源评估仅按房间跳数乘50估算，不能识别实际绕路、沼泽、障碍或不完整搜索，容易误判寿命与搬运期限。扩大搜索前还需要修复 Hauler 正向返程和第二趟阶段不切换的确定缺陷。

## What Changes

- 从当前己方来源位置与 Observer 原生范围生成高速房集合，去重轮巡；发现记录和任务资格不再依赖固定房名。
- 发现后的缺视野通过有界复看请求恢复，Observer 统一发布下一 tick 观察意图。
- 从实际 active Spawn 到 Bank 邻位计算完整安全路径，分别计算战斗、空载去程和满载名义返程时间；全部候选来源评估完成后才投入资源。
- 寻路预算不足、视野缺失、搜索不完整或目标有战斗威胁时等待，保留 Bank 绝对过期门；不主动开启对玩家的反击策略。
- 修复 Hauler 返程方向与第二趟拾取，保留 owner/generation、容量、备用交付和财政围栏。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `power-bank-squad-lifecycle`：动态观察范围、完整路径驱动准入、受限测路等待、双向搬运和威胁拒绝。

## Impact

新增有界寻路与动态搜房模块；修改 PowerBank Observer、Discovery、Scout、Harvest、Viability、状态投影、任务类型和 Hauler。保持主循环 phase 顺序、旧任务的房间数 fallback 与既有财政接口。全部构建/测试在服务器隔离目录执行；本变更不包含正式服上传或主动现场 PvP。

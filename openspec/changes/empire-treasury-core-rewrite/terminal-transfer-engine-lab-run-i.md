# Terminal Transfer Engine Lab Run I——真实引擎实验说明

状态：**AUTHORIZATION_REQUIRED**（离线接线已完成；真实引擎仍 NOT_RUN）。

编制日期：2026-09-08。任务书：`treasury-terminal-transfer-engine-lab-run-I-execution.md`
（归档于 `evidence/terminal-transfer-engine-lab-run-i/task/task-brief.md`）。验收索引 S01–S06。

## 1. 本轮目标与授权门禁

唯一新增事实目标：由真实 Screeps runner 执行现有 single-shot，经真实
driver／processor 处理一次 W1N57 → W10N57 的 100H 请求，并从后续游戏观察
核对结果。

授权边界（任务书 §0）：启动本地一次性实验环境、创建合成 bot 与两个
Terminal、装载实验探针、最多一次发送 100H——这些动作**须用户明确授权后**
才执行。未授权状态只允许源码读取、文档与离线接线；本文所述产物均为
PREPARED_NOT_RUN，未上传、未装载、未武装。

## 2. 离线接线交付（本轮已完成）

实验模块三件套（各自独立构建、字节独立，装载时保持 observer／single-shot
原始产物字节）：

| 模块 | 入口源码 | 构建命令 | 职责 |
| --- | --- | --- | --- |
| `observer` | `test/lab/terminal-transfer/observer.ts` | `node scripts/build-treasury-terminal-lab.mjs --out <dir>` | 只读零写采样（既有产物，未改动） |
| `single-shot` | `test/lab/terminal-transfer/singleShot.ts` | 同上 `--mode single-shot` | 未武装调用版（既有产物，未改动；发送前标记确认与门禁不变） |
| `main`（新） | `test/lab/terminal-transfer/runIMain.ts` | 同上 `--mode run-i-main`（输出 `main.js`） | 薄装配入口 |

`runIMain.ts` 边界（任务书 §4.4）：

- 观察窗口 `targetTick−2 .. targetTick+20`（共 23 tick，低于 maxSamples=32）；
  窗口内每 tick **先** observer **后**（仅 `Game.time === targetTick`）
  single-shot，保留调用 tick 前态；窗口外零调用、错过目标 tick 不补调不续期。
- 模块加载零动作；经 Screeps 运行时模块系统 `require("observer")` /
  `require("single-shot")` 装配；模块缺失或未导出 loop 如实记录一行错误事实。
- 不直接调用 `terminal.send`、不初始化／重置／复制控制槽、不复制
  attempted／费用／归属判断——发送资格完全由既有 single-shot 决定。
- 窗口首个 tick 输出一行装配／窗口信息（外部日志 console，不写游戏
  Memory）；窗口标志为模块 heap，global reset 会重置（实验已知边界）。

离线接线自测：`test/lab/terminal-transfer/runI.test.ts`（7 用例）——三产物
真实构建后按 Screeps 模块系统在 VM 装配，覆盖：装载零动作、窗口外零调用、
非目标 tick 只采样、目标 tick 先 observer 后 single-shot 恰一次、完整窗口
send=1、无武装 send=0、错过目标 tick 不补调；并断言构建器加入第三模式后
observer／single-shot 产物与 Remediation II 归档**逐字节一致**。

`labConfig.ts` 仍为唯一编译配置来源；真实实验身份（实验 ID／用户名／shard／
结构 ID／目标 tick／费用上限）须在真实世界读回后填写并重新提交、构建、
验证（任务书 §4.3），当前仍为合成示例值，不可发送。

## 3. 授权后动作顺序（概要；命令参数以实际安装版本核对为准）

1. 独立实验目录安装固定版本官方 standalone server（`screeps@4.3.0` 组合，
   精确版本与来源按任务书 §3.1 核对归档）；监听仅本机。
2. 管理入口暂停模拟并确认静止；创建两个房间与一个合成 NPC bot；布置合法
   控制器与 Terminal 及 §2 初始库存；回读结构 ID 并归档初始化快照。
3. 真实 runner 连续执行 observer 取得只读基线（≥2 个不同 tick）；装配
   外部日志收集通道并证明可用。
4. 暂停固定 `T0`，读回真实身份填入 `labConfig.ts` → 提交 → 固定
   VALIDATION_HEAD → 重建三产物并记录 hash → 装载回读核对模块字节。
5. 写入合法小控制记录（armed=true、attempted=false、完整 JSON ≤4096
   UTF-8 字节）并回读确认；恢复模拟，让 main×observer×single-shot 在真实
   runner 中执行一次发送与 T+20 窗口观察。
6. 按实际基线判读（H/energy/空位/cooldown/交易镜像）；窗口结束立即暂停、
   切只读、撤销武装；停止完整进程组并只清理本次新建环境。

判读与状态语义（ENGINE_LAB_PASS／INCONCLUSIVE／MISMATCH／ENV_BLOCKED）
及停止边界见任务书 §5/§6/§7。

## 4. 证据

`evidence/terminal-transfer-engine-lab-run-i/`：`task/`（任务书归档）、
`offline/`（离线验证与第二树复跑）、主报告（含授权状态声明）。
`environment/`、`engine-run/` 目录在真实实验授权后才会有内容。

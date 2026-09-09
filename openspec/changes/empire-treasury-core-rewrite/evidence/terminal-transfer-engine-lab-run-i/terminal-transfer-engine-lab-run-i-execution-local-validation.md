# Terminal Transfer Engine Lab Run I · Execution——本地验证与实机执行主报告

日期：2026-09-09。执行者：开发 Agent（同一执行者完成离线复验，不虚称独立
reviewer）。状态判定：**ENGINE_LAB_INCONCLUSIVE**（已进入实验、窗口完整
执行、**发送未发生**——single-shot 在发送边界之前被自身门禁前置拒绝；
单次 send 调用未消费、零交易、零资源变化）。

## 0. 授权来源与提交链

- 授权：用户会话明确回复「我给予你离线授权, 不接入线上服务器即可」。
  范围＝接续任务书 §0（本机一次性隔离环境、最多一次发送 100H、证据
  保存后停止清理、不接正式服/PTR/真实账号/真实凭证/国库生产 writer、
  无第二笔发送或故障注入）。全程未接入任何线上服务器。
- 起点：`8c5459c`（=远端）。本轮线性提交：
  - `3a9fceb` 真实配置回填 + sendGate 无 shard 兼容修复（单列提案）+
    probe/runI 测试迁移（LAB 35/35、全仓 241/1478/1478）
  - `fb7c22e` 预算滚动（probe 22→23，锚点 3a9fceb，自跑 PASSED）
  - `54d0676` 接续任务书归档 + S01/S02 实机证据 = **VALIDATION_HEAD**
  - 运行后仅追加证据与本报告（见 git log）
- 生产冻结基线 `869149d` 对比零差异（主验证 production-freeze 步）；
  根配置/构建器/runIMain/observer/singleShot/controlRecord/worldRead/
  sample/两 mock 全部零差异（implementation-freeze 步）；sendGate 的
  变化以 shard-gate-fix-diff 单列记录（见 §3 的事实纠正）。

## 1. S01 授权／隔离／版本

详见 `environment/install-summary.md`。要点：专用根目录隔离安装
`screeps@4.3.0`（engine 4.3.0/driver 5.3.0 组合逐一核对；独立 lockfile
`d95c2c12…`）；监听 127.0.0.1/[::1]（21025/21026/21027 全程仅本机）；
合成占位 steam key（认证路径未使用）；启动前 unset 全部覆盖变量、
端口占用核对；两次实测环境兼容事实（backend CLI 管道断开崩溃→改直连
storage 管理；运行中新增房间使 runner terrain 缓存过期→updateTerrainData
+重启 runner 恢复）均未修改任何引擎源码。

## 2. S02 真实只读基线

详见 `engine-run/README.md` 与原始文件。合成 bot `lab-synthetic-user`
（id `e37d410af9f7afe`）拥有 W1N57/W10N57（controller level 8、双
Terminal、初始库存 源 1000H+10000E／目标 0H+2000E、Spawn1 为
bots.spawn 固有产物）；observer 归档字节（9160/`96721926…`）双装载为
只读启动 main+observer，装载回读 UTF-8 重算 hash 一致。外部收集器
（storage pubsub 直订 `user:<id>/console`）实测收流：干净基线 32 样本
（tick 492..523）+ phase0 32 样本（370..402，字段错位格式已注明）。
真实读数：结构 ID/归属/库存/freeCapacity（源 289000、目标 298000）/
交易 0/**报价 q=10**（当时 worldSize=11 的环绕距离）。两房间无其他
writer（预置 simplebot NPC 在默认网格其他房间）。

## 3. 配置回填、修复提案与执行后事实纠正

- 回填（`3a9fceb`）：experimentId `lab-run1-exec-0001`、结构 ID
  `b0254105a49b92c`/`c61a4141a4a9fcb`、T=557（T0=554+3）、
  maxFeeEnergy=10、shardName=`standalone-no-shard`、描述 40 字符 ASCII。
- **sendGate 无 shard 兼容修复（单列提案）**：基于静态源码分析断言
  「standalone runtime 的 Game 对象不暴露 shard」（engine game.js 的
  Game 字面量与 driver/bundle 全文均无 shard 定义——该分析方法**没能
  覆盖真实注入路径**），引入 `LAB_STANDALONE_NO_SHARD_NAME` 约定值，
  仅显式声明才放行（shard 存在时行为与原实现一致）。
- **执行后实证纠正**：窗口执行后经一次性只读探查 bot（任务书 §4.1
  允许的只读补充输出；取证后已删除）实测——真实 runtime 的
  **`Game.shard = {name:"Forst", type:"normal", ptr:false}` 存在**，
  `hasOwnProperty(Game,'shard')===true`。因此：
  1. 提案的事实基础（引擎无 Game.shard）**错误**；其兼容分支无害但
     非必要，保留不回滚（diff 已单列；行为与原实现等价）。
  2. shard_mismatch 的直接根因：配置填了约定值，而真实读数为
     `Forst`。正确的回填值应为 `"Forst"`（未来轮次决定，本轮不改
     ——见 §6 判读边界）。
  3. 派生事实：worldSize 并非常量——基线时 runner 旧 worldSize=11
     （环绕距离 3 → q=10）；terrain 修复与房间持续生成后 worldSize
     演化至 58/59（环绕距离 9 → **q=26**，窗口期 observer 每 tick
     实读 26）。即 maxFeeEnergy=10 在执行窗口亦已低于实际报价——
     即使 shard 校验通过也会在 `fee_over_budget` 处拒绝。**该引擎
     在房间生成后 worldSize／报价会漂移**，实验设计（编译期固定
     maxFee）与该事实不兼容，这是本轮暴露的新鲜工程事实。

## 4. 离线验证（VALIDATION_HEAD=54d0676）

§6.1 命令组全部退出码 0（19 步：production-freeze、config-freeze、
implementation-freeze、shard-gate-fix-diff 含约定常量、typecheck×2、
build、三 lab 构建、jest-lab 35/35、jest-slice 23/23、jest-treasury
597/597、jest-defense 118/118、jest-full 241/1478/1478、budget
PASSED、diff-check、status-before/after 均空、HEAD 断言；生产 bundle
SHA-256 `6848d4c0…` 在生产构建后与三次实验构建后一致）。三产物身份：
observer 10193B/`04fac1c2…`、single-shot 29139B/`3266d7b2…`、main
8754B/`3e944685…`。输出目录归档 `offline/execution-mainval/`。
第二干净 worktree 独立 `npm ci` 复跑 LAB+Slice 0 并构建核对三模块
（结果见 `offline/execution-second-tree/`）。

## 5. 实机窗口事实（engine-run/console-window.jsonl 等）

- 装载回读：`bots.reload` 后活动 branch `t1788928675342` 三模块
  UTF-8 重算 hash 与本轮产物逐一一致（main/observer/single-shot）。
- 武装：控制记录 99 字节 ≤4096 回读确认（armed=true、attempted=false）。
- 窗口 555..577 完整执行：main 装配行 1 条（窗口/目标 tick 声明与
  配置一致）；observer 采样 **23/23 tick 无缺**；每 tick feeQuote=26。
- **T=557**：main 按序调用 observer（采样在）与 single-shot；
  single-shot 输出 `lab-precondition-rejection reason=shard_mismatch`
  （探针前置拒绝，非游戏 API 的 ERR 返回）——**未进入发送边界**：
  attempted 未写、控制记录保持 armed、send 调用 0 次。
- 终态（暂停 gametime 585 取证）：源 Terminal 1000H/10000E/cd=0、
  目标 0H/2000E（与初始值逐项一致——零资源变化的独立物证）；
  transactions 表该用户记录 **0 条**。
- 撤装：控制记录改 armed=false（218 字节）保留 attempted=false 与
  撤装说明；终态快照 `engine-run/final-snapshot.json`。

## 6. 判读：ENGINE_LAB_INCONCLUSIVE

S01/S02/S05/S06 满足；S03 部分（装载回读与武装成立，但配置含错误
身份假设）；S04 未取得（发送未发生）。按任务书 §7 状态定义与 §4.5
停止纪律：

- 不能改 T／换实验 ID／清 armed 重试到成功（§4.5 明令，且双重新鲜
  证据表明回填值在执行窗口已失效——shard 读数与 fee 报价均漂移）；
- 单次 send 调用未消费、零发送边界、零交易、零资源变化——非
  MISMATCH（无任何调用），非 PASS（无正常调拨证据），非 ENV_BLOCKED
  （环境与接线前置均完成——失败源于配置身份假设错误）；
- 定 **ENGINE_LAB_INCONCLUSIVE**，保留全部原始证据与责任事实。

若未来开展新一轮：须新的任务书明确（含本轮两条实证：真实 shard 名
`Forst`、worldSize 漂移对编译期 maxFee 的不兼容）；本文件不构成再次
运行的授权。

## 7. S05 停止与无污染

窗口越过 T+20 后暂停（最终 gametime 585）；撤装并回读；终态取证后
停止全部收集器与本次完整进程组（launcher 树 taskkill，核对 21025-
21027 无监听、实验目录相关 node 进程数 0）；仅清理本次新建数据
（`D:\code\screeps\lab-run-i-exec-env\` 整目录为本次新建，证据入库后
删除）；未反向发送、未触碰既有世界/服务。

## 8. 服务与运行事实（普通文字）

- 服务：已启动（隔离 standalone，仅本机），现已停止。
- 真实 runner 只读代码：**已执行**（基线 64 样本 + 窗口 23 采样）。
- 武装：**曾武装**（99 字节回读确认），现已撤装。
- 发送边界：**未进入**（gate 前置拒绝，send 调用 0 次——次数确定为
  零，非无法确认）。
- 交易：**未取得**（transactions 表 0 条）。

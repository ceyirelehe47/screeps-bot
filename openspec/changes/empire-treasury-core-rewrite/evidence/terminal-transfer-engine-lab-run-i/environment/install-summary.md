# Engine Lab Run I · Execution——隔离环境安装与接线摘要（S01）

日期：2026-09-09。授权来源：用户会话明确回复「我给予你离线授权, 不接入
线上服务器即可」（范围＝接续任务书 §0；本机一次性隔离环境、最多一次
发送 100H、证据保存后停止清理、不接正式服/PTR/真实账号/真实凭证）。

## 安装身份

- 专用根目录：`D:\code\screeps\lab-run-i-exec-env\`（与 bot 仓库
  `D:\code\screeps\screeps-bot` 分离；服务器不装在 bot 根目录）
  - `server/`——npm 安装根（package.json 仅 `"screeps": "4.3.0"`）
  - `world/`——`screeps init` 世界数据（db.json、.screepsrc、mods.json、日志）
  - `bot-ai-labrun1/`——bot AI 模块目录（mods.json 注册）
  - `tools/`——管理/收集脚本（adm.cjs、console-collector.cjs，归档于
    engine-run/tools/）
  - `build-final/`——正式三产物构建输出
- 安装命令：`npm view screeps@4.3.0 version engines dependencies --json`
  （记录见 npm-view-screeps-4.3.0.json，与任务书 [E1] 声明一致）后
  `npm install --save-exact screeps@4.3.0`（572 包，exit 0）。
- 实际版本组合（逐一核对）：screeps 4.3.0、@screeps/backend 3.3.0、
  common 2.16.0、driver 5.3.0、engine 4.3.0、launcher 4.2.0、
  pathfinding 0.4.17、storage 5.1.3。
- 独立 lockfile：`server/package-lock.json`
  SHA-256 `d95c2c12f74c6e2c4df6adf9025a191be4f5f4069b28366b8152714fc34c0ac7`。
- 主机：Windows 10 x64（MINGW64/Git Bash）、Node v22.19.0（≥22.9.0 ✓）、
  npm 10.9.3（≥10.8.2 ✓）。

## 隔离措施（启动前落实）

- `.screepsrc`：`host = 127.0.0.1`（改默认 0.0.0.0）、`port = 21025`、
  `cli_port = 21026`（cli_host localhost）；storage RPC 实际监听
  `[::1]:21027`（launcher 自动分配 cli_port+1）——三者均仅本机回环。
- `steam_api_key = lab-synthetic-no-steam-key`（合成占位；init 交互 prompt
  仅原样写入 .screepsrc 供用户 sign in 认证路径使用——本实验全程走
  NPC bot + 本地管理入口，**认证路径未使用**，不宣称已验证免认证启动）。
- 启动命令显式 `unset DRIVER_MODULE STORAGE_HOST STORAGE_PORT STORAGE_PATH
  GAME_PORT GAME_HOST CLI_HOST CLI_PORT MODFILE DB_PATH`；实测无继承覆盖。
- 专用数据库/日志/世界目录，全新创建（init 拒绝覆盖既有 .screepsrc）；
  未复用任何既有世界数据；端口 21025-21027 启动前核对空闲。

## 进程组与停止预案

- launcher 启动的进程组（首次）：storage 147248、backend、engine_main
  141120、engine_runner1 143052、processor×2。重启 runner 两次（见下）后
  runner 为 144352。
- 停止预案：taskkill /T /F 杀 launcher 进程树（restart_interval=3600s
  自动重启仅在被杀 worker 上生效，先停 launcher 即整组停止）。

## 实测环境兼容事实（未修改任何引擎源码）

1. **backend CLI 管道崩溃**：`echo cmd | screeps cli` 断开时 backend 的
   readline 抛未处理 ECONNRESET 使进程退出重启循环（world/logs/
   backend.log.1 留有完整栈）。处置：弃用管道式 CLI，管理操作改经
   `tools/adm.cjs` 直连 storage RPC（127.0.0.1/[::1]:21027）调用 backend
   CLI 模块的同源实现（map/bots/system）。
2. **运行中新增房间使 runner terrain 缓存过期**：runner 的
   staticTerrainData 为进程首建单次缓存，启动后 map.generateRoom 的新房间
   不在其中；用户环境重建时 WorldMapGrid 读新房间 terrain 抛
   `Cannot read properties of undefined (reading '0')`（用户 console 以
   error 通道可见完整栈，engine-run/console-baseline.jsonl 前段）。
   处置：`map.updateTerrainData()`（刷新 env 层 TERRAIN_DATA 缓存）+
   重启 runner 进程（launcher 自动拉起，Terrain shared buffer 372500 字节
   =149 房间）。世界数据与暂停状态（env MAIN_LOOP_PAUSED）持久，不受影响。
3. **无 Game.shard**：见 engine-run/api-incompatibility-game-shard.md 与
   仓库根修复提案（terminal-transfer-lab-run1-shard-gate-compatibility.md）。

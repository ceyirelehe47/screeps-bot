# Treasury Legacy Read Bridge I — 限定线上观察 0001 执行记录

**终态：`TEST_PATCH_VERIFIED / NOT_DEPLOYED`**（2026-09-11）

任务包 `screeps-treasury-compat-online-observation-0001-task-package-2026-09-11.zip`
（补丁 SHA-256 `59af104d…`，32 文件 PACKAGE_FILES_VERIFIED）。
执行到"部署授权一次性确认"环节未获确认，按 AGENT-RUN 第 2 节规则停在部署前，
交付本地验证与全部上线准备材料；**未上传、未采样、未改动线上任何状态**。

## 1. 本地补丁验收（已完成）

- 起点 `compat/treasury-read-bridge-i` @ `7ceabba`（与远端一致，无前移）。
- `apply-patch --check/--apply` 通过；应用后两文件 SHA-256/gitBlob 与
  PATCH-MANIFEST after 值一致（helpers `d1d91e64…`，real-readers `162630b8…`）。
- `COUNTER_FIX_HEAD = 6a63a2aff064295ef65efc8def26c9865dfd9db3`，仅改两测试文件
  （+53/−2），已推送远端（`7ceabba..6a63a2a`）。
- 定向验证：70 内部 Node 用例（bridge 41＋真实读取 10＋独立 19）全过；
  包工具 14/14（见下）；Jest 3 suites/8 tests；TS5.9.3 双配置 `--noEmit` 零错误；
  `check-profile --mode off` = PROFILE_SOURCE_VALIDATED_ONLY；`git diff --check` 干净。
- 独立验收 subagent 七项核验全过（谱系/字节/无意外改动/重跑测试），结论 ACCEPT。
- 本轮无新增测试条目：候选 Jest 预算仍为 195/685（锚点未动），继承 `6d514b5…` 全量结果。

环境注记：包工具第 4 项（临时 `git init` 内实际 `git apply`）在本机受系统级
`core.autocrlf=true`（`C:/Program Files/Git/etc/gitconfig`）影响产生 CRLF 转换而
失败；以 `GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null` 会话级屏蔽后
14/14 通过。候选仓库自身 `core.autocrlf=false`，apply-patch 直装字节不受影响
（SHA-256 复核一致）。未修改用户任何 git 配置。

## 2. 线上前检（已完成，全部只读）

| 项 | 结果 |
|---|---|
| 账号身份 | `forster`（userId `634fe406347a7b69b28aeccb`），`https://screeps.com` |
| 活动分支 | `default`（`activeWorld=true`；另 3 分支均非活动世界） |
| 远端模块 | 单模块 `main`，4,494,463 字节，SHA-256 `37d20706…`，集合摘要 `7049c350682fcde8…`，内嵌 bundle `7dce727ed4d647e6…` |
| 来源核对 | 内嵌 buildTag `2026.8.29-6+06ffedb@2026-08-29T14:28:59.403Z` 与内嵌 40-hex commit `06ffedb…` 同任务包声明生产基线精确一致 |
| 观察房间 | overview `shards.shard1.rooms` 含 `E3N59`、`E4N58`（8 房全列见 live-probe-summary.json） |
| tick 锚点 | `/api/game/time?shard=shard1` @ 2026-09-10T18:04:19Z = 73617305（未绑定 S） |
| 精确恢复原件 | 完整 modules + 逐文件 SHA-256 + 集合摘要存受控本地（工作树外），仓库只收本脱敏摘要 |

请求时刻 2026-09-10T17:41:04Z（UTC）。全程 token 仅在进程内使用，未入命令行/日志/仓库。

## 3. 收集通路与截止链路（已演练验证）

- 收集器为原生 ws 实现（`tools/console-collector.cjs`）：`auth <token>` →
  `subscribe user:<id>/console`（＋`/cpu` 活性心跳），原帧同步追加落盘不截断。
- 官方协议实证：频道名为冒号格式 `user:<id>/console`；`subscribe user/cpu`
  短格式与 `user/<id>/cpu` 斜杠格式均无推送（已实测排除）。
- 官方服 60 秒终验：31 帧（console 通道 13、cpu 通道 14、握手 4），footer 干净；
  旧 bot 持续运行证据 = cpu 帧持续到达。17KB+ 单帧不截断由离线 mock 实证（17152 字节）。
- 恢复脚本 `tools/restore-modules.cjs`：恢复前回读判定（部署产物→恢复；已恢复→幂等；
  第三方→CONFLICT 拒写），恢复后强制回读比对，失败报 `ONLINE_CLOSE_UNCONFIRMED`。
- 截止执行者 `tools/deadline-guard.cjs`：独立墙钟（15s 周期），到点或收集器退出均触发
  恢复请求；恢复失败以非零退出如实上报，不报"已关闭"。
- 离线替身演练 `tools/rehearsal.cjs` + `tools/mock-screeps.cjs`：**10/10 通过**
  （A 收集通路/大帧不截断；B 收集器退出仍恢复＋真实覆盖＋RESTORED_AND_VERIFIED；
  C 恢复失败报 UNCONFIRMED；D CONFLICT 拒覆盖；E ALREADY_RESTORED 幂等）。
  明细见 `rehearsal-summary.json`。

上轮会话遗留的本地收集器进程（相对路径 `tools/console-collector.cjs logs/console-all.jsonl`，
命令行无凭据）仍在运行；按纪律未动用户进程，本轮使用独立收集器实例。

## 4. 未执行项（授权未确认）

- 未绑定 S / 未生成 PROFILE_HEAD（配置保持默认 OFF，`ff291683faf…` 校验通过）。
- 未执行 `npm run push`，未启用观察，无任何样本。
- 无 CLOSED_SOURCE_HEAD（源配置从未离开 OFF，COUNTER_FIX_HEAD 即候选最新提交）。

## 5. 文件清单

| 文件 | 内容 |
|---|---|
| `README.md` | 本报告 |
| `local-verification.md` | 定向测试命令与结果记录 |
| `preflight-identity-summary.json` | 上线前身份/恢复摘要（脱敏） |
| `live-probe-summary.json` | 官方服通路验证与房间/tick 摘要 |
| `rehearsal-summary.json` | 离线替身演练 10/10 明细 |
| `tools/*.cjs` | 本轮实际执行的收集/恢复/截止/演练脚本（执行版本，非事后转录） |

完整模块原件与 console 原帧留受控本地 `compat-online-obs-0001-evidence/`（不入库）。

# Terminal Transfer Engine Lab Run I · Control Remediation I —— 离线验收主报告

编制：2026-09-09（执行会话）。对象：`ceyirelehe47/screeps-bot` /
`refactor/empire-treasury-rearchitecture`。

## 0. 结论与授权时序

| 项 | 状态 |
|---|---|
| 实现包原样应用（17 文件，基线 d69726a） | ✅ 完成，原样首轮验证全绿、零修复 |
| Agent 独立失败输入增补 | ✅ R02 +7 Jest 用例、R01/R03 +6 Node 场景（含 3 处测试自身修正披露） |
| 预算 | ✅ 242/1486 → **243/1497**，budget PASSED |
| 正式回归（VALIDATION_HEAD） | ✅ lab 4/54、slice0 3/23、treasury 35/597、defense 11/118、full 243/1497、CLI 0/1/2、冻结×6、diff-check、四产物构建、dist 未覆盖 |
| 第二干净 worktree | ✅ Node 89/89、lab 4/54、slice0 3/23、六产物逐字节 IDENTICAL |
| **实机 S01–S06** | ❌ **AUTHORIZATION_REQUIRED（未运行）** |

授权时序：离线交付全部完成后，按任务书 §0.2 对**本轮新实验**做了唯一一次范围
确认（范围=新建本机一次性隔离世界/合成用户/W1N57→W10N57/最多一次真实
terminal.send(100H)/180 秒先到停止/不接线上服务器）。未获答复。上轮
「授权执行 S01–S06」仅覆盖已结束的 cal-0002 实验，不自动延续；因此实机部分
全部未执行（零服务、零世界、零连接、send 调用确定 0），不伪造任何新世界事实。
一旦获得覆盖本轮的授权，可从 S01 直接开始（工具与流程已全部就绪并经离线验证）。

## 1. 提交链

| 提交 | 角色 | 内容 |
|---|---|---|
| `d69726a` | BASE（上轮终态=远端） | Calibration Rerun 收尾 |
| `b3207f9` | **IMPL_HEAD** | 实现包 17 文件原样应用 + Agent 独立增补 3 处（19 文件，+1832/−19） |
| `d0103c9` | **VALIDATION_HEAD** | 预算锚点滚动（baseline/target→b3207f9，243/1497） |
| （本次） | 交付 | 本证据根 + openspec 状态文档 |

## 2. 补丁原样性与首轮验证

- `apply_patch.py --check-only`：BASE/源字节/`git apply --check` 全 OK。
- manifest 逐项核对：原始 blob（calibrationCheck 0c55cb9e 等 5 项）、fixture
  逐字节（归档 facts dc8c811c…）、modified-files sha256、补丁 sha256
  （ac96655c…）全部一致。
- 应用后**原样状态**（未做任何修改）按 AGENT-VERIFY §5 跑七条定向命令：
  `npm ci` / `node --test` 三 spec（**83/83**）/ tsc×2 / `npm run build` /
  定向 Jest 四文件（4 suites/46 tests）/ Slice0（3/23）——全部 exit 0。
  **补丁原样状态无需环境适配或代码修复**；对 README 警告的 CRLF 问题未出现
  （仓库 core.autocrlf=false，字节校验直接通过）。

## 3. Agent 独立增补（AGENT-VERIFY §4"增加你自己的失败输入"）

R02（`calibration.test.ts` +7）：配置侧非法 targetTick、feeQuote 整字段缺失/null、
pauseConfirmedTick 类型非法、"稳定但发送条件不满足"三变体（同时断言
`*_stable` 仍 pass——非法的是数值语义不是基线形状）、controller level=5、
三样本反序中间缺字段不被掩盖（健康反序 pass 且输入字节不变）、T0 边界
（T=T0+2 fail / T0+3 pass / T0 与最后样本同 tick 的边界）。

R01/R03（`tools/independent.spec.cjs` +6）：initialize-on-existing 拒绝、写后
世界推进中止（单次写）、暂停后存储≠玩家读数不算确认、formal 前置拒绝即时停、
wrong_active_entry、control 模式第一条错误记录即时停。

增补测试自身修正 3 处（详见 offline/README.md；被测实现零改动）。

## 4. 正式验证（VALIDATION_HEAD=d0103c9）

| 命令 | 结果 |
|---|---|
| npm ci / tsc×2 / npm run build | 0 / 0 / 0 / 0 |
| jest-lab（lab 全目录） | 4 suites / 54 tests 全过（probe 25、runI 12、calibration 13、controlRemediation 4） |
| CLI 三路径 | healthy **0** / mismatch **1**（三项齐报）/ bad-input **2** |
| jest-slice0 / jest-treasury / jest-defense | 3/23、35/597、11/118 全过 |
| jest-full + budget | **243/1497 全过**；`JEST_TEST_BUDGET=PASSED` |
| 四产物构建 | observer/single-shot/main 三模式 + 只读 control-probe（PREPARED_NOT_RUN）全部成功 |
| 冻结×6 + diff-check | src（对 BASE）、生产（对 PROD_BASE 869149d）、根配置、冻结 lab 九文件、两个旧证据根、`git diff --check` 全部 0 |
| dist 未覆盖 | 生产构建后 ed34291d，四个实验/只读构建后仍 ed34291d；before=dad050be 为上轮遗留 bundle（buildTime 不同） |

终态断言：验证后 HEAD=VALIDATION_HEAD、工作树干净（`status-after.txt` 空）。
完整差异清单见 `formal-validation/full-name-status.txt`（本轮改动只落在
lab 目录、预算两文件与本证据根）。

## 5. 第二干净 worktree

同 SHA 独立 `npm ci`：`node --test` 四 spec **89/89**（83+6）、jest-lab 4/54、
slice0 3/23、四产物重建与主树**六产物逐字节 IDENTICAL**。不重复全仓压力/budget
（既定规则）。worktree 已清理。

## 6. R01–R03 验收回答（离线层面）

**R01（Memory 控制通路）**：工具链已按"仅 env 层 `env.keys.MEMORY+userId` 通路"
设计并实现——`local-runtime.cjs` 在连接时**核对安装字节**（driver
`lib/runtime/data.js` 的 `env.get`、`lib/index.js` 的 `env.set`、backend
`MAIN_LOOP_PAUSED`），路径不符即拒绝适配；`memory-control.cjs` 复用冻结的
`controlRecord.ts` 校验/4096 语义，initialize/arm/disarm 各恰好一次 env 写、
回读不等即停、无备用写入位置、无自动清槽；`storageConfirmed !== playerConfirmed`
显式分离；db mirror 不能充当玩家确认（离线反例在案）。**真实 runner 往返
（false 两次→arm→true 两次）未取得**——须授权后 S02。

**R02（预检完整性）**：七类已知漏检全部被新实现拒绝（P02–P12 于包内 spec，
Agent 增补覆盖排序/完整性/稳定性/T0 公式的额外变体与合法对照）；样本按真实
tick 排序解释（副本排序不改证据）、重复/非法 tick 拒绝、逐样本端到端完整+
稳定、报价逐样本可读、`max(基线tick) ≤ T0 且 T ≥ T0+3` 暂停点公式；CLI 保持
只读与 0/1/2 退出码；报告仍仅为预检（无新授权语义）。

**R03（及时停止）**：停止控制器离线全覆盖——窗口完成（T+20 有效末端样本）与
180 秒先到即停、触发→暂停请求 ≤1 秒（含"慢落盘不许伪装零延迟"反例）、暂停
确认与最终停止分离、5 秒稳定/挂起/非 OK/抛错全部进入有界进程树兜底、幂等、
日志失败不吞、deadline 不可续期、其他用户/tickStarted 不算完成。**真实
Windows 进程树终止与监听退出待实机**（`process-scope.cjs` 的 Windows 分支
逻辑经离线单测，未对真实进程执行）。

## 7. 实机（S01–S06）：AUTHORIZATION_REQUIRED

未运行。已就绪的实机入口：`tools/README.md` 的九步操作顺序（环境→只读探查
构建→initialize→observe-false→arm→observe-armed→facts→绑定最终 T→run-formal），
全部命令需要显式绑定参数且仅接受 loopback/合成用户/隔离环境。当前
`labConfig.ts` 仍为旧 cal-0002 已结束身份（T=201 是旧世界值，README 明确禁止
用它武装新世界）；新实验 ID/T/q/结构 ID 须在 S02 后从真实新世界读取绑定。

## 8. 证据索引

| 路径 | 内容 |
|---|---|
| `task/` | 实现包原件（任务书/验收指令/manifest/补丁/应用脚本）+ NOTE 说明 |
| `offline/first-round-directed/` | 原样状态首轮七命令原始输出 |
| `offline/formal-validation/` | 正式回归全部命令/JSON/冻结/产物与 dist 记录 |
| `offline/second-tree/` | 第二树复跑与六产物 IDENTICAL 比较 |
| `environment/`、`engine-run/` | 未运行标记（AUTHORIZATION_REQUIRED） |
| 工具源码 | 提交 b3207f9 引用（不复制进证据） |

# Control Remediation I · Engine Continuation

**交付对象：测试执行 Agent。此轮继续既有 S01–S06 实机验收，不重写 R01–R03，不接入国库生产 writer。**

日期：2026-09-09。配套 `changes.patch` 已实现一处测试隔离性修正，唯一修改文件为 `test/lab/terminal-transfer/tools/independent.spec.cjs`。

## 1. 起点与当前任务

| 项目 | 本轮依据 |
| --- | --- |
| 仓库 | `ceyirelehe47/screeps-bot` |
| 分支 | `refactor/empire-treasury-rearchitecture` |
| 预期起点 / 本小补丁基线 | `5773f1a04be8cadebf6cf0b111149ddb2ae752e9` |
| 已接受的离线验证 SHA | `d0103c9394e683a3c81e577b8b6f9e585c78f7f0` |
| 已归档全仓结果 | 243 suites / 1497 tests；预算通过 |
| 已归档工具测试 | Node 89/89；这是 wrapper 内部数量，不加到 Jest 总数 |
| 上轮实际运行状态 | 新实机 S01–S06 未运行；没有新的 100H 转运证据 |
| 当前唯一主目标 | 同一合成 bot 的真实 Memory 往返 → 一次原始 Terminal API 调用 → 后续世界事实 → 正确停止与取证 |

以上数字是继承的执行结果，不是这次补丁应用或新实验的预填结果。源码、测试、配置变化后的结果必须重新归属于实际验证 SHA。

**不要重新应用旧 `d69726a…` 基线的 17 文件实现包。** 它已经进入当前分支。本包只增量修正一个测试；所有运行工具和保护逻辑沿用已接受版本。

用户在离线验收后，针对“顺手收紧测试，然后继续现有 S01–S06”的建议回复了“继续吧”（本次会话消息时间 `2026-09-09T14:49:47Z`）。本文件是该后续工作的转交说明，不将旧 `cal-0002` 的授权扩为永久重跑许可。用户将本任务交给你执行时，继续的范围严格限于下一节这一场实验；已有覆盖该范围的执行指令，不再逐命令重复确认。执行会话存在更新、更严格的限制时，优先遵守，不以本文绕过限制。

## 2. 本轮运行与修改边界

仅新建**本机一次性隔离世界**、新合成用户和本次专用目录；固定 `W1N57 → W10N57`、同一合成用户、100H。包括无 send 路径的准备运行、实验控制槽写入与往返检查、最多一次正式窗口、取证、撤装和限定清理。

最多一次指真实 `terminal.send()` **调用**，不是最多一次成功。非 OK、抛错、不确定或前置拒绝后，都不得通过修改已固定 T、换身份、换世界继续试到成功。准备阶段的两次控制观察不是两次发送实验。

不得连接线上服务器、PTR、既有私服、真实账号或真实凭证；不执行生产上传，不合并 main，不增加市场、生产、搬运或战斗 writer。禁止修改 engine/driver 处理逻辑、替换 Game、注入伪交易、反向发送资源归还。

允许的代码改动只有：

- 原样应用本包测试修正；现有工具的被测实现不改。
- 为新世界绑定 `labConfig.ts` 与同步的文档示例，以及必要的测试配置引用调整。历史 fixture 和旧证据保持原身份，不将新配置倒灌成“历史原始读数”。
- 按实际代码与收集结果维护已有预算锚点、当前 OpenSpec 状态和新证据。这个测试修正本身不增加 Jest 或 Node 用例数量，不需要凭空增加预算。

继续冻结：整个 `src/`、两个 Slice 0 mock、`sendGate.ts`、`controlRecord.ts`、`worldRead.ts`、`sample.ts`、`observer.ts`、`singleShot.ts`、`runIMain.ts`、根依赖和构建配置。Treasury、Slice 0、Defense 已有的限定通过不重新推翻。

发现实际工具错误时，先停止并保存首个失败现场，再单独说明必要修复；不得静默改实现然后只报最终全绿。无需因为一个测试修正另开“Remediation II”或再造实验框架。

## 3. 应用测试修正并做最小回归

在干净工作树上检查起点和目标文件。远端已经前移时，先看增量，不覆盖其他人的改动，不 reset 已推送提交。

```bash
git status --short
git fetch origin refactor/empire-treasury-rearchitecture
git rev-parse HEAD
git rev-parse origin/refactor/empire-treasury-rearchitecture
git hash-object test/lab/terminal-transfer/tools/independent.spec.cjs
# 预期原始 Git blob：fd685c6c0bccdc6c6a80495f548e8344efc2d095

git apply --check /path/to/screeps-engine-continuation/changes.patch
git apply /path/to/screeps-engine-continuation/changes.patch

git diff --check
node --test test/lab/terminal-transfer/tools/independent.spec.cjs
node --test test/lab/terminal-transfer/tools/calibration.spec.cjs \
  test/lab/terminal-transfer/tools/memory.spec.cjs \
  test/lab/terminal-transfer/tools/stop.spec.cjs \
  test/lab/terminal-transfer/tools/independent.spec.cjs
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  test/lab/terminal-transfer/controlRemediation.test.ts
```

已有项目锁定依赖可复用；没有依赖则先 `npm ci`。每条实际运行命令保存 stdout、stderr、退出码，Jest 加独立 JSON 输出。

修正后的最后一个 Node 用例同时覆盖 expectedArmed=false/true：对齐用户、实验、采样器、端点等全部事实，仅翻转 `control.record.armed` 构造反例；第一条错误样本即请求暂停。相同合法输入的第一条不误停，第二个 tick 才正常确认。每组使用独立控制器和时钟，不共享失败状态。

预期收集数仍是 independent 6、全工具 Node 89、wrapper 4；具体以实际输出确认。不要将两个方向的循环次数或内部断言数加到 Jest 预算。测试修正提交后记录实际 SHA。

实现者本地已经运行相关 20 个 Node 用例，其中包括这 6 个，全部通过；不是 20+6 个不同用例。另在临时副本中验证：旧测试发现不了“跳过 armed 比较”和“所有控制样本均拒绝”，新测试能同时发现。变异只用于诊断，**不得把变异后的运行实现复制进仓库或部署到实验世界**。见 `validation/`。

## 4. S01：新环境与可核对的安装

继续当前任务的 S01，不重新创建一套 Prep 任务。

在新目录中安装独立 standalone，保留实际 server package/lock、安装命令、退出码、解析路径、实际包版本及 Memory 读写相关源码身份。旧安装组合只供参考，不能代替新安装的读数。

监听仅使用本机 loopback，记录本次创建的目录和进程。端口被未知服务占用就停止，不杀未知服务。实验工具要求绑定实际 Node launcher（绝对脚本路径位于隔离根内），不能把 shell/npm 父进程冒充 launcher。所有终止操作只能针对已核对的实验进程树。

工具已有约一秒/tick的实验条件及五秒用户 console 通道保护；不在运行中扩大期限来掩盖环境不适配。初始只读观察仍需外部限时与完整收集，不能无人看管地自由运行。

证据保存在隔离世界目录之外；不把真实凭证写入日志或提交。

## 5. S02：真实控制往返，正式 T 暂不绑定

完成地图、房间、两个 Terminal 的合法初始化及必要缓存更新后，停止管理侧资源和地图变更。用真实玩家视图取得 shard、用户名、两端 ID、归属、active、控制器、H、energy、容量、冷却和费用。不得直接照抄 `Forst`、旧 ID、26 或 T201。

准备阶段先绑定本轮身份和真实报价；`targetTick` 仅作为无发送准备入口中的占位值，不构成正式窗口。先提交准备源码再构建只读探查产物，只装载该入口，并回读活动模块验证字节。

按当前 `tools/README.md` 和 `lab-control.cjs --help` 的真实参数执行：

**初始化并暂停稳定 → inspect → initialize → observe-false → arm → observe-armed → facts。**

具体要求：

1. 真实 runner 正常初始化的整份 env Memory 必须可读为 JSON 对象。缺失/损坏不能通过管理工具自动写 `{}` 掩盖，也不能改写 `db.users.memory` 代替实际通路。
2. `initialize` 仅创建缺失的实验槽，保持 `armed=false, attempted=false`，不覆盖已有未知槽或尝试历史。
3. `observe-false` 使用没有 send 路径的同一个 bot 取得两个不同 tick 的未武装记录，自动暂停；保存原始 console 与暂停后的 env 读数。
4. 用该原始 proof 执行一次 `arm`，再用同一个只读入口执行 `observe-armed`，取得两个不同 tick 的已武装记录，自动暂停。不能只凭管理侧写后读回宣称玩家确认。
5. 暂停后 env 记录与玩家读数一致，`attempted=false`，没有结果/尝试痕迹；之后保持同一条记录，不重新初始化。
6. 运行 `facts`，取得独立基线与稳定暂停点 T0。此后才首次固定最终 T。

每个工具命令使用独立的新 `--out` 目录，不覆盖上一个命令的失败记录。工具只核对装载，不负责上传；你仍须执行本地合成 bot 的实际装载并保存回读原件。

准备阶段有真实失败时，保留现场并交付诊断；不得重置已经武装或结果不明的控制事实，追求形式上的“两次都读到了”。

## 6. S03：最后一次绑定与正式验证

世界保持暂停，固定 **T ≥ T0+3**，其他身份、路线和已武装记录不变。费用上限由新鲜真实基线固定，发送时超上限仍拒绝，不动态扩大。

同步 `labConfig.ts` 与文档示例，记录配置和事实来源。若旧回归用例引用当前配置，却实际表达旧场景，应将其明确绑定到历史 fixture 或新增独立的本轮事实副本；不修改历史原件、不用当前 config 自动生成“真实世界”。不得仅为绿测删掉反例。

把实际执行的代码、测试、配置和管理/判读工具提交，固定本轮 `VALIDATION_HEAD`。在这个最终版本完成既定正式验证：两套 tsc、生产构建、lab、Slice 0、Treasury、Defense 固定回归、全仓 Jest、budget、冻结 diff 与产物核对。清除 `DEST`，不运行任何生产上传命令。

**减少重复工作的安排：** 第3节的测试小修先做定向回归即可；不要为它单独跑一遍全仓压力，随后配置绑定后又完整跑一遍。将本次完整正式回归集中在最终绑定 SHA。代码或配置之后再改变，必须重新核对受影响验证的有效性，不能把旧 SHA 的结果写成新 SHA 的结果。

第二干净工作树仍独立 `npm ci`，只复跑 lab、工具、Slice 0 和实验产物身份，不重复完整压力与 budget，不重复发一笔。现有的243/1497是否仍成立，以本次收集为准，不预填未来结果或不存在的提交锚点。

构建正式三模块，回读合成 bot 实际活动分支，要求模块集合和逐字节 hash 对齐当前代码及各产物 manifest。重新确认之前玩家实际读到的武装记录仍在、世界仍暂停、端点事实未变、窗口仍可取得。

## 7. S04：只运行一次正式窗口

使用已经实现的 `run-formal`。命令形式如下；所有变量由这次实测和创建结果赋值，禁止使用旧世界值。三个产物各自保留同目录 manifest。

```bash
node test/lab/terminal-transfer/tools/lab-control.cjs \
  --command run-formal \
  --environment "$ENV_ROOT" --host "$LOOPBACK_HOST" --port "$STORAGE_PORT" \
  --pid "$LAUNCHER_PID" --user "$SYNTHETIC_USER_ID" --username "$SYNTHETIC_USERNAME" \
  --experiment "$EXPERIMENT_ID" --out "$NEW_FORMAL_OUTPUT" \
  --proof "$ARMED_OUTPUT/console.jsonl" \
  --facts "$FACTS_OUTPUT/calibration-facts.json" \
  --observer "$OBSERVER_OUTPUT/observer.js" \
  --single-shot "$SINGLE_SHOT_OUTPUT/single-shot.js" \
  --main "$MAIN_OUTPUT/main.js"
```

`LOOPBACK_HOST` 只能是工具接受的 `127.0.0.1` 或 `::1`。实际命令、工作路径、环境绑定和退出码均留档。

工具核对真实 env、活动模块、proof 与预检，订阅通道就绪后设置固定180秒期限，再恢复一次。既有 main 在 T−2..T+20 每 tick 先 observer，只有 T 调用 single-shot。不得管理员直接调用 send 替代玩家代码。

正常完整窗口是23个样本；若前置拒绝、观测/通道错误或其他故障使工具提前停止，真实保留提前结束，不继续恢复去凑23行。正式恢复之后即使 send=0，本任务也不再换 T/ID/世界重来。

## 8. S05：停止和收尾作为事实分别核对

窗口完成或180秒先到请求暂停，异常允许更早停止。末端样本的接收时刻到**实际暂停调用**应符合已实现的1秒要求，不能扣掉日志落盘耗时。暂停返回、暂停标记、稳定 tick、最后进程退出不是同一个事实。

沿现有工具确认暂停稳定，保留终态快照与控制槽，然后撤装，保留 attempted 和同步结果。记录真实使用或未使用进程终止兜底；未触发的故障分支不得写成实机验证通过。

终止本次绑定的完整进程树，核对后代 PID 与监听状态。根 PID 消失不代表 worker 全部退出；未知进程不在本次清理范围内。暂停或退出未确认，保留相应失败结论，不用“库存没变”代替停止证明。

先保存必要原件，再清理自己创建的环境。不得为了验证停止故障再开启一个正式发送窗口，也不要求破坏这次正常实验去强制触发 kill 兜底。

## 9. S06：实际发生了什么，以及什么还未证明

最终报告分开回答：

| 事实 | 需要的证据 |
| --- | --- |
| 玩家 Memory 往返 | 同一 bot 的 false两tick、一次arm、true两tick，暂停后实际env一致 |
| 调用次数与返回 | 真实调用边界、同步返回/异常、控制事实；不能把前置拒绝当API错误 |
| 转运结果 | 后续玩家视图与相关交易联合核对，而非仅返回OK |
| 时间与覆盖 | 逐tick索引、首次看到结果的tick、缺口/重复/截断；不预设一定T+1 |
| 停止与退出 | 触发/请求/响应/稳定tick/延迟、完整进程树与端口退出 |

在隔离且无其他资源变化的正常对照中，应核对源 H 减100、目标 H 加100、源 energy 扣本次实际费用 q、目标容量占用相应变化，并观察冷却和相关交易。费用与 tick 以本次真实读数为准，不预设q=26。交易 description、双方、路线、资源和数量须匹配；同一个交易 ID 的两个视图不是两笔转运，矛盾或多条相关交易不能挑一条判成功。

`run-formal` exit 0、`stop-result.ok` 和全仓绿测都不能独立作为转运成功结论。仅缺少日志也不能断言零调用；证据不足就保留不确定。

只有该单次实验的准备、真实调用、后续世界结果、覆盖和停止均有充分材料，才写当前任务约定的 `ENGINE_LAB_PASS`。正式窗口未启动、已启动但不充分、实际存在不符等情形继续使用既有分层状态，并列具体事实，不另建状态协议。

即使正常原始 API 实验通过，也**不等于国库生产 writer 已集成，不放行正式部署、自动重试或其他经济业务**。到本轮报告和push即停。

## 10. 证据与提交

沿用证据根：

`openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i-control-remediation-i/`

已有 `offline/`、任务归档、`AUTHORIZATION_REQUIRED/未运行` 原件保留。在该根下新增本次明确命名的执行子目录，例如 `engine-continuation-0001/`，保存新的环境、控制、绑定、窗口、停止和报告。编号用于归档，不是自动重跑额度。

保存必需原件即可，不重新复制全套旧证据：本包与应用后diff、测试命令与原始结果、实际SHA、server package/lock与解析、活动代码完整回读、管理Memory请求/回读、原始console、独立facts与C02、调用与终态、停止日志、PID/端口检查。原始文件与派生解码结果分开，错误输出也保留。

不要把本包 `review-source/` 或测试副本作为额外源码复制进仓库；源码以已提交 SHA 引用，避免副本被 Jest 重复收集。只应用 `changes.patch` 中的一处改动。采集结果写到新目录，最终再归档，不让正式验证中源码树变脏。

线性提交：测试小修、必要实测绑定/配置调整、验证锚点（确有需要时）、证据与当前状态。禁止 amend 已push提交、rebase、force push、合并main或生产部署。

最终回复首先说清：**有没有真正调用一次 send、是否观察到100H到账、是否及时停止**。再列提交SHA、实际测试结果与仍未验证的边界。不以继续等待授权、只交Prep报告或另写通用机制替代已经明确范围内的执行；确有新的限制或真实阻塞，则保存并明确说明其具体来源。

## 11. 依据与本包本地验证边界

仓库依据均锚定 `5773f1a04be8cadebf6cf0b111149ddb2ae752e9`：

- 当前证据根的 `terminal-transfer-engine-lab-run-i-control-remediation-i-offline-validation.md`、`offline/README.md`、`offline/formal-validation/`、`offline/second-tree/`：上轮离线结果与未运行范围。
- `test/lab/terminal-transfer/tools/independent.spec.cjs`：本次修正对象。
- 同目录 `README.md`、`lab-control.cjs`、`memory-control.cjs`、`stop-controller.cjs`：实际命令与流程。
- 已转交的 Control Remediation I 任务书与 `AGENT-VERIFY.md`：继承的 S01–S06、验证和冻结约定；本文只明确接续安排和测试小修，不恢复其已完成的实现待办。

本包由ChatGPT在选定源码副本上实现。GitHub连接器读取正常；本地git再次尝试仍因DNS失败，未完整检出仓库。运行环境是Node v22.16.0和全局TypeScript5.8.3，实际运行了20个相关Node用例及测试敏感性检查，使用模拟I/O，没有游戏连接、真实send、真实进程终止或远端push。完整仓库和真实引擎由你继续验证。

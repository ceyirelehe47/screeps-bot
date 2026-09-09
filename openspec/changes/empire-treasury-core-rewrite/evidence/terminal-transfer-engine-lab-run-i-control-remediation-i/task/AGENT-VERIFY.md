# Control Remediation I — 代码应用与独立验收

本包已经包含实现，不需要按旧任务书重写。先在原样应用状态下验证；失败时保留失败输入、实际源码 SHA、命令和原始输出，再单独修复。不能边测试边静默修改，然后只报最终 PASS。

## 1. 起点与范围

仓库 `ceyirelehe47/screeps-bot`；分支 `refactor/empire-treasury-rearchitecture`。
补丁基线：`d69726a92d46c3ab334355a6625ef253c1523a86`。
继承的全仓验证来自 `7b9135985ab3ce02192c853f051e76005562866e`；旧预算 242 suites / 1486 tests，预算锚点 `13511d8dd95fc6044fe597b5a019c4a84699882a`。这些不是本补丁的新验证结果。

本包只修改 `test/lab/terminal-transfer/calibrationCheck.ts`，新增该实验目录下的工具、fixture 和 `controlRemediation.test.ts`。生产 `src/**`、原发送门禁、attempted/4096 字节保护、main/observer/single-shot、根依赖及构建配置保持不变。原实验 `INCONCLUSIVE` 及其原始证据不改写。

## 2. 应用原样补丁

把本包解压到仓库外，先确保 Agent 的实际工作树没有另一个正在实现的同轮改动。不要覆盖对方尚未提交的代码。

可用包内辅助脚本（Python 3.9+，只执行本地校验与 `git apply`，不 commit/push）：

```bash
python /path/to/package/apply_patch.py --repo /path/to/screeps-bot --check-only
python /path/to/package/apply_patch.py --repo /path/to/screeps-bot
```

也可核对 `source-manifest.json` 后，手动执行 `git apply --check changes.patch` 和 `git apply changes.patch`。脚本要求准确基线和干净工作树；HEAD 已前移时，先说明新增提交与本包的关系，不能用 `reset --hard`、force 或跳过冲突强贴。本包的 `modified-files/` 便于审查，不是绕开补丁检查全量覆盖仓库的入口。

实现者本地是“由已核验文件重建的选定文件工作树”，不是完整仓库。不要将其本地合成 Git commit 写成远端提交；当前代码未 push。真实应用后，由 Agent 的提交 SHA 标识交付代码。

## 3. 开发期已经实际完成的检查

见 `validation/summary.json` 及原始 TAP：83 个 Node 测试通过，包含预检反例、原 CLI 0/1/2 退出码、只读 probe 产物、Memory 更新逻辑、停止控制器与实际 session 连接逻辑的模拟端口测试。测试 I/O 端口和时钟被明确替换，没有启动游戏服务器或终止真实进程。

选定文件 TypeScript 检查使用 5.8.3 和临时 Game/Memory 类型占位，不能替代项目 5.9.x / 官方 Screeps 类型的全量检查。完整仓库 Jest、完整依赖安装、Windows 进程树、真实 env Memory 往返和 terminal.send 全部尚待 Agent。

包内 patch 应用验证在同一执行者的重建基线上做过，不是第二个完整仓库环境，也不是独立审查。

## 4. Agent 必须独立检查的重点

**预检：** 缺任一 tick 的任一交易视图、旧样本读取失败但残留数值、目标字段缺失、资源/容量/冷却变化、乱序隐藏最新不足、重复/非法 tick、T0 已越过窗口首 tick，均不得通过。健康正序/反序与非 26 报价对照应通过。增加你自己的失败输入，不只复制本包测试。旧 `calibration.test.ts` 的所有有效要求继续保留。

**Memory：** 先确认安装包实际读写 env Memory 路径。数据库 mirror 写入成功不算玩家确认。原样验证只读准备入口、两 tick false、只武装一次、两 tick true、暂停后记录一致，最后才固定 T。记录不存在/损坏/不匹配/已 attempted/已 stopped 不能被自动修复后继续发送。撤装必须保留 attempted、同步结果并关闭本实验。

**停止：** 完整窗口到达、180 秒、控制读取错误、日志/通道故障、暂停调用挂起或失败、进程身份改变，分别测试。关注原始接收时刻到实际暂停调用的延迟；不能只把调用前写的“已停止”日志当成成功。特别验证真实 Windows 的 Node launcher 身份解析、后代进程终止及监听退出；根 PID 消失不代表 worker 全部退出。

**产物与入口：** 准备阶段活动模块只能是只读 probe；正式阶段只能是已验证的三产物，并且与最终验证 HEAD、manifest 和活动模块回读相符。运行工具 exit 0 / stop-result.ok 不是 send 成功判定。

## 5. 验证顺序与预算

先在应用补丁但未额外修改的状态下跑定向检查，保存首轮原始结果：

```bash
unset DEST
npm ci
node --test test/lab/terminal-transfer/tools/calibration.spec.cjs \
  test/lab/terminal-transfer/tools/memory.spec.cjs \
  test/lab/terminal-transfer/tools/stop.spec.cjs
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.build.json
npm run build
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  test/lab/terminal-transfer/probe.test.ts \
  test/lab/terminal-transfer/runI.test.ts \
  test/lab/terminal-transfer/calibration.test.ts \
  test/lab/terminal-transfer/controlRemediation.test.ts
npx jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/runtime/treasury/treasuryTerminalTransferSlice0.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationI.test.ts \
  src/runtime/treasury/treasuryTerminalTransferSlice0RemediationII.test.ts
```

每条命令保存退出码、stdout/stderr，Jest 加独立 `--json --outputFile=...`。`unset DEST` 是 Git Bash 写法；使用 PowerShell 时清除对应环境变量。不要调用 `npm run push`、`local` 或任何生产上传入口。

先提交实际实现，记录 `IMPL_HEAD`。本包没有修改预算两个文件：未来的实际提交 SHA 不应由实现者伪造。Agent 根据实际 Jest 收集结果更新 `test/test-suite-budget.json` 与 `scripts/verify-jest-budget.mjs` 中的现有计数/锚点，不改校验器逻辑、不删除断言、不扩大旧压力界限；再提交，固定 `VALIDATION_HEAD`。

新增 wrapper 是一个 Jest suite、三个 Jest tests；83 是 Node 内部测试数。若无其他变更，全仓计数预期增加 1/3，但必须以实际收集结果确认，不能填成 1486+83。

最终固定 SHA 执行原任务的 Treasury、Defense 固定回归、全仓 Jest、budget、构建、冻结 diff 和 `git diff --check`。第二干净工作树独立 `npm ci`，复跑 LAB（含新 wrapper）、Slice0 和产物核对；不需要再重复所有全仓压力。已有长测试按既定规则运行，不为加快完成缩短或跳过。

生产历史冻结基线仍为 `869149dcdd6f2068572354917bf23c52727cf9b6`；此外对本包 BASE 核对整个 `src`、根依赖/配置和冻结 lab 文件无差异。实验构建前后比较同一个生产 dist 文件确认没有覆盖，而不是要求两个不同 buildTime 的生产构建 hash 相同。

## 6. 实机验收边界

沿用 `reference-task.md` 的授权、单次业务和 S01–S06 边界；工具使用步骤见仓库新增 `tools/README.md`。实际授权由执行会话判断，本包本身不授予启动或发送权限；已有明确覆盖新实验的授权不必逐命令反复确认。

只运行新本机一次性世界、新合成用户、固定 W1N57→W10N57、100H，最多一次真实 send 调用，无市场、无其他经济 writer、无故障后重发。当前 `labConfig.ts` 中 cal-0002/T201 是旧已结束运行，严禁直接用它武装新世界。

准备阶段从真实新世界取得身份/费用并绑定；最终 T 必须在真实武装往返之后首次固定。最终绑定改变源码，就记录新的代码 SHA、重建并执行受影响验证，不能沿用旧产物 hash。固定的历史回归资料保持原身份；不得把新世界字段写进旧原始证据。

保存实际 server package/lock、依赖解析路径与源码 hash、启动/监听/进程身份、独立基线、只读 probe 活动字节、两次控制观察原始 console、管理写入前后实际 env 原件、最终三模块装载回读、逐 tick 窗口和同步返回、两端库存/费用/容量/冷却/交易、暂停及完整进程退出原件。

判读仍联合调用边界、实际返回与后续世界事实。同交易 ID 镜像不重复相加；缺视图、多个相关交易或相互矛盾结果不能挑一条判成功。正常 API 实验通过也不是生产国库接入或正式部署放行。

## 7. 交付与失败处理

先报告补丁原样首轮验证，再报告单独的必要环境适配或代码修复。逻辑修复保留原失败输入与前后对照。不要因工具报错就放宽门禁、重置控制槽、改变已固定 T、换实验 ID 连跑到成功。

成功或不确定都必须保存证据并停止；只清理本次新建环境，不清理未知服务。原始失败记录不改写。最后线性 commit/push 到既定分支，不 amend 已 push 提交、不 rebase、不 force push、不合并 main。

最终回复分开列：应用基线与代码 SHA、定向/全仓/第二树结果、R01 玩家确认、R02 反例、R03 暂停/进程退出、真实 send 次数和是否转运、未完成事项。不能只给一个 PASS。

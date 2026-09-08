# Terminal Transfer Engine Lab Run I——本地验证主报告

状态：**AUTHORIZATION_REQUIRED**（离线接线完成并验证；真实引擎 **NOT_RUN**）。

编制日期：2026-09-08。任务书：`task/task-brief.md`（30,352 字节，SHA-256
`e680c84e795a794ab20b90e2d8ded3c845c3e6d6c7f4b64a8d09d455999cdccc`）。
验收索引 S01–S06；本轮覆盖离线可完成的接线与验证部分，S01 的授权前置
（任务书 §0）**未满足**——用户尚未给出明确运行授权，因此不启动任何游戏
服务、不安装服务器依赖、不装载、不武装、不发送。

## 0. 提交链

| 提交 | 内容 |
| --- | --- |
| `afe839d` | Lab Run I 离线接线实现：runIMain.ts + 构建器 --mode run-i-main + runI.test.ts（7 it）+ 文档 |
| `15b027b` | 预算真实收集与锚点滚动（240/1465→241/1472）＝VALIDATION_HEAD |
| `<本报告提交>` | 证据归档与主报告 |

起点 `9158c496…`（与任务书 §1 预期一致，本地=远端核对通过，工作树干净）。

## 1. 交付内容（对照任务书 §2.1/§4.4）

- **薄 main 入口** `test/lab/terminal-transfer/runIMain.ts`（构建模式
  `--mode run-i-main` → `main.js`，7430 字节，SHA-256 `44f624cc…`）：窗口
  `T−2..T+20`（23 tick）内每 tick 先 observer 后（仅 `Game.time===T`）
  single-shot；模块加载零动作；Screeps 运行时 `require("observer")`/
  `require("single-shot")` 装配（三模块字节独立，observer/single-shot 保持
  原始产物字节）；窗口外/装载晚错过 T 零调用不补调；不直接 send、不碰
  控制槽、不复制门禁；窗口首 tick 一行装配信息（console 零 Memory 写）。
- **离线接线测试** `test/lab/terminal-transfer/runI.test.ts`（7 it）：
  三产物真实构建后 VM 按 Screeps 模块系统装配——装载零动作、窗口外
  （T−3/T+21）零调用、窗口内非目标 tick 只采样、目标 tick 先 observer 后
  single-shot 恰一次（完整窗口 send=1、控制槽 attempted+stopped 且完整
  JSON ≤4096 UTF-8 字节）、无武装 send=0 零控制槽写、错过目标 tick 不
  补调；并断言构建器加入第三模式后 observer/single-shot 产物与
  Remediation II 归档**逐字节一致**（9160B/96721926…、27697B/7730421d…）。
- **文档**：`terminal-transfer-engine-lab-run-i.md`（模块三件套/边界/授权
  后动作顺序/AUTHORIZATION_REQUIRED）；tasks.md 新段。
- `labConfig.ts` 保持合成示例配置——真实实验身份（实验 ID/用户名/shard/
  结构 ID/目标 tick/费用上限）须在真实世界读回后填写并重新提交、构建、
  验证（任务书 §4.3）；本轮不可发送。

## 2. 离线验证（全部通过）

### 2.1 主验证（offline/mainval/，19 步全部 exit 0）

四组冻结对比零差异（生产源码/配置/Defense 相对 869149d；Slice 0 实现
与既有 lab 全部源文件相对起点 9158c49）；typecheck×2；npm run build；
三 lab 构建（全 PREPARED_NOT_RUN，repoSourceCommit=15b027b）；五组 Jest
全绿（lab 2/29、key 10/109、treasury 35/597、defense 11/118、full
241/1472）；verify-jest-budget PASSED 241/1472；verify-evidence PASS；
diff-check 0；验证前后 `git status` 零字节、HEAD 未移动；三次实验构建未
触碰 dist/main.js。

### 2.2 新观察：生产构建跨构建非确定（既有事实，如实记录）

`rollup.config.js:43` 注入 `buildTime`（`new Date().toISOString()`），连续
两次 `npm run build` 的 dist/main.js sha256 必然不同（本轮实测
e4708d09…→3a496afc…）。因此本轮不以"生产 bundle 前后一致"作冻结证据
（上轮曾用该断言形式），改用"生产构建后 vs 三次实验构建后"对比（cmp
通过：实验构建不覆盖 dist/main.js）；冻结以源码 git 对比为准。本轮未改
rollup.config.js（config-freeze 零差异可证），该非确定性非本轮引入。

### 2.3 第二干净工作树（offline/second-tree/，6 步全部 exit 0）

VALIDATION_HEAD detached worktree + 独立 npm ci（lockfile 双树一致
490ee9c7…，jest/typescript 解析路径均落第二树）；LAB 29/29（runI=7、
probe=22）、Slice 0 23/23；三产物字节与主树一致。worktree 已清理。

### 2.4 预算

全仓真实收集 241 suites/1472 tests/1472 passed（failed/pending/todo/
runtime error 全 0）；baseline/target 同滚至 `afe839d`（文件集对比要求
基线树含新增 runI.test.ts）；`node scripts/verify-jest-budget.mjs` 自跑
PASSED（主验证内再次全仓复跑亦 PASSED）。

## 3. 授权状态与未执行边界（S01–S06 对照）

| 项 | 状态 |
| --- | --- |
| S01 授权/隔离/版本 | **AUTHORIZATION_REQUIRED**——无授权，未安装服务器依赖、未启动服务、无新建环境事实 |
| S02 真实只读基线 | NOT_RUN（依赖 S01） |
| S03 固定代码单次调用 | 离线面就绪（三产物+接线验证）；真实装载 NOT_RUN |
| S04 后续真实结果 | NOT_RUN |
| S05 停止与无污染 | 无进程/环境需要停止（未启动任何服务；实验构建只写临时/证据目录） |
| S06 可审查交付 | 离线部分成立（本报告+原始产物）；实机部分待授权后补充 |

**本轮未做**（全部待授权）：安装 `screeps@4.3.0` 组合、创建实验世界/合成
bot、装配真实 runner 日志通道、读取真实身份回填 labConfig、装载/武装/
恢复运行/单次发送/观察窗口/判读/清理。两个探针与 main 均未上传、未装载
到任何游戏世界、未调用真实 terminal.send、未读取任何真实凭证或玩家
Memory。

## 4. 授权后的执行入口

任务书 §0 的授权文字（用户明确认可后生效）：

> 允许按 Engine Lab Run I，在本机新建、仅本机可访问的一次性 Screeps
> 实验环境，安装隔离依赖、启动必要服务、创建合成 bot 用户与两个
> Terminal、装载实验探针，并最多调用一次发送 100H。允许保存证据后停止
> 并清理本次新建环境。不接入正式服、PTR、既有私服或真实账号，不使用
> 真实凭证，不接入国库生产 writer，不进行第二笔发送或故障注入。

授权后动作顺序见 `terminal-transfer-engine-lab-run-i.md` §3 与任务书
§3–§5（命令参数以实际安装版本的 CLI 帮助核对后归档，不沿用模板）。

## 5. Git 与 CI

线性提交（afe839d → 15b027b → 本报告提交），无 reset/rebase/force push/
amend/合并。推送 `refactor/empire-treasury-rearchitecture` 并核对远端
HEAD（见下方提交后补记）。CI：仓库无 .github 工作流（check-runs/statuss
为空）——无 CI 证据，如实标注。

## 6. 结论

Lab Run I 的**离线接线部分已交付并验证**：三模块实验包（observer +
single-shot + 新增薄 main）可在真实 Screeps 模块系统语义下正确协作，
目标 tick 恰一次发送尝试、无武装零发送、窗口边界与错过语义全部由实测
产物断言锁死；既有探针字节零变化。**真实引擎实验未开始**——等待用户
按任务书 §0 给出明确授权；授权前一切实机前置（S01）保持 AUTHORIZATION_
REQUIRED，真实引擎保持 NOT_RUN。

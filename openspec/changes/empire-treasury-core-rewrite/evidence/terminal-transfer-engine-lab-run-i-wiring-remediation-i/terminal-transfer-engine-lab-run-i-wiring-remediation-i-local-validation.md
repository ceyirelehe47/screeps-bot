# Terminal Transfer Engine Lab Run I · Wiring Remediation I——离线修复验证报告

- 编制日期：2026-09-09。执行者：开发 Agent（同一执行者，第二树复验非独立审查，如实标注）。
- 任务书：`evidence/terminal-transfer-engine-lab-run-i-wiring-remediation-i/task/task-brief.md`（24301 字节，SHA-256 `9f88d9dbce735a015e5e95381a27d581b0724809b81ea4c56a567f5ab91f5b58`）。
- 验收索引：**T01–T04**。

## 0. 提交链（线性，无 reset/rebase/force push/amend）

| 提交 | 内容 |
| --- | --- |
| `05585e0e163d3774bb81fa7f4b47a8f1f04222b2` | 实现：runIMain.ts 单向依赖修复＋runI.test.ts 7→12 it＋lab-run-i.md／tasks.md |
| `69e6373fdb6447488ce247b7cef1b3cb87e1d816` | 预算真实收集与双锚点滚动（241/1472→241/1477） |
| `324f21a53ea128661e0555de662db7891b9b3808` | task/baseline 证据（执行驱动入库）＝**VALIDATION_HEAD** |
| （本报告所在提交） | final/revalidation 证据＋主报告＋tasks.md 勾选 |

起点核对：本地＝远端＝`457b052e1c7300a91a8b85c6337cfbf244968ce0`，工作树干净（任务书预期起点一致）。

## 1. T01——基线复现与最小修复

**基线复现**（`baseline/`：`baseline-repro.cjs`＋`baseline-results.json`＋`baseline-run.log` exit=0）：旧 main 产物三重身份核对（7430B／Git blob／SHA-256 `44f624cc…`）后与真实归档 observer（9160/`96721926…`）、single-shot（27697/`7730421d…`）在 Node VM 按 Screeps 模块系统装配，故障只经 main 沙箱 require 边界注入，其余条件全部合法（目标 tick、正确合成身份、充足资源/费用/容量、合法武装小控制记录）：

| 场景 | 模块错误 | observer 调用 | single-shot 解析/调用 | send |
| --- | --- | --- | --- | --- |
| require("observer") 抛错 | observer:require | 0 | 1/1 | **1（缺陷复现）** |
| observer 返回 `{}` | observer:loop-export | 0 | 1/1 | **1（缺陷复现）** |
| observer 返回 `{loop:1}` | observer:loop-export | 0 | 1/1 | **1（缺陷复现）** |
| observer 返回 null（同组补充） | observer:loop-export | 0 | 1/1 | 1 |
| observer.loop 向外抛错 | main-error:dispatch | 1（已尝试） | 0/0 | 0（旧外层 catch 已阻断） |
| normal（真实三模块） | — | 1 | 1/1 | 1（正向对照） |

**最小修复**（`runIMain.ts`）：`requireLabModule("observer")` 返回 null 即 `return`（本次不解析 single-shot，一处改动）；`observer.loop()` 抛错仍沿既有外层 dispatch 异常路径结束；错误日志复用既有 `lab-run-i-module-error`／`lab-run-i-main-error` 种类，零新增状态机；头注释删除"观察路与发送路独立，一路不可用不阻断另一路"错误表述，改为单向依赖描述。窗口 T−2..T+20、先观察后发送、错过 T 不补调、void 返回语义全部保留。

## 2. T02/T03——失败路径产物测试与单向依赖回归（runI.test.ts 7→12 it）

实际构建三产物（仓库构建器）后 VM 装配；注入仅发生在模块解析或 observer 调用边界（`moduleFault` 谓词按模块与当前 tick 决定，不修改 Memory、不取消武装）。12/12 通过：

1. observer require 抛错（目标 T、合法武装）：模块错误指向 observer:require；single-shot 解析 0、调用 0、send 0；控制槽内容与引用不变；无发送边界输出；T 重复调用与 T+1 均无发送；T+1 恢复真实 observer 继续观察不补发。**同世界正常模块对照 send=1**——零发送处于所有 single-shot 前置均可通过的合法场景，证明拒绝原因是 observer 装配故障而非其他门禁。
2. observer 导出不合法：`{}` 缺 loop 与 `{loop:1}` 非函数两固定变体（均 T 重复＋T+1 恢复观察不补发、槽不变）＋null 同组补充（单点）；模块错误均指向 observer:loop-export。
3. observer.loop 向外抛错：observer 已被尝试调用（计数）；沿既有 `lab-run-i-main-error` stage=dispatch 出口结束；single-shot 零解析零调用 send 0；注入不修改 Memory 不取消武装（槽引用与内容不变）。
4. single-shot 缺失（require 抛 unknown module）或导出不合法（`{}`）反方向：真实 observer 在 T 及后续窗口继续采样（23 tick／23 样本）；send 0、槽不变——发送侧故障不被改成停止观察。
5. 同 T 重复调用目标 tick（正常三模块独立场景）：send 恰 1、发送边界一组（pre-call/boundary/sync-return）、attempted/stopped 终态与 ≤4096 UTF-8 字节保持。
6. 既有 7 it（清单自洽、装载零动作、窗口外、非目标 tick、目标 tick 恰一次、无武装、错过 T）原样保留零改动——本测试从未断言旧"互不阻断"语义。

叶子产物未变：observer/single-shot 构建结果与 Remediation II 归档逐字节一致（it 断言＋主验证＋第二树三重核对）；main 按本轮实际身份核验（7721B／SHA-256 `0a71f720f1d6f85339b21dbf8e7288cfa2e65f5949b223f5418684b673aad3ad`），不再要求等于旧 7430B/`44f624cc…`。

## 3. T04——固定提交验证与交付

- **主验证**（`final/`，VALIDATION_HEAD=`324f21a`）：§7.2 模板 19 步全 0——四组冻结（production/config 对照 `869149d` 零差异；existing-implementation 对照起点 `457b052` 零差异：2 mock＋9 个 lab 既有文件＋构建器）、typecheck×2、build、三 lab 构建、六组 Jest（lab 2/34、slice 3/23、key 10/114、treasury 35/597、defense 11/118、full **241/1477** 全零失败）、budget PASSED、verify-evidence PASS、diff-check、前后状态零写入、head-after 断言；生产 bundle 在三次实验构建前后未变（buildTime 跨构建非确定性为既有事实，冻结以源码 git 对比为准）。
- **第二树复验**（`revalidation/`）：同 VALIDATION_HEAD detached worktree＋独立 `npm ci`（lockfile hash `490ee9c7…` 双树一致、依赖解析落第二树）；LAB 2/34（含两项 observer 故障实际产物行为与 single-shot 缺失观察对照）＋Slice 0 3/23 全绿；三产物 hash 与主树一致；worktree 已清理。首跑在身份核对一步因相对路径 ENOENT 失败（前序步骤均已成功），修正后完整重跑 TREE2_COMPLETE——两份 wrapper 日志如实归档。
- **预算**：全仓真实收集 241/1477/1477（failed/pending/todo 全 0）；`test-suite-budget.json` 与 `verify-jest-budget.mjs` 双锚点同滚至实现提交 `05585e0`；`files.runI.test.ts` budget 7→12；自跑 PASSED。
- **Git 交付**：线性提交（见 §0）；`git diff --check` 0；push 后以 `git ls-remote` 核对远端＝本地（结果见 tasks.md 勾选条目与交付回复文字）；CI 证据：仓库无 `.github` 目录，GitHub status/check-runs 无结果——**无 CI 证据**（如实）。

## 4. T01–T04 对照与状态结论

| 索引 | 结论 | 依据 |
| --- | --- | --- |
| T01 基线与最小修复 | **通过** | §1 六场景基线（两固定反例 send=1 复现）＋null 即 return 最小修复 |
| T02 失败路径产物测试 | **通过** | §2 用例 1–3：三项故障均阻断 single-shot 解析/调用、错误来源明确、控制槽零变化、非其他门禁偶然拒绝（正常对照 send=1） |
| T03 单向依赖与回归 | **通过** | §2 用例 4–6＋既有 7 it；叶子产物未变；四组冻结零差异 |
| T04 固定提交交付 | **通过** | §3：固定 SHA、真实预算、原始输出、第二干净依赖环境复验、现行说明与线性 push |

**T01–T04 离线修复通过。**

**Engine Lab Run I 实机：AUTHORIZATION_REQUIRED，NOT_RUN。**本轮未安装/启动游戏服务器、容器或数据库，未上传任何实验产物，未武装，未调用真实经济 API，未读取正式凭证/`.secret.json`/既有世界配置/玩家 Memory。离线通过不等于 S01–S06 实机通过；真实实验仍须按原 Run I 任务书（`evidence/terminal-transfer-engine-lab-run-i/task/task-brief.md`）取得用户明确授权后执行，届时使用包含本次修复的固定版本，未改的叶子产物继续复用，回填真实实验配置属新的源码变化须重新提交/构建/验证。

## 5. 保证边界（未扩大）

本轮证明的是 main 可识别的模块装配失败与向外抛错会阻断后续发送；observer 为 void 接口，其正常返回不独立证明样本完整、外部 console 已收到或未来 tick 持续可用——未修改 observer 接口、未在 main 扫描日志、未复制世界健康检查、未新增跨 tick 失败闩锁/持久字段/重试/rearm。真实实验仍须由外部 Run I 流程先取得只读基线、核对代码装载与日志通道，并在观察失败时停止。

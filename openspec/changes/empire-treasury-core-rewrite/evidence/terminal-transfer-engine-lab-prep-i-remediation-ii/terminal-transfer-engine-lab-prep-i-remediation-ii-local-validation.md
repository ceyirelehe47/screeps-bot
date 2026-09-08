# Terminal Transfer Engine Lab Prep I · Remediation II——本地验证报告

任务身份：**Terminal Transfer Engine Lab Prep I · Remediation II**（4 KiB JSON 字节预算、读写统一校验与产物级收尾；验收索引 R01–R04）。任务书全文归档于 `task/task-brief.md`（SHA-256 `82f0ad79a9dc1d3b97190505720cc53807797e56ec1a624a52b2c3c877cd8388`，25,080 字节）。

## 0. 提交链与验证身份

| 项 | 值 |
| --- | --- |
| 起点 HEAD（本地=远端，干净） | `87507f42b1302e6f0e5916d9dfb5c3cca9d94790` |
| 基线旧产物三重身份核对 | 24,496 字节 / Git blob `447970f3f3a165a25a71d3c481e47d416e030168` / SHA-256 `49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca`（与任务书 §3.1 一致） |
| 提交 1（实现+测试+文档+baseline+task） | `ae991e5e73a98ca8de69db0e07b06f71927156c5` |
| 提交 2（预算，主验证运行 HEAD） | `9bf6625503bc8f697fdc2ba1f30e8fb78c58678f`（VALIDATION_HEAD；budget target 锚点=ae991e5——与 Remediation I 的 b6ab29a 模式一致） |
| 生产冻结基线（四组 diff 零差异） | `869149dcdd6f2068572354917bf23c52727cf9b6` |
| 预算 target | 240 suites / 1465 tests / 1465 passed / failed、pending、todo、runtime error 均为 0 |

实施顺序遵守"先在旧版本复现，再最小改动"：B1/B2 基线脚本在起点工作树（未修改状态）实跑归档后才动 `controlRecord.ts`；`singleShot.ts` 零改动（发送顺序不变），`build`/`labConfig`/`worldRead`/`sample`/`observer`/`sendGate` 全部不动。

## 1. 验收结论（R01–R04）

| 索引 | 结论 | 依据 |
| --- | --- | --- |
| **R01** | 通过 | `baseline/reproduce-baseline.cjs`（本轮实跑，归档含日志）：B1 旧产物非 ASCII send 异常（`new Error("错".repeat(2048))`）下 send 三时点 1/1/1、send 入口内 attempted=true、结果槽终态 JSON **2200 字符 / 6296 UTF-8 字节**仍写入（write-refused 0 行、stopped 落槽）——字符口径 ≤4096 通过而字节 >4096；B2 受支持字段 5145 字节记录经旧源码读取入口（`git show 87507f4` → TS 转译 → VM）返回 ok（短对照 155 字节 ok、读取零写），旧产物 loop 对照只撞 already_stopped。probe.test.ts 两个产物 it 内含同场景旧产物/旧源码对照段；新行为不再接受对应超限结果/超限读取（见 R02/R03） |
| **R02** | 通过 | 完整 JSON UTF-8 字节计量（`measureUtf8Bytes` 导出，纯 JS、产物零 Node 编码依赖）在读取/写入/发送前读回一致（同一实现）；边界矩阵（ASCII 与非 ASCII 已结束记录）：4095/4096 正常读写（4096 精确合法对照——未实现为 ≥4096 全拒）、4097 拒写（size_limit、bytes=4097、旧槽引用不变）且预置读取 corrupt（零写、槽引用不变、不删除/裁剪/重置）；计量对照 16 组字符串（空/ASCII/中文/双字节/BMP 三字节/emoji 代理对/引号反斜杠换行转义/孤立高、低代理/代理结尾/混合）与独立 `Buffer.byteLength` 期望一致（expected 不由被测实现生成）；发送前读回超限（tamper 塞已知字段超长 error、ID/tick/attempted 匹配、无未知键）按 readback_corrupt 拒绝、零 send、零发送边界日志 |
| **R03** | 通过 | 实际构建 single-shot 产物（VM 全新沙箱只注入 exports/module/console/Game/Memory，静态断言产物源码无 Buffer/TextEncoder/process/require）：B1 场景新产物 send 恰 1 次（合法调用不追溯取消）、超限结果写回被拒（size_limit、bytes>4096、limitUnits utf8-bytes、characters<bytes 诊断分离）、槽仅保留匹配 attempted（92 字节 ≤4096）、sync-throw 如实外记非 ASCII 超长诊断、同 tick×2/同 tick 新 VM 重建/下一 tick 累计 send=1；B2 场景产物 loop 三次全 control_record_corrupt（控制读取阶段拒绝，非 already_stopped）、零 send、槽原文逐字节不变；observer 与既有 Q 流程不退化（17 个原 it 断言未改动全绿） |
| **R04** | 通过 | 现行说明单位准确（lab-prep-i.md 控制记录行与 §4.2 改为"完整 JSON 的 UTF-8 字节数 ≤4096"；历史报告不回改）；生产/配置/依赖/Defense/Slice 实现五组冻结 diff 零差异（slice 冻结对起点 87507f4）；固定新 SHA（§3）、真实 budget 240/1465、完整原始输出归档 final/；第二干净依赖环境复验见 §4；真实引擎保持 NOT_RUN |

## 2. 基线复现（B1/B2，起点工作树实跑）

结论表见 `baseline/README.md`；要点：

- **B1**：旧产物（字符口径）对 2200 字符/6296 字节的结果记录零拒绝直接写入——缺口证明；实测数字 2200/6296 为本轮自测（与任务书 §3.2 所述上轮观察值一致，未硬编码为验收条件）。
- **B2**：旧读取入口只做存在性与形状检查——5145 字节（纯 ASCII，独立 Buffer 计量先证 >4096）的受支持字段记录判 ok；修复后读取不健康且零写。B2 证明的是读取契约缺口，不是超长 stopped 记录能再次发送（旧产物 loop 对照 send=0、只撞 already_stopped）。

## 3. 主验证（§7.2 模板，18 步全 0）

OUT=`treasury-lab-r2-LfYNW6`（mkdtemp 随机名；18 个执行步骤全部 exit 0；逐命令 .command.txt/.log/.exit-code.txt 归档于 final/）：

| 步骤 | 结果 |
| --- | --- |
| production-freeze / config-freeze / defense-freeze（对 FREEZE_BASE 869149dc） + slice-implementation-freeze（对起点 87507f4） | 四组 `git diff --exit-code` 零差异 |
| typecheck ×2（tsconfig.json / tsconfig.build.json） | 通过 |
| build + 生产 bundle 前后 sha256 | 一致：`63e4be2958645c28258e16abefe7deee8e4ec64ace5534852ab5fbe2f3b31fcf` |
| lab-observer / lab-single-shot 构建 | 成功；single-shot 产物 **27,697 字节 / SHA-256 `7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391`**，manifest PREPARED_NOT_RUN、repoSourceCommit=9bf6625（observer 产物 SHA-256 `96721926…`） |
| jest-lab | 1 suite / **22 tests**（R02-BOUNDARY、R03-B1、R03-B2 留痕行见 jest-lab.log） |
| jest-key（LAB+SLICE+Remediation IV/V/VI） | 9 suites / 102 tests 全绿 |
| jest-treasury | 35 suites / 597 tests 全绿 |
| jest-defense | 11 suites / 118 tests 全绿 |
| jest-full | **240 suites / 1465 tests / 1465 passed**，failed/pending/todo/runtime error 全 0 |
| budget（verify-jest-budget.mjs） | JEST_TEST_BUDGET=PASSED（240/1465；baseline b6ab29a 历史锚点不回改） |
| verify-evidence（--fixture h18） | TREASURY_EVIDENCE_VERIFY=PASS（0 failures） |
| diff-check / status-before / status-after / head-after | 干净且 HEAD=VALIDATION_HEAD |

验证期间未向仓库写入任何文件（status-after 0 字节）；脚本与日志置于 OUT 之外（`run-mainval.sh`/`wrapper.log` 副本随 final/ 归档）；无中断重跑。

## 4. 第二树复验（独立干净依赖环境）

reviewer subagent 读取任务书全文后在同一 VALIDATION_HEAD 上建立 detached worktree（无 junction/symlink、未共享或复制主树 node_modules），独立 `npm ci --no-audit --no-fund`（896 包、21 秒、exit 0；Node v22.19.0 / npm 10.9.3）；lockfile 双树 sha256 一致（`490ee9c7…`）；typescript/jest 解析路径均落第二树；主仓库全程只读、前后 status 为空。复跑结果（独立 Jest cache）：LAB 1/22、KEY 9/102、Defense 11/118 全绿。

reviewer 自写 VM 字节核对脚本（45 项全 PASS）：场景甲（B1）——产物 send 恰 1、send 入口内 attempted=true、最终槽 93 字节、size_limit 拒写行自报 bytes=6296 与 VM 外独立 `Buffer.byteLength` 计算严格相等、同 tick/下一 tick/全新 VM 同目标 tick 重建累计 send 仍 1；场景乙（B2）——5145 字节独立证明、三次 loop 全 control_record_corrupt、send=0、槽零变化；场景丙——同形状记录实测恰 4096 字节→already_stopped（读取健康）、恰 4097→control_record_corrupt，measureUtf8Bytes 与 Buffer 在 7 组 Unicode 输入严格相等；沙箱内 Buffer/TextEncoder/process/require 均 undefined。产物（reviewer 自建）与主验证 hash 一致。budget manifest 只读核对通过（target.tests=1465、probe 22；target.commit=ae991e5 为有意锚点设计，reviewer 已核证非缺陷）。全部原始产物见 `revalidation/tree2-out/`；worktree 已移除。

## 5. 未证明边界

- 真实引擎 **NOT_RUN**：两个产物均未上传、未在任何游戏世界运行、未调用真实 terminal.send()；本轮全部"send"均为本地 stub/VM 假端口 spy。
- 控制记录的 Memory 读回仍不是 driver 持久化承诺（保留 lab-prep-i.md §3 限制表述）；4096 UTF-8 字节约束只定义实验控制记录的本地预算，不代表游戏引擎对整个 Memory 的内部计量。
- 沿留待办（低危，沿下轮）：真实引擎全部实验待单独授权；M06 部分量 fee 显式断言（沿前两轮）；P01 [60,100] 排列原生覆盖需扩展 mock 视图配置。

## 6. Git 与 CI

- 线性提交：87507f4 → ae991e5（实现+测试+文档+基线+任务书归档）→ 9bf6625（预算锚点=主验证 VALIDATION_HEAD）→ 证据归档提交（final/revalidation/主报告，见 `git log`）。
- push 后 `git ls-remote` 核验远端 HEAD 与本地一致；`git diff --check`、`git status --short`、`git log --oneline --decorate` 已保存；commit status／check-runs／Actions 查询无结果时如实标"无 CI 证据"。

## 7. 结论

R01–R04 全部通过：唯一大小语义（完整 JSON 的 UTF-8 字节数 ≤4096）在读取、写入、发送前读回一致落地，B1/B2 缺口按"基线复现→最小改动→产物级行为验收"闭环；生产内核与 Slice 0 未解冻，两个探针均不上传，真实引擎保持 NOT_RUN。本轮完成不自动授予实验运行或部署许可。

# Terminal Transfer Engine Lab Prep I · Remediation I——本地验证主报告

编制：2026-09-08（实施 Agent）。验收索引 **Q01–Q06**（任务书 `task/task-brief.md`，SHA-256 `213f06e5ab7c7b72245468c0b66b371aa935a5d6bb3a8f6a080d5b109e9425c7`）。
状态：**离线修复与验证完成；真实引擎 NOT_RUN**。

## 0. 提交链与验证 SHA

| 提交 | 内容 |
| --- | --- |
| `749d44c9` | 起点（本地=远端核对干净） |
| `b6ab29a6` | 实施：controlRecord 写结果化+读回核对+形状严格化、singleShot 标记确认后才发送、probe.test 11→17 it、labConfig/lab-prep-i.md/migration-map/构建器 banner（Q01–Q04） |
| `c8a6d532` | 预算锚点滚动（240/1460，基线 b6ab29a）＝ **VALIDATION_HEAD** |
| （交付 HEAD） | 本 evidence 归档+主报告（见 §6） |

旧产物基线身份核对（Q01 前置）：17,520 字节；Git blob `6ce38daaaabff1febab3e710ac948f4e7cdaa7db`；SHA-256 `9d8bfc54d542b9b5e8e37113b87e0f06e29149b7fa3cac1b9a7b8dfc7794ed4f`——三重一致（基线复现脚本内前置断言 + 独立 shell 复核）。

## 1. Q01–Q06 完成情况

| 索引 | 结论 | 依据 |
| --- | --- | --- |
| **Q01** | **完成** | 独立 Node VM 假端口脚本在固定旧产物上复现七场景（`baseline/baseline-run.log` 原始输出）：S5 setter 抛错 / S6 静默丢写 / S7 4090 超限均 **1/2/2**（同 tick 双发），对照 S1=0/0/0、S2/S3/S4=1/1/1；S6 零拒写留痕（无痕缺陷特征）、S5/S7 各 4 条 `lab-control-write-refused` 但 send 仍发生。新产物同矩阵（`final/jest-lab.log` Q01-FIXED 行 + 冒烟 `baseline/smoke-fixed.cjs`）：三失败场景全 **0/0/0**。产物 hash 见 §3 |
| **Q02** | **完成** | 发送前显式确认：`writeControlRecord` 返回明确结果（serialize_failed/size_limit/assign_failed）+ `confirmAttemptedMark` **重新从控制槽读回**核对实验 ID/attemptedTick/attempted===true/armed/未 stopped。probe.test it：send spy 入口内读 Memory 可见匹配 attempted（syncResult/stopped 尚未写）；读回 getter 异常（readback_corrupt，首次控制读取成功）/篡改实验 ID（readback_experiment_mismatch）/篡改 tick（readback_tick_mismatch）均零发送零发送边界日志；静默丢写由读回发现（readback_not_attempted）；单元断言写入函数对超限（size_limit）/循环引用（serialize_failed）候选明确拒绝且不触碰槽。正常路径仍恰一次调用（it8 回归） |
| **Q03** | **完成** | 预标记成功后结果更新失败：变体 a（结果写 setter 故障）send 恰 1、attempted 保留、stopped 未谎报保存、同 tick/下一 tick/保留标记的 JSON 重载+模块重建零增发、`lab-result-write-refused` 留痕同步结果；变体 b（send 抛 4500 字符诊断→结果写 size_limit 拒写）attempted 保留、控制记录 ≤4KiB、原始返回未被改为成功（sync-throw 如实 ok=false）。控制记录保持有界（4KiB=JSON 字符数口径，注释明确） |
| **Q04** | **完成** | labConfig.ts 头注释 + lab-prep-i.md 新增 §4.1：编译时唯一配置来源（LAB_EXAMPLE_EXPERIMENT）、example.experiment.json 文档示例身份（运行时不读取）、Memory 控制记录不覆盖编译配置、改配置=源码变化（重新提交/重建/核对新 hash）四点明确。本轮未新增 --config/热加载/运行时配置 store/上传器；example.experiment.json 与常量继续由 probe.test it1 断言同步（未改动，合成值保持） |
| **Q05** | **完成** | actual 产物回归：probe.test 既有 11 it 原断言不动全绿 + 新增 6 it；P01/P02 结论保留（KEY 复跑 97/97 含 P01 排列用例）；M/N/O（SLICE 20 用例在 KEY 内）与 Treasury 35/597、Defense 11/118、full 240/1460 不退化；四组冻结 diff 零差异（生产/配置/Defense/Slice 实现） |
| **Q06** | **完成** | VALIDATION_HEAD c8a6d53 真实预算（全仓收集 240/1460）；主验证 18 步 exit 0 完整原始输出（`final/`）；第二干净依赖环境独立复验（`revalidation/`，reviewer subagent）；执行代码（b6ab29a）先提交后验证；commit/push 线性与 NOT_RUN 边界见 §6/§7 |

## 2. P01/P02 回归保持

- P01：`treasuryTerminalTransferSlice0RemediationII.test.ts` P01 describe 3 it 在 KEY/DEFENSE/full 三组复跑中原样通过（7/7 文件级总数不变）。
- P02：本轮第二树独立 `npm ci`（896 包、15.037s、exit 0；无 junction/symlink/共享/复制安装，四项独立性核验 PASS，独立 Jest cache/output）；上一轮 P02 结论不被重写。

## 3. 主验证（§8.2，final/）

18 步全部 exit 0：四组冻结（production/config/defense/slice-implementation）零差异、typecheck×2、build、三次探针构建（含 foreign cwd 含空格路径）、jest-lab 1/17、jest-key 9/97、treasury 35/597、defense 11/118、full 240/1460、budget PASSED、verify-evidence PASS（4 trace 根 H18 checkpoints=54/problems=0）、diff-check 0、前后状态 0 字节、head-after=validation-head。
生产 bundle 前后一致 `6287d898…`（探针不进 dist/main.js）。
新 single-shot 产物：24,496 字节、SHA-256 `49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca`、manifest PREPARED_NOT_RUN、repoSourceCommit=c8a6d53。
Q01 留痕：`final/p01-focus-lines.txt`（BASELINE 行 S5/S6/S7=1/2/2；FIXED 行同场景=0/0/0）。
异常如实记录：第一次完整运行因执行者将 evidence 归档提前入库污染末尾状态检查而重跑（16 个执行步骤当时已全 0，详见 `final/README.md` 异常①）。

## 4. 第二树复验（§8.3，revalidation/）

reviewer subagent 独立执行：读取任务书全文 → detached worktree 检出 c8a6d53 → `npm ci --no-audit --no-fund`（896 包/14s/exit 0）→ 四项独立性核验（实体安装非链接/解析路径落第二树/主树无污染/lockfile 双树 sha256 `490ee9c7…` 一致）→ 独立 cache/output 复跑 KEY 9/97、Treasury 35/597、Defense 11/118、full 240/1460、budget PASSED、verify-evidence PASS → Q01 两行独立解析核对 ALL_MATCH → **自写 VM 脚本独立复验**（不依赖仓库断言）：场景甲（发送前标记失败）send 累计 **0**、场景乙（预标记成功后结果写失败）send 累计恰 **1** 且 attempted=true/stopped 未写/零重试，8/8 断言通过 → 产物 manifest 核对一致 → worktree 清理确认。REVIEWER-LOG.md 全程留痕。

## 5. 未证明边界（如实）

- **真实引擎 NOT_RUN**：两个产物未上传、未在任何游戏世界运行、未调用真实 terminal.send()；本轮无服务器/容器/数据库启动、无 CPU 超限或 driver 故障注入。
- 控制写入与读回的证据**不是 driver 持久化证明**：仅是当前脚本内的确认（§4.4 边界保持）；实际已进入发送而控制事实遭外部丢失/回滚仍属未证明的 driver/环境边界。
- S7（超限 note 记录）在新实现下于**读取阶段**被形状严格化拒绝（control_record_corrupt），未走到写入超限分支——按任务书 §3 如实标为读取拒绝；写入函数对超限候选的拒绝由单元断言独立证明（size_limit + 槽未被触碰）。
- P01 宿主记录原生在前形态、M06 部分量 fee 断言等沿留待办不变（见 tasks.md）。

## 6. Git 与提交纪律

- 线性提交：749d44c → b6ab29a → c8a6d53 → 本归档提交；无 reset/rebase/force push/amend 已推送提交/合并 main。
- 归档提交后 push 并核对远端 HEAD；`git diff --check` 干净；CI 证据见交付报告（仓库无 .github 目录，check-runs/statuses 如为 0 则如实标"无 CI 证据"）。

## 7. 验收结论

**Q01–Q06 全部完成**：发送前标记确认缺陷已在真实构建产物上修复并经旧产物基线对照、失败路径矩阵与第二树独立复验确认；编译配置交接已明确；生产/配置/依赖/Slice 实现/observer 只读语义零改动；预算真实滚动至 240/1460。按任务书 §8.3「本轮完成即停止」：不启动服务器、不上传 observer 或 single-shot、不发起真实调拨、不自动进入下一阶段。

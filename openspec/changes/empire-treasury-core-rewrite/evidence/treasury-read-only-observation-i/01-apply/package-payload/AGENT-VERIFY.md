# Treasury Read-only Observation I — 原样应用与独立验收

日期：2026-09-10。交付内容为已实现补丁，不要求根据任务书重新开发。

## 1. 基线、已有通过与本轮目标

仓库 `ceyirelehe47/screeps-bot`，工作分支 `refactor/empire-treasury-rearchitecture`。

- 预期起点：`77d67d6a02cfb55029515e00503b598a78870ae5`。
- 最近实机运行基线：`cf29a69477a7c2ddd863efb800e9e8735e9b3cce`；`lab-ti1-0002` 的首条国库100H业务已取得限定 TREASURY_INTEGRATION_PASS（T536调用、T537注册结算、T538退出）。不要再重复该正常路径实验。
- 上轮全量继承：`838dcc79b33e6e1b76c698afa7cf88be47859091`，246 suites / 1515 tests。当前阶段有生产main新增挂载，不能把旧全量结果直接当新版本全量验证。
- 本轮目标：在正常bot旁边提供默认关闭、低频、有界的只读观察，而不是上线调拨。新增功能不授权、不接纳、不执行、不结算、不迁移/清空Memory，也不替换生产main为实验main。

附带旧检查点中的 bd9570d、原始API配置校准和“Agent负责实现”已过时。本包沿用“ChatGPT实现→Agent独立验收”的分工。

本任务仅包括仓库读取、补丁应用、本地依赖/编译/测试/构建、证据归档及向上述分支线性提交代码。**没有线上部署、正式账号连接、PTR、既有私服、新standalone世界或任何资源发送授权。** 不运行 npm run push、npm run local、DEST上传路径或历史实验run命令。

## 2. 开工与应用

先核对远端实际HEAD，不自动reset/rebase/amend/force。HEAD不同先列出增量：仅文档变化可记录后在显式新工作树审查适配；涉及代码/测试/构建不直接套旧包。应用脚本严格要求原SHA，不通过伪造Git状态绕过。

包解压在仓库外，保持工作树干净。从仓库根使用：

```sh
git status --short
git rev-parse HEAD
python /absolute/package/apply_patch.py --repo /absolute/repo --check-only
python /absolute/package/apply_patch.py --repo /absolute/repo
git diff --check
git diff --stat
```

脚本不安装、不访问游戏、不提交、不push。它核对基线/原文件Git字节/补丁hash/输出Git字节；跨平台工作树换行规范化通过git hash-object --path处理，构建产物仍按实际字节单独记录。

## 3. 修改白名单

原样补丁共8个文件：

- 修改 `src/main.ts`：仅新增import与位于旧shadow后、endTick前的诊断phase。
- 修改 `src/main.test.ts`：完整phase表41→42；原6个用例仍完整，原41个业务阶段相对顺序不变。
- 新增 `src/config/treasuryReadOnly.ts`：默认false、空shard/rooms，不能解释为全帝国。
- 新增 `src/runtime/treasuryReadOnlyRuntime.ts`：薄装配，不在treasury内部反向import runtimeServices。
- 新增 `src/runtime/treasury/readOnlyObservation.ts`：纯读取与有界heap诊断。
- 新增 `test/treasury-read-only/local.spec.cjs`：局部独立Node与真实main装配测试。
- 新增 `test/treasuryReadOnlyObservation.test.ts`：Node wrapper + 6个实际facade读取测试。
- 新增 `docs/treasury-read-only-observation.md`。

可额外修改测试预算与本轮证据/状态文档；可独立增补针对本功能的测试。不得改核心facade/kernel/observation/commitments/policy、共享Memory声明、runtimeServices、旧shadow、任何经济writer、Defense、root构建/依赖、旧LAB工具或实验开关。不得为了架构测试通过而放宽扫描/保护规则。

需要功能修复时：先原样失败证据、最小输入与失败分支，再单独提交；涉及白名单以外的写路径/原有保护逻辑则交回实现方，不自由重构。没有失败不扩建新机制。

## 4. 原样首轮（必须保留）

使用仓库锁定依赖，记录 Node/npm/TypeScript 实际版本。npm ci允许复用下载缓存但不共享node_modules。所有命令保存参数、退出码、stdout/stderr；Jest附原始JSON。不把内部54个Node用例加到Jest总数。

```sh
npm ci
node --test test/treasury-read-only/local.spec.cjs
npx tsc --noEmit -p tsconfig.build.json
npx tsc --noEmit -p tsconfig.json
npx jest --config jest.config.cjs --runInBand --runTestsByPath src/main.test.ts test/treasuryReadOnlyObservation.test.ts --json --outputFile /absolute/new-evidence/first-jest.json
```

本交付端已运行：54个Node用例、选定类型声明下新3模块的局部TypeScript5.8.3检查。**未执行**实际facade Jest、仓库锁定TS5.9.3完整检查、生产bundle、全仓Jest、真实环境/线上。包内 local declarations 只用于复核交付端有限检查，绝不复制进仓库或替代实际游戏类型。

## 5. 独立反例与合法对照

不限于跑作者用例。至少独立确认以下边界，每个拒绝/降级都配合法对照，不靠另一处故障提前拦截：

1. 默认关闭、非采样tick、重复调用、错shard、非法/空范围、低CPU：服务与Store不被调用。开启测试只用测试注入的合法profile，不实际启用线上开关。
2. 同样的高物理库存，任务/预留不完整或kernel损坏时，查询阻断原因仍存在；不健康kernel不能报“active=0”。Memory缺失不得初始化；unknown不得清除、settle、cancel或重置世界序。
3. 原始Store的0、缺建筑、缺视野、不属于我、getter异常、null/NaN、ID替换与正常端点分别表达。指定资源之外的库存可存在，不能误报“只持有H/energy”，不自动扩大扫描范围。
4. 独立world读数和Treasury缓存故意不同，能报mismatch；完整合法世界能match。query固定扣除占用、无owner豁免、withhold0且不是具体动作policy授权。
5. 市场日志的intent/ok/blocked不被当作成功转运；过旧、缺失、损坏、>100条及>8条输出均有明确覆盖信息。通过监视原Memory证明没有调用会删除claim的getter。净库存变化不等于实际手续费，也不能定位搬运者。
6. 输出超界仍为有效JSON省略通知；UTF8按Buffer oracle验证。CPU边界为协作式，慢getter/日志的超额应可见，不能伪称硬2CPU上限；异常后原main仍endTick/flush，原业务异常仍fail-fast。
7. 长期运行与heap reset：最多保留上一次快照，无Game/Store活引用，无新持久根，无历史队列膨胀。Memory Proxy必须记录“尝试写入”，不能仅比较最终JSON碰巧相同。

现有主循环的生命周期、旧shadow和profiler本来可能写Memory/执行原业务；隔离新增功能的差分，不要求整个bot都冻结。也不能以旧行为为理由放过新增模块的意外写入。

## 6. 完整验收与预算

本次修改生产main挂载，应在实现/增补测试收敛后执行一次完整回归，不在每个小步骤反复跑压力组。先留存首轮再增加测试；真实收集后更新 `test/test-suite-budget.json`，预算独立commit，不删除/skip旧测试平衡数字。

预计若无额外测试：247 suites / 1522 tests（新增1套7个Jest：1 wrapper +6真实facade；原main仍6）。这是预测，不是执行结果。54为wrapper内部Node用例，不另加到1522。

```sh
# 先确保未设置DEST；这只是构建，绝不能上传。
npm run build
npx jest --config jest.config.cjs --runInBand --json --outputFile /absolute/new-evidence/jest-full.json
node scripts/verify-jest-budget.mjs
git diff --check
```

必要时按实际仓库构建说明使用禁用上传的环境方式。完整构建包含正常main，默认config仍false，LAB入口不混入生产图，没有新Memory类型或全局命令。对原main其他代码、Defense及核心目录的diff应为零；仅本功能新文件与main插入除外。

第二干净工作树使用实际固定验证SHA，独立npm ci；只需两套定向Jest、两套类型检查及默认生产构建，不机械重跑全仓压力/预算。生产buildTime可能改变产物hash，记录来源与配置，不为比较强改buildTime或宣称字节不等就是错误。

## 7. 报告与提交

建议证据根 `openspec/changes/empire-treasury-core-rewrite/evidence/treasury-read-only-observation-i/`。至少保留：包与manifest、原样首轮、独立失败输入和测试、实际命令/退出码/JSON、完整回归/预算、第二树、源码差异与默认关闭证明。无需制造与本轮无关的新证据平台。

线性提交：实现/作者测试；独立新增测试或单独修复（如有）；预算；最终验证与证据。验证HEAD绑定代码/测试/配置；证据HEAD可后移，报告给出二者及差异。禁止amend已push提交、force、merge main。

可顺手纠正上一轮主报告的两处说明（仅文档，不改原件）：收尾默认enabled实际为false；独立CLI校准原件repoHead为4fb23e6，正式run中的C02重新预检才属于正式窗口。保留历史成功与失败身份，不重跑发送作为“修文档”。

最终回答必须分别说明：新增观察器离线验收是否通过；实际facade下是否发现写入或隐藏查询副作用；完整main是否保持原行为顺序；默认是否关闭；真实CPU/正式数据是否仍未验证。不要仅报PASS或将mock CPU当线上CPU证据。

本轮通过后状态是 `READ_ONLY_CODE_VERIFIED / NOT_DEPLOYED`。下一项才是单独核对实际线上代码/Memory/房间、限定profile与部署差异后的只读采样安排；这份任务不自动启动那一步。若发现当前线上版本与本分支相差整个国库重构，必须说明，不能称“只是上传只读功能所以没有其他行为变化”。

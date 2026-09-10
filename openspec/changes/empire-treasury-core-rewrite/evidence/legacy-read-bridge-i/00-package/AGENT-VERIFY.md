# Agent 任务 — Treasury Legacy Read Bridge I
## 生成并独立验收最小旧生产兼容候选；不整体上线主开发分支

日期：2026-09-10。交付物是已实现的装配工具与只读桥。请原样生成、测试，发现问题保留复现，不重新根据文字设计一套国库。

## 1. 本轮目标与已知事实

仓库 `ceyirelehe47/screeps-bot`，当前开发分支 `refactor/empire-treasury-rearchitecture`，本次确认的 HEAD 为 **01bd9831454950c4928df98dd8679692b55603e5**。

已识别的线上源为 **06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c**，账号 `forster`、官方服、活动分支 `default`；上轮 overview 在shard1列出8个房间。这些是先前采集的基线，不是本任务执行时已经重读的线上事实。

当前开发分支的国库单笔本地闭环和完整只读观察器离线验收已通过。其 **248 suites/1539 tests** 属于当前开发树，不属于旧基线候选。旧基线自己的预算文件记录193/683及不同锚点；也必须以本轮实际收集核对，不能把其中任一数字直接当作候选新结果。

任务目标：保持旧生产业务不变，生成一份**默认关闭**的兼容诊断候选，检验新国库的两份原有读取算法是否正确读取旧 Store、旧任务、旧预留以及动态容量。此桥不启动 TreasuryService，不承担账本、授权、派发或结算职责。

**有效交付**：候选 Git 分支、实际生成物及来源清单、原样首轮结果、独立反例、完整候选验证与差异清单。最终使用 `COMPAT_READ_CANDIDATE_VERIFIED / NOT_DEPLOYED` 或具体失败，不写“线上国库已完成迁移”。

## 2. 凭据与明确授权

用户已更换 token，允许本轮 Agent 自行走官方临时免限流流程，不需要再就这一项请求授权。最新提交记录旧凭据 `/api/auth/me` 返回401、新凭据200；继承这一已记录收口，不去Git历史提取旧值重复测试。

新 token 只从本地现有 `.env` / `.secret.json` 或既有安全凭据入口读入。禁止放入命令行参数、进程列表原文、stdout/stderr、截图、报告、fixture和Git；也不要输出前缀或含实际token的URL。

确需补充读取时，先通过官方 `/api/auth/query-token` 核对当前 token 的状态。请求中含凭据的 URL 只能在本地内存构造，不记录请求URL/原响应全文；只保存已审阅的HTTP状态与免限流剩余时间/截止信息。旧token的两小时窗口不自动继承给新token。

若受限，Agent可在已登录官方页面完成“Proceed”流程，随后核对状态并用一次必要读取确认恢复。官方若出现必须真人完成的挑战，不绕过；仅移交那个步骤，离线任务照常推进。不得把 `/api/auth/tokens` 的404写成不存在查询接口，不把一次200当成永久免限流。

本轮仅做现有授权范围内必要只读查询。优先复用已取得的受控原件，不为了凑材料重复读取整份Memory。不得修改限流之外的账号设置、游戏Memory、房间、市场、活动代码分支；没有Screeps上传/资源发送授权。GitHub候选分支push与Screeps上传是不同动作，本任务只要求前者。

既有监控可能仍持有旧token；如需处理，按执行会话已有授权精确识别该采集器，不全局杀Node，不以“刷新凭据”之名修改线上代码。未获范围授权的旧监控保持不动，不阻断本地候选生成。

## 3. 必须保持的实现边界

生成器仅允许8个读取来源文件，见 `kit/source-plan.json`。它把固定原 TS 转成一个静态模块闭包，只公开 `buildObservation`、`buildCommitments` 两个入口。没有eval/动态网络import；出现其他运行时依赖直接拒绝，不能扩大白名单至facade/kernel/Defense来让构建通过。

旧 `src/main.ts` 只增加import及末尾诊断phase，38→39，其他阶段相对顺序、原业务异常传播和flush保持。旧 `runtimeServices`、`resourceControl`、`resourceReservation`、物流执行者、Defense、Memory清理、Memory类型和构建管线不改。

新桥不迁移旧表，不调用begin/end、world sequence bump、authorize、dispatch或settle。不手写“库存−预留”形成另一份可用量。报告的spendable固定null，authorizesActions固定false；旧表的聚合来自实际原canonical索引。已有treasuryCore只标注存在且未解释，不能伪造active=0。

此路径与之前完整facade观察器不同，刻意不宣称已运行facade.query。两份读取函数来自同一已审查国库实现；完整观察器及内核仍原样保留在开发树，不在此轮重写。

每次采样新建读取模块缓存和索引，避免旧writer没有调用新revision失效通知而造成跨采样陈旧结果。只保留上一份已输出的primitive端点快照。缺失、null、数组、超过256条与真正空表区分，不裁剪出“看似完整”的前缀。

## 4. 工作树与原样装配

先检查包的 `INTEGRITY.json`。不要在开发工作树直接应用旧基线main修改，也不要将开发分支reset回06ffedb。

以下为命令模板。将路径一次绑定为实际绝对路径，保留真实命令及退出码；证据先写在候选仓库外，防止默认构建dirty。

```sh
DEV=/ABS/screeps-bot
CANDIDATE=/ABS/screeps-bot-compat-read-i
PACK=/ABS/treasury-legacy-read-bridge-I
EVIDENCE=/ABS/compat-read-i-evidence

git -C "$DEV" status --short
git -C "$DEV" fetch origin
git -C "$DEV" rev-parse HEAD
git -C "$DEV" cat-file -e 01bd9831454950c4928df98dd8679692b55603e5^{commit}
git -C "$DEV" cat-file -e 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c^{commit}

git -C "$DEV" worktree add -b compat/treasury-read-bridge-i "$CANDIDATE" 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
(cd "$CANDIDATE" && npm ci)
# 来源工作树须有自己的锁定依赖；已具备时不重复安装；不得共享/链接node_modules。
node "$PACK/kit/assemble.cjs" --source-repo "$DEV" --target-repo "$CANDIDATE" --check
node "$PACK/kit/assemble.cjs" --source-repo "$DEV" --target-repo "$CANDIDATE" --apply
git -C "$CANDIDATE" diff --check
git -C "$CANDIDATE" status --short
```

来源和目标均要求实际TypeScript 5.9.3。生成器读取固定Git对象，而不是当前工作树中可能修改过的同名源码。开发分支前移且只改证据时仍保留固定sourceCommit；若读取算法变更需要切换来源，先报告，不擅自更新锁。

若候选分支名/路径已存在，核查是不是本轮已建立；不得覆盖未知工作树、清空用户文件或重新利用有未提交修改的目录。创建全新明确命名候选，不改已推送历史。

正常装配应产生13个候选文件。生成的 `.generated.ts` 不得手改；它含原算法中的内部未使用函数不等于这些函数公开可达。审查公共入口和实际调用，而不是仅用全文件文本命中判断“发生写入”。

## 5. 原样首轮验证

```sh
cd "$CANDIDATE"
unset DEST DEPLOY_ALLOW_DIRTY
npx tsc --noEmit -p tsconfig.build.json
npx tsc --noEmit -p tsconfig.json
node --test test/treasury-compat/bridge.spec.cjs test/treasury-compat/real-readers.spec.cjs
npx jest --config jest.config.cjs --runInBand --runTestsByPath src/main.test.ts test/treasuryCompatRead.test.ts --json --outputFile /ABS/compat-read-i-evidence/first-jest.json
```

保存每组stdout/stderr、退出码、实际SHA、锁文件身份。`real-readers.spec.cjs` 必须实际存在生成物并调用真实原算法，缺失将直接失败，不能skip、删除该文件或只运行模拟读端口测试。

原样失败先保存原始失败输入/命令/栈，再分类：原实现、装配工具、测试或环境问题。不要修改原读算法、改观测值或去掉断言再报PASS。必要修复与原失败独立提交并明确交回设计/实现方；独立测试自身错误可纠正，但保留迭代记录，不把它当成算法问题。

## 6. Agent必须独立增加的对照

在候选 `test/treasury-compat/` 另写独立用例，并确保Jest wrapper或正式命令实际包含新文件。至少覆盖以下组合，不能只复制交付方用例：

1. **非空旧状态、变更与到期**：同一对象内remainingAmount/amount在两个采样间变化，旧writer不bump新revision，下一次应读取新值；未确认owner继续计入保留，expiresAt到期只影响派生索引而不删原记录。再以合法空表和非空合法表作为正对照。
2. **缺失与损坏**：缺path、null/数组、损坏单条、计数超限分别不冒充空表；限定资源外损坏记录的completeness忠实跟随原索引。Memory Proxy拦截set/delete/define及descriptor绕过，前后原值不变。不得改旧记录去迎合新接口。
3. **容量与身份**：正常1M、8M、缩容后used大于capacity、合法容量变化、结构ID替换和一端不可读。读取实际getCapacity，不能假设hub只会1M↔8M两个等级；只有身份/容量可比才输出净变化。迁移窗口不以静态容量表制造Game真值。
4. **真实来源与主循环**：让稀疏Store枚举与独立getUsedCapacity返回故意不一致，必须有mismatch；让旧runtime投影过时，不能算match。默认关闭时零新增数据读取；模拟新桥读取/输出失败时原业务与flush继续；原业务异常仍保留原fail-fast。
5. **窗口与泄露边界**：绝对窗口结束后、同tick重复、错shard、低bucket均不读取新增来源；heap重建不重开已结束窗口。输出/日志异常不能把隐形快照作为之后基线，日志没有原始任务/市场payload和凭据。

可从上一轮受控实时原件中提取最小输入：任务/预留在特定采样时为空，以及E4N58容量投影800万；这些只是带时间来源的样例，不替代非空测试，不称真实Game对象测试。完整Memory原件不得入库，扫描所有最终证据，不只扫描新源码。

## 7. 完整候选验证、预算、构建

原样和独立测试通过后，在候选分支提交代码与测试，固定 `CANDIDATE_VALIDATION_HEAD`。在该SHA执行一次完整候选回归与正式构建：

```sh
unset DEST DEPLOY_ALLOW_DIRTY
npx jest --config jest.config.cjs --runInBand --json --outputFile /ABS/compat-read-i-evidence/candidate-full.json
npm run build
```

候选新增Jest wrapper是1项；内部Node的41项bridge+10项real-readers不是新增51项Jest。独立增加多少Jest文件/用例按实际收集计算。旧main六项测试保持，不通过减少旧测试来守预算。

只允许根据真实收集结果更新**候选分支**原有 `test/test-suite-budget.json` 和 `scripts/verify-jest-budget.mjs` 的锚点、逐文件预算及目标数字，不改核验算法，不把主开发分支248/1539复制过来。按现有脚本真实行为跑预算验证；若它内部重跑全量，如实记录该执行，不再机械加第三遍。开发分支的原预算不因一个旧基线候选而回退。

正式构建仍使用旧常规 `src/main.ts` 与既有Rollup，不用任何lab main。检查上传模块集合的真实字节体积和原部署守卫适用性；不得因为build exit=0就推断满足上传限制。此轮只build，不执行 `npm run push` 或 `npm run local`。

另一干净工作树对最终候选SHA独立npm ci；仅复跑两套tsc、主循环/桥定向测试和构建。比对源与生成物；构建时间/元数据差异单独解释，不强改时间以凑hash，不称第二树是另一执行者的独立审查。

## 8. 冻结差异验收

相对旧生产基线06ffedb：生产文件只允许改 `src/main.ts`，并新增 `src/runtime/treasuryCompat*.ts`。另外允许原顺序测试、专属测试、候选文档/来源manifest，以及根据真实收集调整的两个预算文件。

以下必须字节不变：旧resourceControl/resourceReservation/runtimeServices/logistics执行层、Defense、原MemoryCleanup、旧 `src/types/memory/runtime.d.ts`、package*.json、rollup.config.js、tsconfig*、原deployGuard。新增依赖闭包不得包含这些执行层；生成器白名单为固定8个读取来源。

报告实际旧38阶段→39阶段。不能照抄当前开发树的41→42，也不能说把完整国库生命周期上线了。只读桥不创建/迁移reservation version；观察到旧版本非空时继续只读，兼容性不足明示，而不是在本轮补一个自动迁移器。

## 9. 提交、证据与结束

候选分支线性commit/push到GitHub，**不得合并进main或直接覆盖开发分支**。生成器及任务包可在开发分支 `openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/` 作为经审阅的任务来源归档，并用单独证据提交链接候选SHA；生产候选运行源仍从旧基线派生。

证据至少包含：输入包hash；两个固定Git引用；13文件生成清单与完整原算法来源manifest；原样结果；独立反例与合法对照；全量Jest原件；预算；常规构建摘要；差异白名单；第二树；未执行边界。不得复制原进程命令行或带token链接到任何证据，不以压缩/base64形式绕过脱敏。

最终分别回答：

- 实际候选SHA和基线是什么？旧业务究竟改了哪些字节？
- 是否生成了真实固定源的8文件闭包，而非mock/裁剪算法？
- 非空、缺失、损坏和容量变化是否有真实原函数下的正反对照？
- 是否发现Memory尝试写入、索引跨采样陈旧或旧业务行为变化？
- 默认关闭、生成物来源、原主循环、构建体积与旧基线预算是否成立？
- 是否上传Screeps、是否有线上新桥样本？本任务默认答案应为未部署、未采样。

此轮成功只收口到 `COMPAT_READ_CANDIDATE_VERIFIED / NOT_DEPLOYED`。之后的限定线上观察可使用该小候选，不再要求先上线全部432个提交；其实际发布仍需核对当前活动模块、明确覆盖/关闭授权与实时profile。此包不提前填写结构ID、起止tick或制造部署许可。

## 10. 来源与解释边界

源事实：先前仓库/线上采集识别06ffedb基础；当前来源01bd983；真实Memory提取在各自tick上显示旧任务/预留为空和容量投影800万。方案选择：本轮只读兼容桥、独立候选分支、8源闭包与绝对诊断窗口。这些是本轮实现决定，不是声称上轮已经线上验证过。

原接替检查点的bd9570d状态属于早期裸Terminal API实验，不能让它覆盖已经通过的本地国库闭环与本轮最小接入目标。不要重做同一个100H实验，不扩展国库、市场或Defense。

# T1-EXIT-R1 证据索引

本目录是 2026-10-02 新一轮实现证据。生产只读；所有人为任务、Store故障、cargo和重启均发生在独立的 dsh 回环引擎，用户ID为 `7dad41a4bfc9d96`，不是正式账号ID。原 JSON 仅追加，不改写。

## 原件与验收引用

| 组 | 起点 | 关键观测 | 终点 |
| --- | --- | --- | --- |
| A 无责任到期 | `engine/evidence/a-armed-no-responsibility-snapshot.json` | 真实 wall clock 租约过期；只重新启用普通调度，不close、不手写mode | `a-expired-ordinary-restored-snapshot.json`：普通原任务100H，T1零native，closed/OFF，无quota/core/lease |
| B 未知责任 | `b4-before-native-snapshot.json`、`b4-real-native-snapshot.json` | `b4-inject-contradiction-fault.json`真实目标H+1；`b4-unknown-off-request-held`、`b4-unknown-after-real-restart`保留双端；`b4-unrelated-native-while-unknown`无关真实发送；`b4-carrier-held`合成50Energy持货未交付 | `b4-restore-true-store-restore.json`减回装夹1H；`b4-confirmed-ordinary-and-carrier-restored-snapshot.json`原attempt committed、done/0、drained、OFF、普通两端恢复、同carrier清空持货 |
| C 并发成功链 | `c2-setup-setup.json` | `c2-endpoint-conflicts-snapshot.json`普通入库720/725先行，T1仍pending、无quota/core；`c2-real-native-snapshot.json`730唯一100H | `c2-confirmed-snapshot.json`原attempt结算；`c2-off-after-real-restart-snapshot.json`真实进程重启后零新增交易、无lease、OFF |

JSON 中 `tick` 是环境next tick读回，交易time、CPU last tick和kernel invocation tick是实际执行tick；暂停握手可能跨一个tick，不按文件名或tick字段单独判断顺序。每份snapshot保存完整lab Memory、所有相关Store/结构与完整用户交易。T1 description含attempt，普通description含task，验证器逐交易分类。

`b-*`、`b2-*`、`b3-*`、`c-*`属于校准记录，保留但不计入B/C通过。B1因真实暂停超过60秒转为普通发送；B2/B3在完整规划tick arm，console执行晚于main，已发生普通动作而拒绝arm；B3旧CLI驱动timeout。首次B/B2故障脚本使用嵌套dotted Store更新，未真正改变H，不能作为矛盾证明。最终`lab.cjs`更新整个Store并强制读回，B4才有1100→1101→1100原件。C初次暂停采样太久失联，成为普通交回；C2用轮询暂停器捕获真实冲突与native。含`real-native`的校准文件名不是事实认证。

B carrier原件明确标为 `synthetic-already-carried-50-energy`：插入既有carrier的持货与已分配交付计划，验证真实role在fence中保持、解除后执行。没有声称本轮观测到此前真实pickup。目标Energy之后增加500含正常后续补给，不能把全部500归给50 cargo。

## 重跑证据校验

在仓库根执行（候选目录须含冻结main.js和manifest.json）：

```bash
python3 docs/reports/treasury-T1-exit-r1-evidence-20261002/tools/verify-evidence.py \
  --candidate /绝对路径/候选目录 \
  --output /tmp/t1-exit-r1-new-verification.json
SCREEPS_T1_EXIT_CANDIDATE_DIR=/绝对路径/候选目录 node --test \
  docs/reports/treasury-T1-exit-r1-evidence-20261002/tools/deploy-guard.test.mjs
```

验证器从原snapshot、Store、交易、control/镜像、quota/kernel/task和完整生产任务重新推导，不读取 `verification.json` 的passed。输出另存；不覆写原件。`release/manifest.json`是最终发布输入；`engine/candidate/manifest.json`是最初传到lab的原始manifest，之后仅更新未打包部署工具摘要，main/源码/内嵌身份均未改变。

## 引擎复跑说明

环境为官方engine4.3.0、Node22.22.1，`/srv/screeps-treasury-t1/server`。端口web21025/CLI21026/storage21027仅回环；UTS命名shard1，系统实际hostname仍dsh。使用独立账号7dad、独立数据库备份与最终main读回。`engine/tools/lab.cjs`校验暂停、账号及main SHA，装夹操作都有wx原件；`until-native.cjs`/`until-conflict.cjs`只推进此lab，25秒超时并finally暂停。旧`run-until-native.py`留作失败驱动原件，不用它验收。

复跑必须在这套已有许可lab或其独立副本，先备份DB、分配新证据目录/唯一label，将工具的固定run路径指向新目录，并沿A→B→C执行。不得覆盖本轮原件，也不得把工具指向正式服。setup只准active为空且quota absent/drained；每个隔离案例是新合成任务实例，run/control ID不变。具体任务、arm/OFF表达式、carrier计划、故障前后值均在各 `*-setup/queue/ordinary/carrier/fault/restore.json`。规划实际最短间隔5tick；console在main之后，所以应在非规划tick arm，并在60秒内捕获下一规划tick。A特意暂停超过60秒，只借调度未启用保持无责任。B真实native后暂停注入+1H，不造receipt；恢复时仅减回1H。B、C真实service restart，最后service inactive，原dsh/nginx active见`engine/service-ending.txt`。

`db-before.json`和`db-before-unknown-restart.json`留在lab私有run目录，不随公开ZIP分发。正式原始全Memory/code备份留在本机私有audit目录，公开材料只保留相关投影、完整canonical任务、精确SHA和两房对象。

## 其它材料

- `before-product-regression.log`：改前真实产品入口失败；`archived-reference-replay.log`仅重现旧反例，不充当新修复通过。
- `logs/`：最终19套件107项、typecheck、build、4部署守卫；开发期3套件47项为本轮中间结果。
- `build-environment.json`：源码/锁/环境/命令/remote。已有其它remote未改变，本轮只用核实的origin fetch/push。
- `production-preflight*.json`：只读API代码身份、完整任务、Memory相关投影、两房对象。`production-business-derived.json`对应初次原Memory摘要，保留真实需求与R2关闭分析。
- `input/`：附包明确生产授权边界的原始文档；模板不是直接授权。
- `independent-*-review.*`：独立reviewer的精确范围与发现处理；评审者不操作生产/lab。

## 直接批准后的默认OFF发布

用户后续明确批准后，已发布原冻结字节并独立核对新tick，详细上线记录见相邻 `treasury-T1-exit-r1-off-deploy-20261002.md`；原件与专用校验器在 `production-off-deploy/`。本目录原工程verification.json及最初交付ZIP属于批准前时点，生产写入计数0只适用于当时；后续实际单次代码发布以publication-summary.json为准，T1业务仍未启用。

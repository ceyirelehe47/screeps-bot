# CPU 第七轮：市场预检摘要计算

用户认为市场安全预检成本过高。本轮在第六轮未发布候选上继续优化市场摘要计算，保留错峰规划、PowerBank 与中断诊断修改。正式服仍为 `182e5f43`，尚未上传候选或修改线上配置。

## 现场与热点

2026-10-10 的只读监控样本 tick `74246385`：120 个完成样本的总 CPU 平均为 93.89，`marketSalePreflight` 平均为 12.52，约占 13.3%。完成样本不能覆盖用户报告的 17:00 中断。

22:12:11 北京时间再次读取：tick `74246802`，总 CPU 平均 94.95，市场预检平均 13.27，约占 14.0%；最新单 tick 的市场预检为 33.10。该单个尖峰不能据此认定是 timeout 的原因。

用于离线诊断的 Memory 是当天 20:55 从账号 `forster`、`shard1` 读取的实际快照。市场状态约 1.03 MB，其中 V3 约 925 KB，permitChain 约 762 KB、ledger 约 112 KB、scope 约 43 KB。历史数据体积是定位线索，不能把全部历史体积等同于每 tick 扫描量。

服务器 V8 采样显示 `canonicalStableHashV1`、scope commitment、activation anchor 摘要路径是主要热点；快照冻结的 self 样本仅约 1.3%。初次诊断采样含一个同 tick provenance 拒绝帧及 23 个正常帧，不能用其毫秒数推算游戏 CPU。

## 实现与安全边界

仅修改 `marketDirectContinuousPolicy.ts` 中稳定摘要的内部计算：

- 每次仍完整规范化当前输入，保持排序键、UTF-16、数字规则和非法输入拒绝规则。
- 对长规范字符串保存前缀及四个混合累积器；只有当前字符串与缓存前缀逐字相同才复用，随后按原算法计算剩余字符及最终 avalanche。
- 最多保存 8 个前缀，每个最多 65,536 个 UTF-16 code unit。缓存只在 heap 中保存计算中间值；不保存授权结果，不写入 Memory。
- 原有全量冻结对象缓存与 `csh1:` 持久化格式不变。可变输入和浅冻结包裹的可变后代继续重读。

预检调用频率、授权链、额度、安全门、防回滚、WAL 和成交逻辑维持原流程。未通过跨 tick 身份缓存跳过市场校验，也未清理历史状态。摘要输出与 v1 逐位相同，无需迁移历史 Memory。

## 验证

构建、类型检查、测试及性能对照在 dsh 隔离目录 `/srv/screeps-treasury-build/market-preflight-cpu-r7-20261010/` 执行；本机仅编辑、查询、传输和产物校验。

独立旧实现与候选通过 1,200 组摘要对照，覆盖前、中、尾变更、不同长度、Unicode 及前缀上限。提交的固定摘要来自优化前实现；另有非法数据、缓存替换、原地修改和浅冻结后代变化回归。

完整预检严格 A/B 使用实际快照，每组每版 24 帧，交替先后顺序，共 7 组、168 对帧。测试 tick 从快照时间之后 100 tick 开始，每帧明确断言无拒绝原因及无 blocker，避免把同 tick provenance 拒绝带来的提前返回算作加速。计时不含 JSON fixture 创建及输出摘要。每版预检返回值、市场持久化状态与 runtime 状态的 SHA-256 均一致，市场原生写入均禁止。

| 指标 | 结果 |
| --- | ---: |
| 基线每组中位耗时 | 6,873.78 ms |
| 候选每组中位耗时 | 4,058.42 ms |
| 按每组比例计算的降幅中位数 | 41.28% |
| 各组降幅范围 | 40.35%–41.83% |
| 输出完全一致 | 7/7 组 |

这是服务器 Node/Jest 中的整个预检耗时，不能直接换算成 shard1 CPU 或全 tick 降幅。各列分别取中位数；主结果以逐组比值为准。单独 VM 哈希微基准仅用于差异校验和定位，不作为性能承诺。

生产及测试两份 TypeScript 检查通过。市场定向回归 8 套、31 项测试通过。完整回归 252 套、1851 项全部通过，耗时 540.1 秒；零失败、零 pending、零 todo。严格 A/B 的额外临时用例在全量回归和构建前已移出源码目录，不计入这 1851 项。

22:16:36 的独立 code GET 再次确认线上为原始 `182e5f43` bundle，SHA-256 为 `6a7edd67955cfa488cb00530ceaf286bf2c6804d90aba380284f4d15a57d305b`。本轮正式服写入次数为零。

同一干净提交随后在服务器完成 build-only，耗时 53.5 秒，保留既有循环依赖告警。服务器构建目录没有部署凭据和上传目标。

冻结产物：

- 提交：`22bbcb48f5eff368c0266253ade4e5e5fcda750f`；tree：`20779970e3c785cfe03305eb3fe3c2a676ded3ca`。
- 标签：`2026.10.10-2+22bbcb4@2026-10-10T14:22:15.103Z`。
- main.js：3,672,811 字节；SHA-256：`be4c8633631036b5e5e8c0ffb1e30d90f6ad69a9db400c31755fc454bbeeddb6`。
- 本机产物：[main.js](/Users/forst/code/screeps/.codex/worktrees/cpu-timeout-r6/monitor-data/cpu-r7-release/main.js)。
- 回执：[release-manifest.json](/Users/forst/code/screeps/.codex/worktrees/cpu-timeout-r6/monitor-data/cpu-r7-release/evidence/release-manifest.json)。
- 严格对照：[preflight-ab-strict-results.json](/Users/forst/code/screeps/.codex/worktrees/cpu-timeout-r6/monitor-data/cpu-r7-release/evidence/preflight-ab-strict-results.json)。

本机下载后的字节、构建身份、源码与证据 SHA 校验记录在同级 `local-verification.json`。报告后续提交只修改本文，不改变冻结的运行输入。第六轮的旧候选分支与旧产物仍保留。

## 发布与实服验收

候选分支 `codex/market-preflight-cpu-r7`，目录沿用 `/Users/forst/code/screeps/.codex/worktrees/cpu-timeout-r6`。正式发布需依照用户此前要求取得本轮单独批准。

批准后应重新核对账号、shard、活动部署和线上 bundle，保存现场并上传冻结字节，独立读回。实服验收需比较市场预检与整体 CPU 分布、拒绝原因和正常生产，同时持续观察超时通知；短窗口不能证明每日三次的故障已经消失。

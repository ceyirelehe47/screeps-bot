# Treasury Read-only Observation I — 独立验收记录

验收方式：独立只读 subagent 判读（2026-09-10），对象
`refactor/empire-treasury-rearchitecture` @ `37e3390`（基线 `77d67d6`，
链 d664256 → 5c8a9d3 → 37e3390）。判读代理自证未修改任何文件。

## 逐项判读结论

- **A 原样应用完整性 — PASS**：抽查 `git show d664256:<path> |
  git hash-object --stdin` 与 sha256sum，main.ts（blob `1b9346fd…` /
  sha `dbc9b688…`）与 readOnlyObservation.ts（blob `cbca4b01…` /
  sha `a183e20f…`）均与 manifest 逐字节一致；d664256 变更恰为 8 白名单
  文件；patch/zip 哈希与任务书一致；锚点保护拒绝实录在案；provenance
  before blob 一致；交付端 validation 原件齐备（4 变异全 detected）。
- **B 测试证据链 — PASS**：各 JSON 与日志数字一致（54/54、tsc×2、
  13/13、17/17、248 套 1539/1539、30/30）；「54 例不计 Jest」与 budget
  files/allocation 对照成立，246+2=248、1515+7+17=1539 算术自洽。
- **C 白名单纪律 — PASS**：77d67d6..37e3390 恰 11 文件全落白名单，受保护
  路径零改动；抽查三个独立反例（错 shard 零调用、同 tick 缓存后直改库存
  构造 mismatch、慢 getter 协作预算）均为真实构造非空跑。
- **D 默认关闭三重证据 — PASS**：源码（enabled:false、冻结空 rooms、
  无 Memory/env/console 开关）+ bundle（dist/main.js L111075-111084
  `enabled: false` 原样）+ 运行级（生产装配入口直调零输出测试）。
- **E main 行为顺序 — PASS**：treasuryReadOnly 精确插入 treasuryShadow
  后、treasuryEndTick 前（+3 行）；phase 表 41→42；原 6 用例完整保留
  （budget 仍 6，tier protected-full）。
- **F 五问材料 — PASS（齐备）**：五项均可直接据证作答。
- **G 预算治理 — PASS**：budget json 与 verify 脚本锚点同为
  `5c8a9d3ae2414bff7db7684f7d84ff6aaad5638c`、目标 248/1539，与
  jest-full.json 实测及两次独立全量运行一致，JEST_TEST_BUDGET=PASSED。

## 总判定

**支持 `READ_ONLY_CODE_VERIFIED / NOT_DEPLOYED`。** 七项判读全部
PASS；全程无任何部署、上传或线上验证动作的证据。

## 观察列表（均非阻断）

1. `01-apply/apply-record.log` 为复盘整理记录而非原始终端 transcript；
   其关键结论（8 文件逐字节 IDENTICAL）已由本判读独立复核为真。
2. 预算锚点指向代码收敛 HEAD（5c8a9d3）而非预算提交自身（37e3390），
   脚本注释已说明理由，自洽但依赖维护者理解该惯例。
3. frozen-diff.log 的「..HEAD」表述随仓库推进会自然过时，属证据时效性。
4. verify-jest-budget.log 混入 observation-only 性能基线的控制台输出，
   与预算判定无关；恰好佐证「Node wall-clock 非 Screeps CPU」口径。
5. 第二树差分如实记录主树构建时点 BUILD_DEPLOY_BRANCH=default 的环境
   差异并解释来源，未掩盖或强改 buildTime。

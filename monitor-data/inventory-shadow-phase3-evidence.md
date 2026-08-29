# 库存影子 Phase 3 验证证据（fee ledger fail-closed + Oracle + 轮转）

日期：2026-08-29　分支：`cpu-canary-market-safe`

## 真实执行记录（最终 clean tree，非 Budget Manifest 投影）

| 门禁 | 命令 | 真实退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run typecheck` | **0** | build+test 双 tsconfig 0 错误 |
| 2 | `npm run test` | **0** | 193 suites / **682 tests** 全过，135–146s |
| 3 | `npm run test:budget` | **0** | `JEST_TEST_BUDGET=PASSED`（suites 193 / tests 683） |
| 4 | `npm run build` | **0** | `dist/main.js` = **4,494,478 字节** |

- 执行时 commit（初版门禁）：`7a2dc3e`；终版门禁（typecheck 0 / test 683 / build 4,494,478 字节）：`f318a17`（clean）
- 执行时 tree：**clean**（`git status --short` 无输出）
- 构建嵌入校验：`dist/main.js` 含字符串 `7a2dc3e`（`__BUILD_COMMIT__` 注入）
- baseline 锚点（终）：`c3284cb`（口径修复提交）；budget 提交：`f318a17`

## 本轮提交

| commit | 内容 |
|---|---|
| `d09b140` | 四部分实现 + 测试（8 文件，+1282/−53） |
| `7a2dc3e` | budget 锚点 193/682（基线 d09b140）+ 复演脚本（初版） |
| `c3284cb` | oracle 总量口径修复（限定 store totalMode）+ shadow 12 例 |
| `f318a17` | budget 重锚 193/683（基线 c3284cb） |

## 用例数变化（budget 同步）

| 文件 | 之前 | 之后 |
|---|---|---|
| `marketSaleFeeLedger.test.ts` | 2 | 7（fail-closed 五场景） |
| `marketSaleSession.test.ts` | 12 | 14（接线：blocker 跨 tick / operator 修复） |
| `empireInventoryIndex.test.ts` | 11 | 12（capacity 语义） |
| `empireInventoryShadow.test.ts` | 7 | 12（轮转 / force flag / oracle 检出 / 低频 / 限定 store 口径） |

## 四部分要点

1. **Fee Ledger fail-closed**：`validateFeeLedger` tagged result；损坏证据以有界
   JSON（≤4096 字符）随 ledger 隔离（`invalid.rawEvidenceJson`）并镜像 direct
   quarantine；`fee_ledger_invalid` gate 首位拒绝 + extend/reprice mutation 停
   reconcile_gap + 账本写入/提取全部禁止；cancel 等 fee-ledger 无关 reconcile
   继续；operator 修复 = console 写 `Memory.runtime.marketFeeLedgerRepair`。
2. **独立 Oracle**：RESOURCES_ALL 全枚举 + `getUsedCapacity(resource)` 第三通道，
   验证 `sum(索引) === getUsedCapacity()`（oracleStoreTotal）与逐资源量
   （oracleResourceAmount）；测试证明 Object.keys 不可见资源可被检出。
3. **Production capacity**：8 个 used/free 总量 + 4 个 resource-specific
   `*FreeCapacityFor`；构建期固定允许集 ∪ 已持有资源实测；shadow 同口径对账。
4. **子层轮转**：默认 Core→Production→Field 单层；force（options 或
   `Memory.runtime.inventoryShadowForce`）全层 + oracle；oracle 每 5 次一次。

## Canary 观察结果（06ffedb，2026-08-29）

- **观察窗**：部署（global reset）后 ~73346470 → 73347913，共 **1,443 tick**（≥1000）。
- **检查次数**：~39 次（36 次默认轮转 + 3 次 force；≥25）。
- **parity**：parityChecks 累计 **22,982** 项；parityMismatches **0**；
  lastCheckMismatches 每次检查均为 **0**。
- **oracle**：oracleChecks **15** 轮（12 轮常规 + 3 次 force）；
  oracleMismatches **0**。
- **index counters（终值）**：inventoryBuilds 42、inventoryReuseHits 3,093、
  storeObjectsScanned 4,646、resourceKeysEnumerated 20,115、
  coreLayerBuilds 42、productionLayerBuilds 20、containerLayerBuilds 20、
  looseResourceLayerBuilds 20、deadStoreLayerBuilds 19、
  creepCargoLayerBuilds 20、powerCreepCargoLayerBuilds 20。
- **Shadow CPU**：
  - 默认轮转单层检查当拍：1.84 / 1.99 / 2.57（三个检查 tick 实测；
    Phase 2 全量单次为 5.35–5.56）；
  - force 全层 + 全层 oracle 当拍：17.23 / 29.09（operator 诊断路径，
    不在默认线上节奏中）；
  - empireInventoryShadow 摊平 EMA：**0.0816/tick**（Phase 2 为 0.124）；
  - 全 tick 总 CPU（154 样本）：avg 68.1 / p95 104.4 / max 139.8
    （p95/max 含 force 诊断 tick）。
- **中途发现并修复（SHADOW_PARITY 排查）**：首部署（8bf7112）首轮 oracle
  报 19 项 oracleStoreTotal（全部为 lab/powerSpawn/nuker）——逐资源
  oracleResourceAmount 零失配证明索引口径正确，总量对照口径对限定 store
  错用了无参 getUsedCapacity()。已修复（c3284cb：totalMode 按通用/限定
  store 区分）并重部署（06ffedb）后从零复验，全窗零 mismatch。
- **市场状态**：保持 v3-r3（未启用 r4）。marketPerf 每 tick 深恢复持续
  推进（观察窗内 498→1,405），无 fee gate 异常拒绝，生产 fee ledger
  完好未触发 fail-closed blocker。
- 采集原始数据：monitor-data/collect-inventory-phase3{,-v2,-v3}.jsonl
  （本地留存，不入库）。

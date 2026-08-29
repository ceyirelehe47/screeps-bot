# 库存影子 Phase 3 验证证据（fee ledger fail-closed + Oracle + 轮转）

日期：2026-08-29　分支：`cpu-canary-market-safe`

## 真实执行记录（最终 clean tree，非 Budget Manifest 投影）

| 门禁 | 命令 | 真实退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run typecheck` | **0** | build+test 双 tsconfig 0 错误 |
| 2 | `npm run test` | **0** | 193 suites / **682 tests** 全过，135–146s |
| 3 | `npm run test:budget` | **0** | `JEST_TEST_BUDGET=PASSED`（suites 193 / tests 682） |
| 4 | `npm run build` | **0** | `dist/main.js` = **4,493,453 字节** |

- 执行时 commit：`7a2dc3e7ff44833c89ad4f1d7301f1b3da09fbf4`（HEAD）
- 执行时 tree：**clean**（`git status --short` 无输出）
- 构建嵌入校验：`dist/main.js` 含字符串 `7a2dc3e`（`__BUILD_COMMIT__` 注入）
- baseline 锚点：`d09b140`（feature 提交）；budget 提交：`7a2dc3e`

## 本轮提交

| commit | 内容 |
|---|---|
| `d09b140` | 四部分实现 + 测试（8 文件，+1282/−53） |
| `7a2dc3e` | budget 锚点 193/682（基线 d09b140）+ 复演脚本 |

## 用例数变化（budget 同步）

| 文件 | 之前 | 之后 |
|---|---|---|
| `marketSaleFeeLedger.test.ts` | 2 | 7（fail-closed 五场景） |
| `marketSaleSession.test.ts` | 12 | 14（接线：blocker 跨 tick / operator 修复） |
| `empireInventoryIndex.test.ts` | 11 | 12（capacity 语义） |
| `empireInventoryShadow.test.ts` | 7 | 11（轮转 / force flag / oracle 检出 / 低频） |

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

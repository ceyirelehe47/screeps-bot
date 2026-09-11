# TOOLING_VALIDATION：rollup 属性消除产物与 dirty 检查器不兼容的解析器修复

日期：2026-09-11。执行环境：Windows 10、Node v22.19.0、真实候选 detached 构建树 @ PROFILE_HEAD 63c6f118cf15a501038b0dbaef9628f689c4f819。
依据 AGENT-RUN.md §5.2“实际Rollup输出形状与检查器不兼容时，只修解析器并保留正反对照，不修改游戏产物”。未修改 rollup.config.js、buildMeta.ts、产物字节或任何游戏源码。

## 现象（原样首跑）

`prepare-session.cjs` 对真实 Rollup build-only 产物报 `BUILD_SOURCE_OR_TARGET_MISMATCH`。

## 根因（对真实产物取证，非猜测）

冻结的构建管线中，`BUILD_INFO` 的非测试消费方只有 `deployAnnounce.ts`，仅引用 `tag/commit/tree/deployBranch/bundleHash`。Rollup 对未引用对象属性做消除，真实 `dist/main.js` 中：

- `BUILD_INFO` 块只剩 4 常量引用 + `get bundleHash()`，`dirty` 属性整个消失；
- 全文无 `const BUILD_DIRTY = "false";` 直接字面量，也无 `dirty: false,` 折叠字面量——检查器 `buildIdentity` 既有两种形态均无法命中，落回 `not_read`，`confirmBuild`（要求 `dirty==='false'`）拒绝。

dirty 声明在产物中不可恢复是构建器（冻结）的真实输出形状，不是候选或构建配置缺陷。

## 修复（仅 tools/protocol.cjs，完整 diff 见 protocol.cjs.folded-out-remediation.diff）

1. `buildIdentity` 增加 `folded_out` 识别：仅当 BUILD_INFO 块同时含 `commit: BUILD_COMMIT,`、`tree: BUILD_TREE,`、`deployBranch: BUILD_DEPLOY_BRANCH,` 引用签名，且全文不含 `BUILD_DIRTY` 痕迹时返回 `dirty:'folded_out'`；其余一切（缺签名、残留痕迹、多处块）保持 `not_read` fail-closed。
2. 另保留对 `const BUILD_DIRTY = typeof "false" !== "undefined" ? "false" : "false"` 三元形态的支持（三处字面量一致才采信）。
3. `confirmBuild` 额外接受 `dirty==='folded_out'`（commit/tree/branch 精确匹配与内嵌 bundle hash 自洽校验不变）。

清洁树等价保障：dirty 声明的安全价值是防意外脏树构建；`prepare-session` 前后两次 `assertCandidate` 已断言 detached 树干净、HEAD/tree 与产物内嵌身份精确一致，构建输出无脏树警告（rollup.config.js 在 dirty 时必打警告）。对抗“手改产物伪造身份”不在本检查器原有威胁模型内（字面量形态同样可伪造），未扩权。

## 正反对照（独立反例套件，11/11 通过）

- 正：真实消除形态（三常量签名+无痕迹）→ `folded_out`，`confirmBuild` 通过；直接字面量 `"false"` → 通过。
- 反：字面量 `"true"` 拒绝；缺 tree/deployBranch 签名 → `not_read` 拒绝；残留 `BUILD_DIRTY` 痕迹 → `not_read` 拒绝。

## 重跑（修复后）

- 100/100 工具测试通过（rerun-after-remediation.tap）；5/5 故障变异检出（mutations-rerun.json）；`verify-package` 46 文件 `PACKAGE_FILES_VERIFIED`（INTEGRITY.json 已更新 `tools/protocol.cjs` 为 bytes 6541 / sha256 `0279dc20b73ab949b094e85ac198719f901d6590db92d7f7a2e8957f080bb2ce`）。
- 真实产物链路：`prepare-session` 输出 `SESSION_PREPARED_NOT_DEPLOYED`（runId `ca35ed4a34b2ebca28cde980df5efbf9`，profileHead `63c6f11…`，originalHash `84f76975…`，candidateHash `cedf39e3…`）。

制作方 Linux 原件（validation/final-tests.*、mutations.json 等）未改动；原始 zip（sha256 `778a3075951b970a…`）保留未回写。

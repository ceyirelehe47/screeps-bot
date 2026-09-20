# 根因与修复

## 用户复现

2026-09-20 附件重复投递的 ZIP 仍为 Sep15 的 81,848 字节原版。包完整性通过，源码范围校验以 `ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED` 失败。用户报告没有 observe、候选/恢复 POST 或源码修改。

## 三项错误

| 原包错误声明 | 已归档 v4 与真实提交的路径 |
|---|---|
| `test/treasuryCompatRead.test.ts` | `test/treasury-compat/attribution.spec.cjs` |
| `fixtures/cpu-before-diagnostic-envelope-xii.ts.txt` | `fixtures/cpu-before-envelope-optimization-xii.ts.txt` |
| `fixtures/reader-before-diagnostic-envelope-xii.ts.txt` | `fixtures/reader-before-envelope-optimization-xii.ts.txt` |

表中 fixtures 前缀均位于 `test/treasury-compat/`。两份列表长度都为 11，所以只测数量无法发现问题。

## 修复

source-contract.cjs 验证原始 v4 实现锁的 6,895 字节、SHA-256 与 Git blob 后，从 `sourceImplementation.paths` 获取唯一范围。校验固定提交的完整父列表、tree、subject 和原生 Git NUL 分隔 diff；缺项、额外项、同数量替换、重复项都拒绝。源码不改。

物化工具在报告成功前调用 overlaid source.verifyHead，并把结果纳入最终 package inventory。source/apply/build/publish 保持使用相同校验入口。另修复 apply 输出对象的展开顺序，防止显式 SOURCE_REUSED_VERIFIED 状态被上游 status 覆盖；该改动不触碰任何仓库或网络写入。

## 认证回归

夹具包含精确的两个真实 commit 对象与 18 个变化目录 tree 对象。每个对象以标准 Git SHA-1 验证；Git 可据此计算固定 parent→source 的真实 11 路径 diff。未包含无变化子树及完整 file blobs，不是完整 clone。测试同时验证旧 source.cjs 复现失败、新校验逻辑成功。

## 未改变

runtime/ 7 个覆盖文件全部与 Retry I 原包逐字节相同；没有放宽 canonical 基线、CPU、采样数量或写入额度。新的 GitHub/在线状态必须在 Agent 运行时重新核验。

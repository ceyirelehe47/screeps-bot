# 安全处理记录：采集日志凭据脱敏与 Git 历史清理（2026-08-29）

## 事件

`monitor-data/collect-canary3.log`（Canary3 中期报告时入库）包含 33 行 Screeps
API 429 错误响应文本。Screeps 的 429 响应体内嵌带 token 的链接：

```
https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=<API token>
```

collector 的 `fetchApiJson` 曾把响应体截断 300 字符后原样写入错误消息，
`slice` 恰好截在 token 第一段 UUID 之后，使日志含 36 位 token 的 8 位十六
进制前缀（完整 token 36 位；前缀值不在此复述，见本地
`monitor-data/derived-canary3/log-summary.json` 锚定的原始日志）。经账号
所有者确认：**前缀不足以复原 token，不构成实际泄露，token 不撤销**。
但凭据材料不应留在 git 历史，按 P0 仓库卫生流程处理。

## 处置

1. **tree 清除**：`collect-canary3.log` 从 git 移除（磁盘保留，gitignore）。
2. **历史清理**：泄露仅存在于当时的分支 tip 提交 `f54076c`（单一提交、
   无其他 ref 包含该文件）。采用与 `git filter-repo` 等效的软重置重写：
   `git reset --soft f54076c^` 后剔除该文件重新提交，原提交从分支历史消失，
   随后 `git push --force` 更新 fork 分支。受影响提交的其余内容（Canary3
   报告、分析/预算脚本）原样保留在重写后的新提交中。
3. **原始日志锚定**：`monitor-data/derived-canary3/log-summary.json` 记录
   原始日志 SHA-256、行数统计与脱敏样本；原始 jsonl/日志一律不入库。
4. **统一脱敏**：新增 `scripts/lib/redactSecrets.cjs`（纯函数，惯例同
   `deployGuard.cjs`），覆盖 URL query 凭据参数、`Authorization`/`X-Token`
   头、auth-tokens 链接 query、常见 secret/key JSON 字段。
   `monitor-service.mjs` 在 `fetchApiJson` 错误构造与全部 catch 出口
   （memory/segment/fatal）接线；测试见 `scripts/lib/redactSecrets.test.ts`。

## 遗留说明

- GitHub 服务端可能短时间保留被重写提交的悬空对象（按 SHA 可达直到 GC）；
  因 token 未实际泄露且不撤销，无需联系 GitHub support 强制清除。
- 报告 `docs/cpu-canary3-report.md` 引用的 `6e53048`/`38a6b43` 均为重写后
  仍存在的祖先提交，无需变更。
- Jest budget 锚点与 build identity 的再生成见后续提交（锚点提交统一收口）。

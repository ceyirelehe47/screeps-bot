# Revalidation — 第二树独立复验（§7.3）

执行者：独立 reviewer subagent（读取任务书全文后执行）；同一 VALIDATION_HEAD `9bf6625503bc8f697fdc2ba1f30e8fb78c58678f` 上建立干净 detached worktree（C:\Users\15027\AppData\Local\Temp\labprep1-r2-tree2，已移除）。

## tree2-out/ 内容（全部原始产物）

- `node-version.txt` / `npm-version.txt`：Node v22.19.0 / npm 10.9.3。
- `npm-ci.log`：独立 `npm ci --no-audit --no-fund` 原始输出——896 包、约 21 秒、退出码 0。
- `lockfile-compare.txt`：双树 package-lock.json sha256 均为 `490ee9c70876f8ab72de2dd497331b9e177f63fe41565a837244401dad9c686a`（一致）。
- `resolve-paths.txt`：typescript/jest 实际解析路径均落在第二树 node_modules 内（非主树）；非 symlink 核验（lstatSync）。
- `jest-lab.json` / `jest-key.json` / `jest-defense.json` + 对应 `-stdout.log`：三组复跑（独立 `--cacheDirectory`），退出码均 0——LAB 1/22、KEY 9/102、Defense 11/118 全绿；`jest-summary.txt` 汇总。
- `reviewer-bundle/` + `reviewer-bundle-manifest-copy.json`：reviewer 在第二树自行构建的 single-shot 产物（27,697 字节 / SHA-256 `7730421d…811391`，与主验证一致）与 manifest 副本。
- `reviewer-vm-check.log`：reviewer 自写 VM 字节核对脚本输出（45 项全 PASS，exit 0）——要点：
  - 场景甲（B1 非 ASCII 结果拒写）：send 恰 1；send 入口内 attempted=true；最终槽 93 字节 ≤4096、仅 experimentId/armed/attempted/attemptedTick；size_limit 拒写行自报 bytes=6296 与 VM 外独立 `Buffer.byteLength` 计算严格相等；同 tick 二次 + 下一 tick + 全新 VM 同目标 tick 重建后累计 send 仍 1（新 VM 拒绝原因 already_attempted，非 tick 门禁掩盖）。
  - 场景乙（B2 受支持字段超限读取）：预置记录独立证明 5145 字节 >4096；三次 loop 全部 control_record_corrupt（无 already_stopped）；send=0；槽引用与内容零变化。
  - 场景丙（4096/4097 独立边界）：同形状记录实测恰 4096 字节（error=3951×x）→ already_stopped 且直读 ok；恰 4097（error=3952）→ control_record_corrupt 且直读 corrupt；短合法对照 ok；纯 JS measureUtf8Bytes 与 Buffer.byteLength 在中文/emoji 代理对/转义/孤立代理等 7 组输入严格相等。
  - 沙箱仅 module/exports/console/Game/Memory；探针证明 Buffer/TextEncoder/process/require 均 undefined。
- `budget-manifest-check.txt`：target.tests=1465、probe budget=22 核对通过；target.commit 实测 ae991e5（有意设计：锚点=实现提交，verify-jest-budget.mjs 的 requiredTarget 不校验 commit 字段，与 Remediation I 的 b6ab29a 模式一致——非缺陷，reviewer 已核 commit message 与 allocation.note 佐证）。
- `REVIEWER-LOG.md`：reviewer 全程步骤/命令/退出码/结论记录。
- `trace-key/` / `trace-defense/`：第二树 Jest 运行的 TREASURY_SEAL_EVIDENCE_DIR trace 产物。

## 剔除说明

第二树 `jest-cache/`（约 7.6M，`--cacheDirectory` 指向的可再生缓存）未归档；其余产物全量入仓。无第二树与主树结果互相顶替的情况（全部为第二树本地运行输出）。

## 清理确认

`git worktree remove --force` 成功；`git worktree list` 仅剩主树；主仓库 status --porcelain 前后均为空、HEAD 恒为 9bf6625。

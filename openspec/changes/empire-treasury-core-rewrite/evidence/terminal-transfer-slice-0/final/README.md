# final/ — 固定 VALIDATION_HEAD 主验证原始产物（M01/M03/M08）

- 验证提交：`0ce9d971bcf72daf19a1fe68fd7bb384e4db56fe`（`validation-head.txt`；验证期间 HEAD 未动——`head-after.txt` 相同）。
- 运行环境：node v22.19.0（`node-version.txt`）；工作目录 `D:\code\screeps\screeps-bot`（`workdir.txt`）；验证前后 `status-before.txt`/`status-after.txt` 均为空（干净）。
- 脚本原件：`run-mainval.sh`（§7.2 模板实现）与 `tail-rerun.sh`（尾段重跑，见事件记录）。两份为**验证期 bash 驱动原件**（仓库外编写、随产物归档供重演；非提交物、非 Jest 收集对象）。
- 步骤命名惯例：每步 `<name>.command.txt`（完整参数）+ `<name>.log`（原始 stdout/stderr）+ `<name>.exit-code.txt`。

## 退出码汇总（全部预期内）

| 步骤 | 退出码 | 说明 |
| --- | --- | --- |
| production-freeze / config-freeze / defense-freeze | 0×3 | 相对 869149d 零生产/配置/Defense 差异 |
| typecheck / typecheck-build / build | 0×3 | bundle sha256 `1ef35d7f65401febd4755440094bbc19e261a0e44337cf8a8d9821f65f2658fe` |
| jest-key（六件） | 0 | 6 suites/65 tests（含新增 Slice0 8） |
| jest-treasury | 0 | 33/582 |
| jest-defense（十一件） | 0 | 11/118 |
| jest-full | 0 | **237/1428**（236/1420 → +1 suite/+8 tests） |
| budget | 0 | `JEST_TEST_BUDGET=PASSED` 237/1428（自带全仓重跑，独立标注、不覆盖主 JSON） |
| verify-evidence | 0 | 本轮产物四份 H18 trace（各 54 检查点 problems=0）+ 四份 Jest JSON；helper 自 0ce9d97 加载（blob `fd930a44…`） |
| selftest-archived-ok | 0 | 上轮归档产物正例（输入 hash 固定） |
| selftest/empty | 1 | 零输入负例（预期非零） |
| selftest/tampered | 1 | 篡改负例（checkpoint unknownRisk 置 null——驱动报告"风险证据缺失"） |
| diff-check | 通过 | 由尾段重跑承担（`tail-rerun.log`；`MAIN_VALIDATION_DONE` 到达即 set -e 全链通过；未单独落盘 exit-code 文件） |

## 事件记录（如实）

- **首跑中断与重跑**：`mainval-run.log` 完整保留——首跑在驱动自测篡改环节因**验证脚本参数笔误**（node 篡改脚本的目录参数传了 selftest 根而非 tampered 子目录）ENOENT 中断：副本未被篡改、驱动对其正确返回 0，随后 `test RC_TAMPER != 0` 断言失败退出。该失败暴露的是 bash 驱动笔误，**不是提交物缺陷**（驱动 .mjs 对未篡改输入返回 0 恰为正确行为）。`tail-rerun.sh` 修正参数后重做尾段：篡改成功（sha256 `2b4ce575…` ≠ 正例 `26ac6de5…`）、驱动 exit 1 报"风险证据缺失"、diff-check/HEAD/status 全过、`MAIN_VALIDATION_DONE`。
- trace 四目录为本轮四组 Jest 运行中 J06 经 `TREASURY_SEAL_EVIDENCE_DIR` 落盘的轨迹原件（各 1,180,356 字符、54 检查点）。
- selftest/tampered/trace-key 内含篡改后的轨迹原件（负向对照留痕，sha256 见其 tampered.log）。

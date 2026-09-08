# baseline/ — Remediation II 起点基线（b938a15 隔离 worktree 实跑）

- `slice0RemediationIIBaseline.test.ts.txt`：基线测试原件（3 it）——R-A
  100+60 歧义误报 committed（amount 在唯一性检查前被过滤）、R-A 对照
  （无注入 committed——正确行为）、R-B 四间受管辖健康房间 C→D 经业务
  协调器 admitted 且 submits=1（无路线拒绝规则）。
- `jest-baseline.log`：起点实跑输出（3 passed / 3 total）。
- `run-command.txt`：还原命令。

还原方式：在起点 `b938a15` 的隔离 worktree 中将 .txt 复制回
`src/runtime/treasury/slice0RemediationIIBaseline.test.ts` 后执行
run-command.txt 的 jest 命令。

修复后退化对照（任务书 §6：起点行为 + 修复后预期即目标退化对照，不另建
变异驱动）：同一文件复制到修复后开发树（2099e56）实跑——R-A 转
`still_uncertain` 红、R-B 转 `rejected` 红（行为改变实证）、R-A 对照保持
绿（正确行为未破坏）。该对照运行发生在提交前开发树，未单独留存日志
（基线归档与 O 用例断言同链路：O01 注册路径 a 与 O03 即其修复后形态）。

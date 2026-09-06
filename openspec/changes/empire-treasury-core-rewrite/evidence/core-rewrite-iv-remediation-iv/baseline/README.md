# Remediation IV 基线反例（44593c8）

- `treasuryR4BaselineReplicators.test.ts`：三反例重现器源码（基线 worktree
  内运行的原始版本——含 R1-TRACE 轨迹打印；主仓 `src/runtime/treasury/`
  下的同名文件是其修复后语义回归版，V1/V2 用例断言已切换为新包装口径）。
- `baseline-replicators.log`：基线运行日志（exit=1，3 failed）。
- 运行命令：`npx jest --config jest.config.cjs --runInBand --no-cache
  --runTestsByPath src/runtime/treasury/treasuryR4BaselineReplicators.test.ts`
  （基线 worktree，HEAD 见 baseline-head.txt；node_modules 经主仓 junction 共享）。

三反例的基线行为差异（修复后语义断言在基线上全红）：

- R1：嵌套 beginTick 实际 cleaned:3、预算轨迹 1→7→1（尾写覆盖回退）、
  累计释放 6 次 > 4 上限、C 剩余义务 2（正常路径应 3 次释放/剩余 5）。
- V1：作用域声明 B、实际提交许可 A——visibleFor(A)=[]（事件被错记到 B）。
- V2：恢复入口不拒绝错来源（performTreasuryFullReset 正常返回）——
  世界已恢复 1000 时可据 J1 的旧分支效果误判 committed。

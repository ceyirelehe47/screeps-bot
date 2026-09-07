# Remediation VI 负向变体（J07）

两个变体都在修复后主仓（b8fc019 工作树）上应用 patch、真实编译并运行
目标测试收集行为红灯，随后 `git checkout` 还原并复跑确认恢复绿。红灯均
为**行为断言失败**（非编译错误）。

## 变体 1：heap-only-gate.patch（退回仅 heap 门禁）

- patch：`kernel.ts` 的 `admissionGateStatus` 删除持久关窗分支（只剩
  heap 否决——即 4ba065a 的 kernel 门禁形态）
- 运行：`heap-only-gate.run.log`，exit 1——`treasuryRemediationVIKernel.test.ts`
  9 用例中 3 红：
  - J01 主用例红（完整 reset 后 admit 不再被拒——持久口径缺失）
  - J02 主用例红（executeDispatch/executeRearm 门禁隔离失效）
  - J03 坏 ring 用例红（ringDegraded 下持久关窗判定消失）
  - 其余 6 绿（heap 否决相关语义不受影响——判别准确）
- 还原后复跑：`restored.run.log`，21/21 绿（IVKernel 12 + VIKernel 9）

## 变体 2：zero-advance.patch（healthy fixture 下零推进）

- patch：`kernel.ts` 的 `runLifecycleAdvance` 中 `let used` 初始化改为
  `TREASURY_CORE_RECOVERY_BUDGET_PER_TICK`（份额视为已尽——所有推进循环
  立即退出；编译友好，非提前 return）
- 首版尝试（`return {0,0,0,0}` 提前返回）因 unreachable-code 类型收窄
  编译失败被弃用——变体必须可编译（任务书 J07）
- 运行：`zero-advance.run.log`，exit 1——`treasuryRemediationIVKernel.test.ts`
  12 用例中 9 红：
  - **J06 红（目标）**：进度断言抓住零推进（releaseCalls=0、remaining 不减、
    无 closing 完成）
  - H01–H07 中依赖真实推进的 8 用例红（变体破坏调度本身，附带合理红）
  - J05 绿（fixture 合法性与调度无关）、零推进负向对照绿（其断言的正是
    零变化指标——判别函数可检测性的直接验证）
- 还原后复跑：`restored.run.log`，21/21 绿

## 文件

- `heap-only-gate.patch` / `zero-advance.patch`：`git diff` 产出的最小变体补丁
- `heap-only-gate.run.log` / `zero-advance.run.log`：行为红灯完整输出
- `restored.run.log`：还原后 21/21 绿

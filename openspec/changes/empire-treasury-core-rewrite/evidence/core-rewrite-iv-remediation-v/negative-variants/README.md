# Remediation V 负向变体（I14）

两项目标回退变体（对修复后工作树应用 patch → 定向**行为红** →
`git checkout --` 还原 → 定向绿；全部为可运行 Jest 用例的语义红灯，非编译
错误、非零收集）：

| 变体 | patch | 红灯用例 | 红点 |
| --- | --- | --- | --- |
| R1 晚关窗（publishTickClosure 移回恢复循环之后） | r1-late-closure.patch | I01/I03（VKernel） | 回调进入时 `lastEndTick=null`（I01）；onEffect 抛错后窗口仍开、业务放行（I03）。I02 不红——变体只回退发布顺序，模块级否决标记层仍在（分层证据：顺序与否决是两道独立防线） |
| V1 删缺分支拒绝（恢复 IV 的"仅 eventBranch 存在时校验"+ 移除 memorySnapshot 拒绝） | v1-missing-branch-dropped.patch | I07/I08 两用例（VService） | 缺 eventBranch 恢复被放行（toThrow 红——错结论路径重新打开）；memorySnapshot+oracle、普通数组通道同放行 |

每变体附 `.red.log`（exit=1）与 `.restored.log`（exit=0，定向套件全绿：
R1 还原 11/11、V1 还原 8/8）。

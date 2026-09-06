# Remediation IV 负向变体（H20）

三项目标回退变体（对已提交修复 21c705b 应用 → 定向红 → `git checkout --`
还原 → 定向绿；重现器/探针均为可运行 Jest 用例，非编译错误）：

| 变体 | patch | 红灯用例 | 红点 |
| --- | --- | --- | --- |
| R1 endTick 漏锁 | r1-endtick-no-ownership.patch | H01（IVKernel） | 嵌套 beginTick 实际推进（cleaned≠0）、预算回退、释放超限 |
| V1 声明身份分离 | v1-declared-identity-split.patch | H08（IVService） | 错配输入不再被拒（toThrow 红）；事件归属探针：visibleFor(A)=[]（事件归声明 B）——v1-declared-identity-split.attribution-red.log |
| V2 删来源核实 | v2-no-source-verification.patch | H12（IVService） | 错 journal 断点恢复被放行（toThrow 红） |

每变体附 `.red.log`（exit=1）与 `.restored.log`（exit=0，定向用例绿）。
V1 的事件归属探针源码补档于 v1-declared-identity-split.attribution-probe.ts.txt
（**Remediation V/§4.1 取证修订**：原以 .ts 后缀存档于验证后补交，不满足
"验证前提交的可执行重现器 / 不执行归档"二分——现转为明确的非执行 .txt
文本归档；其运行输出为 attribution-red.log，行为等价断言已由
Remediation V 的 I07/I08/I09 与 IV 轮 H08/H12 测试树承担。历史提交不改写）。

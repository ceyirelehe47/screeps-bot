# R1 实现与证据边界

## 固定改造

**Commitment 构建。** 每次构建仍独立执行 task 与 reservation 的完整枚举、记录验证、健康判定、路由合并、owner/expiry、溢出与 completeness 标记。仅把始终按字符串作用域/房间使用的两个私有桶索引换为 null-prototype 字典，保留计数；公开房间查询保持原 Map 不隐式转换非字符串键的语义。by-reason、merge route、reservation/owner 的 Map 保留。删除每次创建的 invalid-counter 对象和捕获闭包，将六个相同计数位置内联；不改变更新顺序或错误路径。

**Commitment 查询视图。** 十一个查询方法的定义移出 build 激活记录，函数定义仍在受计时的 reader 初始化中建立；每次索引绑定独立私有状态。解构调用、call 绑定其他对象、metrics 计数、动态容量 delta、options 的原有读取方式均保持。绑定函数仍会分配，不能把“共享定义”写成“零分配”或声称因此必然解决 JIT/GC。

**Observation 视图。** 查询方法定义共享，快照与资源查询 memo 状态仍逐 view 私有，绑定行为保持；storage/terminal 求和不再为二者分配临时数组。Store 稀疏枚举、容量读、回调时序、冻结、重复房间的 ordinal/last-wins 语义和查询缓存语义保留。

**没有采用的改造。** 不复用前置 table 检查取得的键列表作为后续 builder 的全部输入；这种优化可能在两阶段之间有回调/输入变化时漏读。当前包保留原有读取点和两层不同目的的检查。不能对外声称“已经合并两次表扫描”。

## 来源与生成

完整基准 Core 从 `477a20c9...` 获取，70443 bytes，Git blob `614e97c72a54cef8385ae6fd0a1a9c756dcb564d`。制作端保存的文本与该身份相符。

生成器仍以原固定历史输入为起点，经原来的 V/VII/IX/XI/XII/XIII/XIV/XV authoring 链，再接 R1 外层变换；loader 模板不变。R1 的两个 factory-block 变换均是唯一锚点匹配和精确逆变换。最终输出全文的 bytes/SHA-256/Git blob 固定在 `implementation/core-identities.json`；原 canonical inputs 身份不改。

原 provenance 的 XV 字段是历史链身份，本次添加独立 `readPathR1.implementationRevision` 和 authoring/rules 元数据。不得把历史 `sourceCommit` 当成 R1 新源码提交。

历史测试的两个必要适配：XIV 逆变换先剥离 R1 再剥离 XV；XV 原阶段的精确变换断言对剥离 R1 后的对应阶段比较，其业务对拍继续使用当前 Core，缓存分配插桩同时支持原变量与新私有 state 字段。没有移除断言、放宽数值期望、删 test 或加入 skip。

## 制作端检查不意味着什么

43 项 Core 测试直接执行完整基准/候选 Core 的实际 JS 函数体，只移除两个精确的 type-only TS 包装位置。512 组固定种子混合输入属于其中一项差分测试，不能把它们伪称为额外 512 个 Node test。另有 59 项工具测试，包含固定 Git 对象提取的临时仓库测试和失败闭锁测试。

VM Game/Memory/Store 是合成宿主。操作次数、Map 分配数、Node wall-clock 均不是 Screeps CPU。没有真实线上调用，也没有制作端全仓库 TypeScript 5.9.3、467 Node、165 继承执行器测试、195/685 Jest 或 Rollup 全门禁的通过声明。

Agent 必须在任何 POST 前真实运行全部门禁。完整读取是否进入 2 CPU、冷态固定开销是否下降、历史尖峰是否消失，只能由新实机证据判断；本包不预判。

## 新实验后的决策

实机恢复与业务进展分开判定。恢复通过但业务仍 partial 时，本次集中改造路线输出结构评审要求，而不是通过新轮号自动继续。四点达标且有余量，只表示具备提交独立审查的短窗口证据；没有覆盖的非空 reservation 或最终尾部仍保持未知。

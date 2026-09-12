# 接续关系与冻结边界

本包新建CPU复测IV，不废止已验收的CPU Diagnostic II或Loader Optimization III。旧任务包及其结果继续保留，不重新解释为“从未失败”或“已经证明CPU预算修复”。

执行基底是先前交付并实测收尾通过的CPU Diagnostic II包：ZIP SHA-256 af24fd786e46a92b069d25475783e945a27753b7fbebd0f73467e828b4d9fae9。现在采用新compat提交ae15ec5和新refactor提交33cfbd4；重新锁定含生成器、模板与新生成blob的全部冻结输入。

动作、网络传输、解码、采集、独立恢复、恢复运行验证及采样门禁算法不重写。runtime/common.cjs只有候选祖先常量更换；runtime/policy.cjs只有本轮身份、路径、session kind和注释更换，四点/预算/时序阈值不变。保留的新生产诊断源码不变，新增比较仅在Node端离线运行。

新增预检核验已接受的CPU II与Loader III Git裁决原件；build-only增加loader regeneration --check。新增compare从本轮原始日志重新验收后按真实调用次数解释阶段成本，避免把未调用的边界区间纳入函数耗时。归档和发布时重新计算该结果。

不将旧私有session或候选复用到新run，不使用历史绝对tick，不修改旧原始日志，不重跑旧实验。没有旧whitespace豁免。

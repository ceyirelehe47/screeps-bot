# Compat Read Optimization V

完整实现＋固定测验包；Agent只验证，不继续开发。以已恢复OFF的CPU IV为起点，减少剩余每样本定义初始化，保持完整索引与库存独立读取。

入口：`AGENT-RUN.md`。唯一源码补丁：`patches/0001-read-context-and-endpoint-reuse.patch`；自动应用以`implementation/`的固定字节为准，两者等价。无需另外下载历史任务包。

本轮离线：预算2、配置OFF、零Screeps API、无token、无候选上传/恢复。不要执行旧CPU IV的observe入口。

初次成功定义加载7个factory，后续0个（仍复制每样本资源目录并创建新builder/context，不是零CPU）。每次继续完整构建observation/index。承诺代码只做可逆的上下文传参适配，未缩减校验/聚合/owner/到期/查询；不使用全局activeContext。

直接端点只在本次同步读取内复用Store引用。两房两资源：直接Store属性访问24→4；全部容量/资源方法及独立core读取保持原样。这些计数不是CPU提速百分比。

成功也只能是`READ_V_OFFLINE_VERIFIED_NOT_DEPLOYED`；真实引擎预算问题仍未解决。下一轮实测另行授权。

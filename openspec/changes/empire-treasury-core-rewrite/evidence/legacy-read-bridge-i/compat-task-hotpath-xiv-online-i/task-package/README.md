# Task Hotpath XIV + Online I

自包含执行包。入口是 AGENT-RUN.md；无需物化，无 npm 安装步骤。
完整实现、固定17路径补丁、生成器追溯、保语义回归、65项工具测试、
原生Git工作流、单次四点在线观察及独立恢复、只读对账和证据发布均已提供。

本轮不是已证明的性能修复：两项确定性操作减少 + 有界 first-pending 归因。
exact在线task记录未捕获，Node回放不可换算成引擎CPU。Agent只执行与验收，
不得现场改包/改测试修绿。出错保存原始证据，不重跑观察或刷新写入配额。

固定基线、源码范围、完整tree和每文件前后身份由policy.json/source-manifest.json
共同锁定；源码已应用的精确同一子提交可以resumed，不创建第二个源码提交。

# 制作方验证边界

环境：Linux、Node v22.16.0、TypeScript由容器已安装包提供；原生Windows、完整仓库195/685和Rollup生产构建尚待Agent执行。

测试使用真实读取器/CPU模块源码和合成Room/Memory端口，不冒充真实生成核心的线上工作负荷。子进程是实际Node进程；WebSocket与世界状态是假远端；HTTP有真实loopback服务。部分75秒等待在测试依赖中压缩，官方入口没有加速开关。

Git归档/暂存/原生whitespace/提交/本地bare推送为真实Git操作，但仓库base是明确合成夹具。没有获取私有模块快照、真实token、连接官方Screeps、执行候选上传或恢复。尝试通过容器获取GitHub仓库时DNS不可用；源码身份通过已连接GitHub与用户上传的固定包核对，未声称完整克隆。

不会将工具测试全绿写成真实2 CPU预算缺口已解决，不会从四点诊断自动推导生产切换。

# 0003 Recovery & Evidence Remediation I

完整实现、固定测试、补丁镜像与 Agent 测验任务书。入口为 `AGENT-RUN.md`。

本轮仅处理已经发生的观察 0003：先按精确模块字节核对当前线上状态；必要且允许时补完原来未进入 POST 边界的唯一恢复；用新的 75 秒恢复专用 collector 取得运行证据；对旧原始日志的十六进制 HTML 实体进行离线回放。

没有新的观察候选或窗口，不改 compat/生产源码，不提高 CPU 预算。原正式 0003 入口因已有缺陷而停止复用；本包不是 0004，也不是已完成性能优化的声明。

`runtime/closure.cjs` 负责有限读取、一次性原恢复标记和分层结果。`runtime/transport.cjs` 的唯一写方法只接受锁定的旧生产 main SHA，不能上传候选。`runtime/closure-observer.cjs` 是独立的恢复取证通路，不复活、不拼接旧 collector。`runtime/verify-closure.cjs` 直接重算新原始日志，不用旧 sample failure 作为恢复健康条件。

`runtime/decoder.cjs` 支持单层命名/十进制/十六进制实体。`runtime/replay.cjs` 将收到报告与完整合格样本分开计数。CPU 未完成项按证据保留，不从一个 partial 报告推导子阶段归因。

`vendor/deployGuard.cjs` 是固定 Git blob 的原始实现；`vendor/0003` 的四份文件保留旧包原字节，供类型一致的模块对拍及不放宽的样本验收使用。这些文件没有候选上传入口，旧有 `samples.decode` 仅作负对照；新解析入口使用 `decoder.cjs`。

所有网络行为只能通过任务书中明确的恢复命令启动。制作方测试用临时 Git、127.0.0.1 HTTP、模拟 WebSocket；不包含凭据或模块快照。

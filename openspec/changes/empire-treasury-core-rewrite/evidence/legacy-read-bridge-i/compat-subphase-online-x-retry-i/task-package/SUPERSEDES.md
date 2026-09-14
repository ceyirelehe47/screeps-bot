# Supersedes

本包取代 `screeps-compat-subphase-online-X-v2-2026-09-14` 的线上执行部分。

上一包已经完成并推送 source-manifest remediation 与完整离线门禁，但 collector 在候选上传前的账户只读请求上收到一次 `HTTP_TRANSPORT_ERROR`；服务器未收到候选。该失败证据作为本包固定先决条件读取，不再重做 remediation。

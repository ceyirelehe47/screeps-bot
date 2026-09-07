# task/ — 任务原文与读取记录

- `task-brief.md`：任务书逐字副本（来源 `C:\Users\15027\Downloads\treasury-terminal-transfer-slice-0-implementation.md`）。
- SHA-256（两处一致，三方核对：Downloads 原文、本副本、reviewer 复算）：
  `1d1d835376fb95b5c897511070024085f971b578ab7d05efd96daf15ad6f55f5`
- `read-records.md`：实施期读取记录。

## read-records.md 内容

- 2026-09-07 实施起点读取：本地 HEAD = 远端 HEAD = `1b1279ff7161ffc6f2bee31daec1c3fe619184da`（fetch 后核对，无增量），与任务书 §1 起点一致；工作树干净。
- 读取方式：附件全文内嵌 + Downloads 文件双源；hash 以 Downloads 原文计算。

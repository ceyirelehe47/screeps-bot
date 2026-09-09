# offline/——Calibration Rerun 正式离线验证（§9，VALIDATION_HEAD=f8631d0）

- `mainval/`——主树完整验证：npm ci／typecheck×2／生产 build／五组 Jest
  （lab 3/43、slice 3/23、treasury 35/597、defense 11/118、full 242/1486，
  各带独立原始 JSON）／预算自跑 PASSED（242/1486）／三产物构建
  （`lab-observer` 9935B·`64635ecb…`、`lab-single-shot` 29281B·`9309e4f7…`、
  `lab-run-i-main` 8496B·`f22fba60…`，`lab-bundle-identities.json` 核对
  manifest 自洽+内嵌已纠错历史配置）／diff-check／三组冻结 diff 全过
  （`freeze-production/root/lab-and-slice`，输出为空=零差异）／
  `full-diff-name-status.txt`（BASE→HEAD 全量改动清单）／
  `sendgate-strict-base-diff.txt`（相对 STRICT_BASE 8c5459c 的 sendGate
  diff：仅 shard 读取块显式化——收紧而非放宽）／`cal02-healthy`
  （exit 0）与 `cal02-mismatch`（exit 1，三项差异一次齐报）为 C02 离线
  对照真实运行记录（**真实预检未运行**——本轮无新世界事实，未绑定新
  实验）／`dist-untouched.txt`（生产 dist/main.js 前后 SHA 一致
  `ded52ff6…`，实验构建未覆盖）。
- `second-tree/`——第二干净工作树复现（同一 VALIDATION_HEAD、独立
  `npm ci`、依赖解析到本树 node_modules：jest@29.7.0／typescript）：
  LAB 3/43、Slice 3/23 全绿；三产物程序字节与主树逐一相同
  （`bundle-compare.txt`：observer/single-shot/main/example JSON 均
  IDENTICAL；manifest 的 generatedAt/路径差异不参与比对）。同一执行者
  操作，称"第二环境复现"，不是独立 reviewer 或 CI。

## 工程事故披露（不影响验证结论）

主验证脚本 `mainval/run-validation.sh` 尾部断言把普通 `git diff`（无
`--exit-code`，恒退 0）误判为应退 1，导致**全部命令已执行完毕并记录
退出码之后**脚本提前退出（`wrapper.log` 原样保留该记录；外层管道经
`tee`，其退出码不代表脚本）。补跑 `run-finish.sh`（记录见 `finish.log`、
`finish-note.txt`）：先核对 HEAD 仍为 VALIDATION_HEAD 且工作树干净，
再按正确语义（`sendgate-strict-base-diff.txt` 非空=存在差异）完成剩余
断言并补写 `validation-head-after.txt`／`status-after.txt`。所有命令的
执行与退出码均发生在同一 HEAD 的同一次验证内，无重跑、无掩盖。

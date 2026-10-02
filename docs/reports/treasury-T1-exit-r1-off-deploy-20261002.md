# T1-EXIT-R1 默认 OFF 修复发布记录

2026-10-02，用户直接回复“批准”后，已向 `screeps.com/default/shard1` 的 forster 账号发布已冻结且通过独立审查的修复。独立 GET 完整模块读回一致，随后确认新版本在 tick `74076808` 实际运行。T1保持默认OFF，未arm、未调用Treasury native；本次完成的是默认OFF安全更新。

## 发布与实际运行

| 项目 | 证据 |
| --- | --- |
| 直接授权 | 用户“批准”，对应前一条“是否批准发布这份默认OFF修复”；仅代码发布范围 |
| 发布时Git HEAD | `f0b606fedffe12e0bcd0bd1d05ffb6b03ef60ff7`，clean；origin已推新分支 |
| 冻结构建源 | `447ab5c45717ea73af026f60a5c4287080af703f`；产品与运行字节没有重建或修改 |
| 发布工具 | SHA `a3882af6232c8d7a3cb37f7ea0fce06ca9912bb8850abadaf4dd545f97c4f091`，独立评审范围内的同一工具 |
| 操作 | `--check`及`--apply`各自重新读取四shard；单次code POST accepted，随后独立GET，不重试 |
| 模块 | 仅main；3285061字节；SHA `1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061` |
| 新运行tag | `2026.10.2-1+447ab5c@2026-10-02T06:10:35.260Z` |
| 内嵌bundle标识 | `31d7862330a31f620544e07482933253e658806373f42def32ab51f27665c955`，与完整文件SHA分开核对 |
| 新tick证据 | 08:52:51 UTC独立捕获，resourceControl.updatedAt=74076808，高于发布前monitor tick74076755 |
| 运行CPU/Memory | CPU sample74076807总用56.71、bucket10000、tickLimit500；Memory实际UTF-8 1532193字节 |

发布前保存了全部旧代码及四shard完整Memory私有备份。直接授权及每次操作的无凭据记录、完整canonical任务和新运行标签投影在 `treasury-T1-exit-r1-evidence-20261002/production-off-deploy/`。原始完整代码/Memory备份留在本机私有audit目录，不推仓库或公开ZIP。上传前旧main精确匹配bdfde69f…，没有覆盖未知现役版本。

## 结束状态

新tick捕获的完整22任务仍无 E3N59→E4N58 H 任务，全部task lease为空；T1 control主/镜像、quota、kernel均不存在，有效OFF。没有创建接纳窗口或新Treasury责任，没有修改任务、货物或额度。普通resourceControl持续刷新，并保留普通能量发送动作记录；这不是T1发送或T1首笔结算证据。

08:55:34 UTC又独立读取四shard完整Memory：shard1新tag、23条完整任务、无T1责任和lease；shard0/2/3原Memory SHA逐字节未变，均无T1启用或责任。市场配置前后投影/指纹相同，R2主/镜像持续closed。未执行Memory写、console probe、迁移、arm、换资源/路线或定时观察。

实现、107项回归、最终main隔离 A/B4/C2 和独立源码/产物审查为发布前已完成的依据，详见 `treasury-T1-exit-r1-20261002.md` 与独立最终审查。此次生产只验证默认OFF修复已运行；首次Treasury native、真实交易确认、业务扣减、责任交回仍未发生，不宣布首笔writer验收通过。

本次批准的动作已完成，停止新增生产操作。以后如需原T1业务切片，须有适用的直接授权及当时真实原路线任务/自然备货，并临入场重新核验；UH后继建议不在本次发布授权内。

## 可重跑校验

```bash
python3 docs/reports/treasury-T1-exit-r1-evidence-20261002/production-off-deploy/verify-off-deploy.py
```

校验器从直接授权、实际apply输出、独立代码/新tick投影、四shard完整任务投影及市场配置前后原件推导；不读取其自身verification.log的passed。`release/manifest.json`和旧发行ZIP的`productionWritesPerformed=false`属于发布前冻结时点，保留原件；本报告与`publication-summary.json`是之后的实际发布状态。冻结构建身份保持不变。

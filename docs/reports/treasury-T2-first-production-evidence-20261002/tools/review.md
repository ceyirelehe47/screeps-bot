# T2 生产工具独立审查

审查日期：2026-10-02（Asia/Shanghai）。审查者：独立只读子代理 `scope_review`。

范围：`scripts/deploy-frozen-t2.mjs`、本目录的 `capture-production.mjs` 与 `product-console.mjs`。只检查生产工具；本文件不是产品代码、最终构建字节、隔离引擎或生产首片验收的放行。

本轮生产权限根据当前会话的用户直接上线请求和实现代理明确的有限业务范围判断；附件文本仅用于规格和验收对照。

## 初审结论：存在行动阻断项

1. **旧 Treasury 坏值/未知责任被当空。** 初版 `noTreasuryResponsibility` 接受 `runtime.treasury={schemaVersion:999}`、`{unknownResponsibility:{attemptId:"x"}}` 与 `{receipts:null}`。实际现场基线没有该旧根，安全处理应拒绝任何非空或损坏旧根，不能猜测。实现代理已修；本次无网络行为测试中未知字段与 null 反例已通过。
2. **产品动作缺独立账号与当前代码读回门槛。** 初版控制台工具仅检查 secret 中 hostname/branch 和 Memory 中 tag/hash，没有 `/api/auth/me` 与完整 main 模块 SHA 读回。错误账号仍可写临时键，代码已漂移时仍会提交产品动作。必须在 console POST 前拒绝。
3. **POST 未知与结果键生命周期不完整。** 初版 action POST 超时直接退出，没有继续按原 marker 读取；marker 在动作及诊断全部返回之后才落地，动作成功而 snapshot 抛错时无法区分已执行边界。cleanup 的 API accepted 也未证明实际键已删除。必须先记执行边界，捕获动作/诊断异常，未知仅追读原 marker，cleanup 后读回确认，不重发产品动作。
4. **现场代码取证接受缺失 main。** 初版 capture 接受空对象/空数组模块集，可能将无 executable main 的响应记作合法代码证据。须验证完整 main-only 字符串模块集合。
5. **私有审计目录需检查实际权限与位置。** `mkdir(...,mode:0700)` 不会收紧既存目录权限。全代码/全 Memory 应拒绝位于 Git 工作树或权限过宽的目录，并使用 0600 排他新建文件；不能依赖调用者以后记得排除打包。

## 已确认的合理机制

- 部署工具按候选完整 SHA、字节数、commit/tree、clean、build tag、bundle hash、自身工具 SHA、正确 fetch/push URL 绑定冻结输入；部署前读取当前 main-only 模块和四 shard 完整 Memory，并核对 HTTP 与 API 成功。
- 部署代码 POST 只有一次；异常后独立 GET，代码中没有第二次 POST 或自动回退。
- 代码及全 Memory 备份使用 `wx` 与 0600，且发生在上传之前；已有相同备份路径会拒绝覆盖。
- 产品 arm 参数使用 JSON 序列化的精确 task ID 与安全整数创建 tick；产品入口自身继续核对任务、结构、owner、部署、预算、并发与承诺。控制台工具不能替代产品的原子核验。
- capture 的公开原件保存业务投影与代码摘要；完整代码/Memory 留审计目录，不输出凭据。

## 可复核验证

新增 `deploy-guard.test.mjs`，使用 Node 内建 test 与独立子进程完全替换 fetch；仅 fake token，无网络，无生产写入。测试覆盖 Memory API/压缩/坏根、legacy 坏状态、账号、代码 SHA 漂移、未知 POST 同 marker 追读、一次动作、正向 arm、cleanup 读回和代码取证的完整模块。

运行：

```bash
/Users/forst/.nvm/versions/node/v22.23.3/bin/node --test docs/reports/treasury-T2-first-production-evidence-20261002/tools/deploy-guard.test.mjs
```

初轮原件：`../tests/tool-guard-review-red.txt`，9 项中 4 通过、5 失败（legacy 修正已在该轮前完成）。随后加了正向 arm 用例和更严格的 mock 调用计数；最终修正脚本需重跑全部用例并追加通过原件。

初次读取时脚本身份（后续修正应另记摘要）：

| 文件 | SHA-256 |
| --- | --- |
| deploy-frozen-t2.mjs | dbc588b0fd7cfdada8894be61340aae2671f587cb2ab232b385ec1b999b33dca |
| capture-production.mjs | 620706173884bfab9423fcbb3b3f7129957f7b6193fd0074027d1c03c92e39bc |
| product-console.mjs | 341c8f95cf83fc4c91cf35b827cd13879a2b39b809172cffdfe5db8f465417f6 |

## 修正复审结论：本范围工具通过

上述五项已按修正后源文件重新只读核对。旧根任何非空或损坏拒绝；产品工具校验真实账号、main-only 当前代码 SHA，先写 executing marker 再调用产品，捕获异常保留结果，POST 未知仅读原 marker，清理后读回；代码取证拒绝缺失 main；两个私有目录入口使用 realpath、工作树/common Git 根范围、非 symlink、0700 验证，备份文件仍排他新建为 0600。

补充发现 `relative` 值以 `..` 开头但仍是仓库子目录（如 `..audit`）的放行缺口，实现代理已按路径分隔符修正两个工具。新增独立临时 Git 仓库的无网络反例，确认该目录被拒且未写完整代码备份。中间有一次 import 被置于 shebang 前的语法失败，原件 `../tests/tool-guard-review-fixed.txt` 留存；实现代理修正后 3 个工具 `node --check` 全通过。

最终全量工具检查原件：`../tests/tool-guard-review-final.txt`，**11 项通过，0 失败、0 跳过**。`../tests/tool-guard-review-green.txt` 是前一轮 10 项通过原件，不能替代最后的 11 项。

本次复审精确身份：

| 文件 | SHA-256 |
| --- | --- |
| deploy-frozen-t2.mjs | 741e9805323d8076d7134e7d757994b8f9aa934f94949621917b6ac825a028c4 |
| capture-production.mjs | 3a0c64cbbb6c0ce5c14e3c6e814fc22b39e29ec6424822b80a41b2130f74a83e |
| product-console.mjs | 7c36b39c2adc918d584fd5ec6d23ba26b2a76181c24d5d092a11afa5abb9cff8 |
| deploy-guard.test.mjs | d5656b6ab5f01b593df6f2872fe9c1614249f5e1c1782909c1f2c0a881abf6cf |

当前范围没有剩余行动阻断项。此结论仅放行上述工具身份的工程实现，不代表生产任务就绪、产品最终字节放行或真实 UH 首片通过。实现代理告知当前 UH 真实需求为 0，本轮不执行 apply/arm；本审查未独立核验该业务结论。未检查真实生产数据、未运行隔离引擎、未检查最终产品 commit/main 字节。

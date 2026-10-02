# Energy 容量缓解反向补能回归

## 行为与边界

新增回归位于 `src/runtime/resourceControl.capacityRegression.test.ts`。E3N59 保持 capacity pressure（Storage 空闲 148859，高于接收安全水位但低于恢复水位），Storage Energy 191141、Terminal Energy 18531；已有 30000 的 outgoing `capacity:relief:energy` 自动任务。E4N58 同时已有正常 `automatic` UH 任务，目标 E1N57、用途 `synthesis:E1N57:UH2O`。没有暂停或人工修改正常任务状态。

Red 复现同周期 E4N58 自动向 E3N59 补能 8859、E3N59 向 E4N58 执行 relief 10000，从而占用 E4N58 的 Terminal 动作窗口。该测试把手续费设为 0，以隔离 receiver 选择问题；金额并非线上 5982 的复刻。Green 要求不出现反向自动补能，E3 的 relief 仍发送 10000，且 E4 的正常 UH 实际发送 10000、任务完成。

另覆盖 source_depleted、receiver_capacity、过期、done、cancelled、failed、pending 剩余量为 0、目标房间缺失、普通非 relief Energy 出库、非 Energy relief；它们不应无谓禁止普通补能。

## Red 取证方法

首次原源码运行已取得反例，但当时新产品源码存在独立的 TypeScript 编译错误，需要临时关闭 ts-jest diagnostics。随后在协作期间重跑日志被覆盖，故最终 red 证据重新使用完整 TypeScript diagnostics 获取。

最终 `energy-relief-reverse-balance-red.log` 使用 `/tmp/treasury-energy-relief-regression/resourceControl.balance-baseline.ts`：冻结当时完整 ResourceControl 源码，只移除新增的 receiver filter。实际产品源码没有被回退或改写。Jest 临时 moduleNameMapper 仅将 `^@/runtime/resourceControl$` 指向该冻结副本。唯一移除差异见 `energy-relief-baseline-filter.diff`。

执行命令：

```bash
npx jest --config /tmp/treasury-energy-relief-regression/jest.balance-baseline.cjs --runInBand src/runtime/resourceControl.capacityRegression.test.ts -t 'outgoing Energy relief|outgoing relief responsibility'
```

结果：healthy 反例 1 失败、其它边界 10 通过，原有 4 个场景未选择。未关闭 diagnostics。

`energy-relief-reverse-balance-red-diagnostics-disabled.log` 是中间状态记录：首版过滤已落地，但 pending 剩余量为 0 仍挡补能，出现 1 失败、10 通过。它不是最终 baseline red，也不是最终 green。该失败推动增加正整数且大于 0 的剩余责任检查。

## Green 取证方法

`energy-relief-reverse-balance-green.log` 使用常规项目 Jest 配置和实际产品模块，没有 moduleNameMapper 替换，没有禁用 diagnostics。

```bash
npm test -- --runInBand src/runtime/resourceControl.capacityRegression.test.ts src/runtime/resourceControl.test.ts
```

结果：2 个测试文件、20 个场景全部通过。此处只证明离线回归行为；线上执行结果须以本轮生产取证为准。

冻结 baseline SHA-256：`c16a377b8789216ba120000d0b39bb869da64ef1b5e9b3ee17b393a4d58389a6`。

为确保归档后可核查，冻结源码与当时临时配置原文分别存为 `energy-relief-resourceControl-baseline.ts.snapshot.txt`、`energy-relief-jest-baseline.cjs.snapshot.txt`；`.txt` 后缀防止其参与项目编译。

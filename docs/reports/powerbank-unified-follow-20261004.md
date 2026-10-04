# PowerBank 统一交通与跟随修复

2026-10-04，shard1；用户已明确授权修复验证后直接上线。

## 现场问题与根因

W1N57 的 E0N52 增援任务 `6ac16eb43db1630fa86a1041`，红 `powerBankAttacker-74108432`、绿 `powerBankHealer-74108472`，在 tick 74109006 已完成强化、无疲劳且处于 travelling，却在 Terminal (28,32) 附近绕行。tick 74109025 的原生状态反复出现 `movementPushedAt`，位置历史局限在母房中心的小圈，调度仍将新位置误认为进展。

小队格检查使用帧初占位，未接受共用交通已经提交的让路结果，可能撤销领队而留下让路副作用；同步跟随又要求同帧贴身，线形道路上不能容许尾随等待。临时等待还清空旅行状态，使成员被普通交通当成 idle 再次推动。

服务器在原发布源码 3315092 上复现：线形道路的一名普通单位先让路，随后领队被撤销移动。红先执行和绿先执行两种顺序均失败，日志为服务器 `pb-owned-room-hotfix-20261004/evidence/follow-baseline-failure.log`。

## 修复

- 所有角色共用 `traffic.ts` 的当帧真实移动回执及落点索引。已提交让路的单位不再次被推动，已提交的落点不能再被另一单位或让路动作抢占；取消成功后才释放落点。
- 小队使用同一套“已移动／已有落点”判断，尾随补领队旧格，不覆盖已有正确尾随意图。
- 房内 travelling 允许短暂相距两格。尾随被堵时保留领队已接受的前进，下一帧使用共用房内寻路补位；跨房、敌方所有权和战斗贴身条件保留原安全门。
- 等待搭档时保留共用旅行状态，到达工作位置后正常清理。没有免推名单或小队专用交通例外。

已只读比较 Google Drive `screeps` 目录的 [Tigga](https://drive.google.com/file/d/1GFC9rv7y8CURj5eoS2py7PT7C46VywYk/view)、[admon](https://drive.google.com/file/d/1u5-uSciuE0O-ra9XaMwIHKZ-ecGRrHNV/view) 和 [CaptainMuscles](https://drive.google.com/file/d/1lIWSLYsOWW4rqTnUxLIf23S_uQ2lOy6m/view)。Tigga 的母房行军距离、admon 的队列补位和 CaptainMuscles 的尾随旧位置提供了比较依据；没有执行这些压缩包中的代码或复制其整套寻路。

## 验证与发布

最终源码 `cd4ba1888fc094c1433919c3d4ac95ede40bb228`，版本 `2026.10.4-5`。

服务器冻结后的所有 movement、roles、mount 和 PB 生命周期相关回归：45 套、333 测试通过；两套 TypeScript 检查及构建通过。线形道路覆盖两种执行顺序、临时分离及补位；普通交通覆盖空的下一格不推周围单位、已让路不重复推动、真实取消后释放落点。

本次没有在最终源码上重新运行全部 232 套：沿用 ad4b037 的完整回归（231 套、1536 测试通过，唯一失败是新增 Memory 字段清单），3315092 只修正该声明测试并通过 11 套／136 测试。本次最终增量的所有改动及版本文件由发布工具限定并绑定 45 套／333 的冻结结果，未修改财务源文件。

单次上传确认 accepted，独立 GET 确认 main 3,543,046 字节，SHA-256 `fa42ac4288502135b55279c12cb1c36155463bd8a562bd06630dca8e70031054`。tick 74109628 原生运行确认：

- 标签：`2026.10.4-5+cd4ba18@2026-10-03T23:20:58.126Z`
- tree：`4729a5d32dc9410f5a0ca35b7115075bbc68f3f4`
- append 前 bundle hash：`b6a34ec867b8a413a040a551b3b618eb400ebd7614e8bb0ae4e6f33dea237d37`

部署与验证文件：`/Users/forst/Downloads/screeps-unified-follow-20261004/`。原始代码／Memory 备份保存在其中私有 `upload-audit/`，没有提交入仓库。服务器日志位于 `/srv/screeps-treasury-build/pb-owned-room-hotfix-20261004/evidence/`。

## 现场核验边界

原 E0N52 增援在本次发布前已不在 Game.creeps 中，不能算作该队被修复救回。tick 74109628 新 E5N59 队伍在 (20,22)/(21,23)，向北侧出口行军且 stuckTicks 为零；W1N57 的新队伍当时仍在孵化，须待实际出生／强化完成后继续核对。

tick 74109743：E5N59 同一对已推进到 E6N60 (39,38)/(38,38)，满血无疲劳；W1N57 新红 `powerBankAttacker-74109530` 在 (42,21)、绿 `powerBankHealer-74109575` 在 (41,22)，向东出口 (49,24) 行军，均满血、无疲劳、stuckTicks 为零。它们已离开 Terminal 区域；此时仍需继续核对真实过房。

tick 74109800：上述 W1N57 红、绿实际到达 W0N58 (13,35)/(13,36)，TTL 为 1349/1424，满血、无疲劳，确认已走出母房并到达目标房间。同一对 E5N59 红、绿推进到 E7N60 (42,20)/(41,21)，目标仍为 E8N60，满血、无疲劳、stuckTicks 为零。只读原生证据保存在 `screeps-handoff-20261004/pb-unified-follow-exit-proof-events.json`。

必要增援、低级 NPC 无强化优先、伤害／治疗推进预算、清剿六跳路线与完整 CPU A/B 仍在架构候选中继续，不包含在本次发布完成声明里。

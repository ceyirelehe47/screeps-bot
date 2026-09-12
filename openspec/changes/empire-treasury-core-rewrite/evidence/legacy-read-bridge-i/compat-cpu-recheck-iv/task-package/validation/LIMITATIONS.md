# 制作方验证边界

环境：Linux，Node v22.16.0，TypeScript 5.8.3，Git 2.47.3。原生Windows/NTFS、用户完整仓库的195/685、整仓TypeScript与Rollup留给Agent验证；制作方不声称已经运行这些环境检查。

128项固定测试包括继承的96项与本轮32项；包含真实子进程、loopback HTTP、临时Git、bare remote和真实旧/新生成读取器。测试中的Room/Memory、远端状态与WebSocket是明确模拟输入；CPU端口成本和恢复等待缩短只用于功能验证，不能用作Screeps CPU证据。

历史CPU II对照文件与已取回的Git blob 5112f9cc691bb1637b3c94e5b9cee0da0d9e9bbb完全一致；它是原已验收裁决，不是制作方新实验，不声称重验整段原始WebSocket流。比较只继承这份历史裁决的数值；新run必须由当前verifier重新读取原始证据。

制作方没有凭据、没有连接Screeps、没有候选或恢复POST，没有新的四点实测，没有用户仓库提交或推送。新包不保证持续网络故障或机器退出后的恢复必然成功；保留一次性写边界与不覆盖第三方代码的限制。

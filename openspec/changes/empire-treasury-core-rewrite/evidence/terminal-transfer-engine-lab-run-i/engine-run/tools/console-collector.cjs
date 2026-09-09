/**
 * Engine Lab Run I —— 用户 console 外部收集器（一次性隔离环境专用）。
 *
 * 用途：真实 runner 的用户 console 输出经 driver.sendConsoleMessages 走
 * storage pubsub 频道 `user:<id>/console` 发布，不落库；无订阅者即丢失。
 * 本脚本直连本次隔离环境的 storage RPC（127.0.0.1:21027），把订阅到的
 * 每条消息以 JSONL 追加到外部文件，作为实验的外部日志通道。
 *
 * 用法：node tools/console-collector.cjs <输出.jsonl> [频道]
 *   频道默认 '*'（全部发布事件，含 channel 字段可事后过滤）。
 *   只在本机一次性实验环境使用；不读取任何凭证。
 */
'use strict';
const fs = require('fs');

const OUT = process.argv[2];
const CHANNEL = process.argv[3] || '*';
if (!OUT) {
    console.error('usage: node console-collector.cjs <out.jsonl> [channel]');
    process.exit(2);
}

process.env.STORAGE_PORT = process.env.STORAGE_PORT || '21027';
// storage 监听在 IPv6 回环 [::1]；'localhost' 与引擎子进程的默认解析一致
process.env.STORAGE_HOST = process.env.STORAGE_HOST || 'localhost';

const storage = require('../server/node_modules/@screeps/common/lib/storage');
const stream = fs.createWriteStream(OUT, { flags: 'a', encoding: 'utf8' });

let count = 0;
storage._connect().then(() => {
    // RpcClient.subscribe 的回调约定：发布数据是唯一位置参数，频道名在 this.channel
    storage.pubsub.subscribe(CHANNEL, function (payload) {
        count++;
        stream.write(JSON.stringify({
            seq: count,
            recvWallClock: new Date().toISOString(),
            channel: this.channel,
            payload,
        }) + '\n');
    });
    console.log('COLLECTOR_READY channel=' + CHANNEL + ' out=' + OUT +
        ' storage=' + process.env.STORAGE_HOST + ':' + process.env.STORAGE_PORT);
}).catch((e) => {
    console.error('connect failed:', e && e.stack || e);
    process.exit(1);
});

// 保持进程常驻；每 30s 输出心跳便于核对收集器一直在线
setInterval(() => {
    console.log('COLLECTOR_HEARTBEAT received=' + count);
}, 30000);

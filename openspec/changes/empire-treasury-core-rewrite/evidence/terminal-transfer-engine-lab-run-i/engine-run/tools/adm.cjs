/**
 * Engine Lab Run I —— 隔离环境管理脚本（直连 storage RPC，不经 backend CLI 服务器）。
 *
 * 背景：官方 `screeps cli` 管道式调用断开时触发 backend readline 未处理的
 * ECONNRESET 使 backend 进程崩溃重启（实测 backend.log.1）。本脚本直接调用
 * backend CLI 模块的同源实现（仅依赖 @screeps/common 的 config/storage），
 * 复用官方命令逻辑而不触碰 CLI 服务器。
 *
 * 用法（在 lab-run-i-exec-env 目录）：
 *   node tools/adm.cjs <子命令> [参数...]
 * 子命令：
 *   gen-room <room> [jsonOpts]   map.generateRoom
 *   open-room <room>             map.openRoom
 *   spawn-bot <ai> <room> <username> <gcl>   bots.spawn
 *   pause / resume               system.pauseSimulation / resumeSimulation
 *   eval <js表达式>              任意 storage 操作（返回 JSON）
 * 环境要求：STORAGE_PORT=21027（默认）、MODFILE 指向 world/mods.json（默认）。
 * 只在本机一次性实验环境使用；不读取任何凭证。
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.STORAGE_PORT = process.env.STORAGE_PORT || '21027';
process.env.STORAGE_HOST = process.env.STORAGE_HOST || 'localhost';
process.env.MODFILE = process.env.MODFILE || path.join(ROOT, 'world', 'mods.json');

const common = require('../server/node_modules/@screeps/common');
const cliMap = require('../server/node_modules/@screeps/backend/lib/cli/map');
const cliBots = require('../server/node_modules/@screeps/backend/lib/cli/bots');
const cliSystem = require('../server/node_modules/@screeps/backend/lib/cli/system');

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd) {
        console.error('usage: node tools/adm.cjs <gen-room|open-room|spawn-bot|pause|resume|eval> ...');
        process.exit(2);
    }
    common.configManager.load();
    await common.storage._connect();

    let result;
    switch (cmd) {
        case 'gen-room':
            result = await cliMap.generateRoom(args[0], args[1] ? JSON.parse(args[1]) : undefined);
            break;
        case 'open-room':
            result = await cliMap.openRoom(args[0]);
            break;
        case 'spawn-bot':
            result = await cliBots.spawn(args[0], args[1], {
                username: args[2],
                gcl: args[3] ? +args[3] : undefined,
            });
            break;
        case 'pause':
            result = await cliSystem.pauseSimulation();
            break;
        case 'resume':
            result = await cliSystem.resumeSimulation();
            break;
        case 'eval': {
            // eval 子命令：在含 db/env/pubsub/crypto 的作用域里执行一段表达式
            const db = common.storage.db;
            const env = common.storage.env;
            const keys = env.keys;
            const crypto = require('crypto');
            const q = require(path.join(ROOT, 'server/node_modules/q'));
            // eslint-disable-next-line no-new-func
            const fn = new Function('db', 'env', 'keys', 'q', 'storage', 'crypto', 'common', 'return (' + args.join(' ') + ');');
            result = await fn(db, env, keys, q, common.storage, crypto, common);
            break;
        }
        default:
            throw new Error('unknown command: ' + cmd);
    }
    console.log('RESULT ' + JSON.stringify(result));
    process.exit(0);
}

main().catch((e) => {
    console.error('ADM_FAILED ' + (e && e.stack || e));
    process.exit(1);
});

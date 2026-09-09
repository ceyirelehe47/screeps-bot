/**
 * Calibration Rerun——外部限时停止保护（S03/S04）。
 * 恢复模拟前启动：180 秒墙钟后无论窗口状态如何强制 system.pauseSimulation，
 * 并把触发时刻与当时 gametime 写入日志（先到者停止：窗口完成由主流程暂停，
 * 本保护兜底 180 秒上限）。只连本轮 loopback storage RPC，零游戏世界写
 * （pauseSimulation 除外）。
 */
'use strict';
const fs = require('fs');

const OUT = process.argv[2] || '../evidence/s04-stop-guard.log';
const LIMIT_MS = 180_000;
process.env.STORAGE_PORT = process.env.STORAGE_PORT || '21027';
process.env.STORAGE_HOST = process.env.STORAGE_HOST || 'localhost';

const common = require('../server/node_modules/@screeps/common');
const startedAt = new Date();
fs.appendFileSync(OUT, `start ${startedAt.toISOString()} limitMs=${LIMIT_MS}\n`);

function finish(line) {
    fs.appendFileSync(OUT, line + '\n');
    console.log(line);
}

common.storage._connect().then(() => {
    setTimeout(() => {
        const cliSystem = require('../server/node_modules/@screeps/backend/lib/cli/system');
        common.storage.env.get(common.storage.env.keys.GAMETIME)
            .then((gametime) => cliSystem.pauseSimulation()
                .then((r) => finish(`triggered ${new Date().toISOString()} gametime=${gametime} pauseResult=${JSON.stringify(r)}`)))
            .catch((e) => finish(`error ${new Date().toISOString()} ${e && e.message}`))
            .finally(() => process.exit(0));
    }, LIMIT_MS);
}).catch((e) => { finish(`connect-failed ${e && e.message}`); process.exit(1); });

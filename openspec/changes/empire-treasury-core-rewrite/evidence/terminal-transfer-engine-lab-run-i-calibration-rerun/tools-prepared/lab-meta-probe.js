/**
 * lab-meta-probe——只读元信息采样器（Calibration Rerun C02 facts 来源）。
 *
 * 状态：准备件（PREPARED_NOT_RUN）——本轮离线交付时归档源码与 SHA-256；
 * 实机复验（S01–S06）授权后作为合成用户的 bot AI main.js 装载，每 tick
 * 输出一行 `lab-meta-facts-sample` JSON（经用户 console 通道由外部收集器
 * 收流）。只读零写：不写游戏 Memory、不武装控制槽、不调用 send、不修改
 * 任何游戏对象；世界观测字段与 calibrationCheck.ts 的
 * CalibrationSampleFacts 形状一致（wallClock/runId/userId 由 facts 装配
 * 步骤从收集器时间戳、会话标识与管理侧用户记录补齐，不在玩家侧伪造）。
 *
 * 房间/资源常量按任务书 §0.2 固定：W1N57（源）→ W10N57（目标），H/100。
 */

"use strict";

var PROBE = {
  name: "lab-meta-probe",
  version: "1",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  resourceType: "H",
  amount: 100,
};

function describeError(error) {
  if (error instanceof Error) return error.name + ": " + error.message;
  return String(error);
}

function readController(controller) {
  if (controller === undefined || controller === null) return { present: false };
  return {
    present: true,
    my: controller.my === true,
    level: typeof controller.level === "number" ? controller.level : undefined,
    ownerUsername: controller.owner !== undefined && controller.owner !== null ? controller.owner.username : undefined,
  };
}

function readEndpoint(roomName) {
  try {
    var room = Game.rooms[roomName];
    if (room === undefined) return { readStatus: "room_missing" };
    var terminal = room.terminal;
    if (terminal === undefined || terminal === null) return { readStatus: "terminal_missing" };
    var store = terminal.store;
    return {
      readStatus: "ok",
      terminalId: terminal.id,
      ownerUsername: terminal.owner !== undefined && terminal.owner !== null ? terminal.owner.username : undefined,
      my: terminal.my === true,
      // 真实引擎 isActive 是方法（准备件初版误当属性读出 false，未武装
      // 阶段修正）；对方法调用取值，对布尔属性直接读。
      isActive: typeof terminal.isActive === "function" ? terminal.isActive() === true : terminal.isActive === true,
      controller: readController(room.controller),
      resourceAmount: store[PROBE.resourceType] !== undefined ? store[PROBE.resourceType] : 0,
      energy: store.energy !== undefined ? store.energy : 0,
      freeCapacity: typeof store.getFreeCapacity === "function" ? store.getFreeCapacity() : null,
      cooldown: terminal.cooldown,
    };
  } catch (error) {
    return { readStatus: "read_error", error: describeError(error) };
  }
}

function readShard() {
  try {
    if (Game.shard === undefined || Game.shard === null) return { name: undefined };
    return { name: Game.shard.name };
  } catch (error) {
    return { readError: describeError(error) };
  }
}

function readWorldSize() {
  try {
    return typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : null;
  } catch (error) {
    return null; // 诊断字段：读取失败记 null，不参与核对
  }
}

function readFeeQuote() {
  try {
    var cost = Game.market.calcTransactionCost(PROBE.amount, PROBE.sourceRoomName, PROBE.targetRoomName);
    if (typeof cost !== "number" || !isFinite(cost) || cost < 0) {
      return { status: "unavailable", error: "报价端口返回非法值：" + String(cost) };
    }
    return { status: "ok", energyCost: cost };
  } catch (error) {
    return { status: "unavailable", error: describeError(error) };
  }
}

function readTransactionView(direction) {
  try {
    var raw = Game.market[direction];
    if (!Array.isArray(raw)) return { status: "read_error", error: "交易视图端口返回非数组：" + typeof raw };
    return { status: "ok", count: raw.length, records: raw.map(function (entry) { var copy = {}; for (var key in entry) { if (Object.prototype.hasOwnProperty.call(entry, key)) copy[key] = entry[key]; } return copy; }) };
  } catch (error) {
    return { status: "read_error", error: describeError(error) };
  }
}

module.exports.loop = function () {
  var source = readEndpoint(PROBE.sourceRoomName);
  var target = readEndpoint(PROBE.targetRoomName);
  var line = {
    kind: "lab-meta-facts-sample",
    sampler: { name: PROBE.name, version: PROBE.version },
    tick: Game.time,
    shard: readShard(),
    user: { username: source.readStatus === "ok" ? source.ownerUsername : target.readStatus === "ok" ? target.ownerUsername : undefined },
    worldSize: readWorldSize(),
    source: source,
    target: target,
    feeQuote: readFeeQuote(),
    transactions: { incoming: readTransactionView("incomingTransactions"), outgoing: readTransactionView("outgoingTransactions") },
  };
  console.log(JSON.stringify(line));
};

'use strict';
/** OFFLINE authoring only. VII groups full task indexes by scope/room and
 * removes two observation intermediates. No table filtering, lazy query index,
 * source cache, admission change or omitted validation. Both directions check
 * exact occurrence counts. Reversibility is provenance, not a semantic proof;
 * differential full-API tests supply the latter within the declared domain. */
const RULES = [
  [
    "task-map-storage",
    "    const outgoing = new Map();\n    const outgoingByReason = new Map();\n    const pendingIncoming = new Map();\n    const incoming = new Map();\n    const incomingTaskCountByRoom = new Map();\n    const outgoingTaskCountByRoom = new Map();\n    // route merge 预构建索引：mergeKey → taskId（查询零线性扫描）。\n    const mergeIndex = new Map();\n    // receiver 维度预聚合：房间 → 健康入站合计/任务数（canonical 谓词）。\n    const healthyIncomingByRoom = new Map();\n    const healthyIncomingCountByRoom = new Map();\n",
    "    // VII: full task indexes share storage by scope/room, not by sample.\n    // These private maps are fresh for EVERY build. Route and reservation\n    // indexes retain their own maps; no validation or query is deferred.\n    const taskScopes = new Map();\n    const taskRooms = new Map();\n    const mergeIndex = new Map();\n"
  ],
  [
    "valid-pending-task-aggregation",
    "        const outKey = taskKey(task.fromRoomName, task.resource);\n        const mergedOutgoing = addSafeInteger((_d = outgoing.get(outKey)) !== null && _d !== void 0 ? _d : 0, task.remainingAmount);\n        const mergedPendingIncoming = addSafeInteger((_e = pendingIncoming.get(taskKey(task.toRoomName, task.resource))) !== null && _e !== void 0 ? _e : 0, task.remainingAmount);\n        if (mergedOutgoing === null || mergedPendingIncoming === null) {\n            recordInvalid();\n            incompleteScopes.add(outKey);\n            incompleteScopes.add(taskKey(task.toRoomName, task.resource));\n            continue;\n        }\n        outgoingTaskCountByRoom.set(task.fromRoomName, ((_f = outgoingTaskCountByRoom.get(task.fromRoomName)) !== null && _f !== void 0 ? _f : 0) + 1);\n        outgoing.set(outKey, mergedOutgoing);\n        const byReason = (_g = outgoingByReason.get(outKey)) !== null && _g !== void 0 ? _g : new Map();\n        const mergedByReason = addSafeInteger((_h = byReason.get(reason)) !== null && _h !== void 0 ? _h : 0, task.remainingAmount);\n        if (mergedByReason === null) {\n            recordInvalid();\n            incompleteScopes.add(outKey);\n            continue;\n        }\n        byReason.set(reason, mergedByReason);\n        outgoingByReason.set(outKey, byReason);\n        pendingIncoming.set(taskKey(task.toRoomName, task.resource), mergedPendingIncoming);\n        const countsTowardDemand = (0, resourceTransferTaskHealth_1.countsResourceTransferTaskTowardDemand)(task, healthOptions);\n        if (countsTowardDemand) {\n            const inKey = taskKey(task.toRoomName, task.resource);\n            const mergedIncoming = addSafeInteger((_j = incoming.get(inKey)) !== null && _j !== void 0 ? _j : 0, task.remainingAmount);\n            if (mergedIncoming === null) {\n                recordInvalid();\n                incompleteScopes.add(inKey);\n                continue;\n            }\n            incoming.set(inKey, mergedIncoming);\n            incomingTaskCountByRoom.set(task.toRoomName, ((_k = incomingTaskCountByRoom.get(task.toRoomName)) !== null && _k !== void 0 ? _k : 0) + 1);\n        }\n        if (task.origin === \"manual\" || countsTowardDemand) {\n            // 与旧 findMergeablePendingTask 语义一致：manual 无条件、automatic 需\n            // 健康；同 route 重复 key 时保留第一个匹配（Object.values 插入顺序），\n            // 不得用后写覆盖（那是\"最后一个匹配\"，会改变 merge 目标选择）。\n            const mergeKey = mergeKeyOf(task.resource, task.fromRoomName, task.toRoomName, task.origin, reason);\n            if (!mergeIndex.has(mergeKey)) {\n                mergeIndex.set(mergeKey, task.id);\n            }\n        }\n        if ((0, resourceTransferTaskHealth_1.isHealthyReceiverCapacityCommitment)(task, healthOptions.automaticTaskNoProgressTtl)) {\n            healthyIncomingByRoom.set(task.toRoomName, ((_l = healthyIncomingByRoom.get(task.toRoomName)) !== null && _l !== void 0 ? _l : 0) + task.remainingAmount);\n            healthyIncomingCountByRoom.set(task.toRoomName, ((_m = healthyIncomingCountByRoom.get(task.toRoomName)) !== null && _m !== void 0 ? _m : 0) + 1);\n        }",
    "        // Stable JSON record fields. Use the SAME canonical NUL scope keys;\n        // self-routes and key aliases must share the same bucket object.\n        const fromRoom = task.fromRoomName, toRoom = task.toRoomName;\n        const outKey = taskKey(fromRoom, task.resource);\n        const inKey = taskKey(toRoom, task.resource);\n        let outBucket = taskScopes.get(outKey), inBucket = taskScopes.get(inKey);\n        const mergedOutgoing = addSafeInteger(outBucket ? outBucket.outgoing : 0, task.remainingAmount);\n        const mergedPendingIncoming = addSafeInteger(inBucket ? inBucket.pendingIncoming : 0, task.remainingAmount);\n        if (mergedOutgoing === null || mergedPendingIncoming === null) {\n            recordInvalid();\n            incompleteScopes.add(outKey);\n            incompleteScopes.add(inKey);\n            continue;\n        }\n        let fromBucket = taskRooms.get(fromRoom);\n        if (!fromBucket) {\n            fromBucket = { outgoingCount: 0, incomingCount: 0, healthyAmount: 0, healthyCount: 0 };\n            taskRooms.set(fromRoom, fromBucket);\n        }\n        fromBucket.outgoingCount += 1;\n        if (!outBucket) {\n            outBucket = { outgoing: 0, pendingIncoming: 0, incoming: 0, reasons: undefined };\n            taskScopes.set(outKey, outBucket);\n        }\n        outBucket.outgoing = mergedOutgoing;\n        const byReason = outBucket.reasons !== undefined ? outBucket.reasons : new Map();\n        const mergedByReason = addSafeInteger((_h = byReason.get(reason)) !== null && _h !== void 0 ? _h : 0, task.remainingAmount);\n        // Keep the canonical partial-update order on overflow: outgoing and\n        // outgoingCount above remain updated; pendingIncoming is NOT updated.\n        if (mergedByReason === null) {\n            recordInvalid();\n            incompleteScopes.add(outKey);\n            continue;\n        }\n        byReason.set(reason, mergedByReason);\n        outBucket.reasons = byReason;\n        if (!inBucket) {\n            inBucket = inKey === outKey ? outBucket : { outgoing: 0, pendingIncoming: 0, incoming: 0, reasons: undefined };\n            if (inKey !== outKey) taskScopes.set(inKey, inBucket);\n        }\n        inBucket.pendingIncoming = mergedPendingIncoming;\n        const countsTowardDemand = (0, resourceTransferTaskHealth_1.countsResourceTransferTaskTowardDemand)(task, healthOptions);\n        let toBucket;\n        if (countsTowardDemand) {\n            const mergedIncoming = addSafeInteger(inBucket.incoming, task.remainingAmount);\n            if (mergedIncoming === null) {\n                recordInvalid();\n                incompleteScopes.add(inKey);\n                continue;\n            }\n            inBucket.incoming = mergedIncoming;\n            toBucket = taskRooms.get(toRoom);\n            if (!toBucket) {\n                toBucket = { outgoingCount: 0, incomingCount: 0, healthyAmount: 0, healthyCount: 0 };\n                taskRooms.set(toRoom, toBucket);\n            }\n            toBucket.incomingCount += 1;\n        }\n        if (task.origin === \"manual\" || countsTowardDemand) {\n            // Canonical first-route-wins order, including manual tasks that do\n            // not contribute healthy demand. Do not overwrite an earlier id.\n            const mergeKey = mergeKeyOf(task.resource, fromRoom, toRoom, task.origin, reason);\n            if (!mergeIndex.has(mergeKey)) {\n                mergeIndex.set(mergeKey, task.id);\n            }\n        }\n        if ((0, resourceTransferTaskHealth_1.isHealthyReceiverCapacityCommitment)(task, healthOptions.automaticTaskNoProgressTtl)) {\n            if (!toBucket) {\n                toBucket = taskRooms.get(toRoom);\n                if (!toBucket) {\n                    toBucket = { outgoingCount: 0, incomingCount: 0, healthyAmount: 0, healthyCount: 0 };\n                    taskRooms.set(toRoom, toBucket);\n                }\n            }\n            // Keep canonical arithmetic (including its overflow behavior).\n            toBucket.healthyAmount += task.remainingAmount;\n            toBucket.healthyCount += 1;\n        }"
  ],
  [
    "outgoing-query",
    "        outgoing(roomName, resource) {\n            var _a;\n            metrics.indexQueries += 1;\n            return (_a = outgoing.get(taskKey(roomName, resource))) !== null && _a !== void 0 ? _a : 0;\n        },",
    "        outgoing(roomName, resource) {\n            metrics.indexQueries += 1;\n            const bucket = taskScopes.get(taskKey(roomName, resource));\n            return bucket ? bucket.outgoing : 0;\n        },"
  ],
  [
    "reason-query",
    "            if (!reasonPrefix)\n                return (_a = outgoing.get(taskKey(roomName, resource))) !== null && _a !== void 0 ? _a : 0;\n            let total = 0;\n            for (const [reason, amount] of (_b = outgoingByReason.get(taskKey(roomName, resource))) !== null && _b !== void 0 ? _b : []) {",
    "            const bucket = taskScopes.get(taskKey(roomName, resource));\n            if (!reasonPrefix)\n                return bucket ? bucket.outgoing : 0;\n            let total = 0;\n            for (const [reason, amount] of bucket && bucket.reasons ? bucket.reasons : []) {"
  ],
  [
    "incoming-query",
    "        incoming(roomName, resource) {\n            var _a;\n            metrics.indexQueries += 1;\n            return (_a = incoming.get(taskKey(roomName, resource))) !== null && _a !== void 0 ? _a : 0;\n        },",
    "        incoming(roomName, resource) {\n            metrics.indexQueries += 1;\n            const bucket = taskScopes.get(taskKey(roomName, resource));\n            return bucket ? bucket.incoming : 0;\n        },"
  ],
  [
    "pendingIncoming-query",
    "        pendingIncoming(roomName, resource) {\n            var _a;\n            metrics.indexQueries += 1;\n            return (_a = pendingIncoming.get(taskKey(roomName, resource))) !== null && _a !== void 0 ? _a : 0;\n        },",
    "        pendingIncoming(roomName, resource) {\n            metrics.indexQueries += 1;\n            const bucket = taskScopes.get(taskKey(roomName, resource));\n            return bucket ? bucket.pendingIncoming : 0;\n        },"
  ],
  [
    "incomingTaskCount-query",
    "        incomingTaskCount(roomName) {\n            var _a;\n            metrics.indexQueries += 1;\n            return (_a = incomingTaskCountByRoom.get(roomName)) !== null && _a !== void 0 ? _a : 0;\n        },",
    "        incomingTaskCount(roomName) {\n            metrics.indexQueries += 1;\n            const bucket = taskRooms.get(roomName);\n            return bucket ? bucket.incomingCount : 0;\n        },"
  ],
  [
    "outgoingTaskCount-query",
    "        outgoingTaskCount(roomName) {\n            var _a;\n            metrics.indexQueries += 1;\n            return (_a = outgoingTaskCountByRoom.get(roomName)) !== null && _a !== void 0 ? _a : 0;\n        },",
    "        outgoingTaskCount(roomName) {\n            metrics.indexQueries += 1;\n            const bucket = taskRooms.get(roomName);\n            return bucket ? bucket.outgoingCount : 0;\n        },"
  ],
  [
    "receiver-query",
    "            const healthyIncomingAmount = (_a = healthyIncomingByRoom.get(roomName)) !== null && _a !== void 0 ? _a : 0;\n            const healthyIncomingTaskCount = (_b = healthyIncomingCountByRoom.get(roomName)) !== null && _b !== void 0 ? _b : 0;",
    "            const roomBucket = taskRooms.get(roomName);\n            const healthyIncomingAmount = roomBucket ? roomBucket.healthyAmount : 0;\n            const healthyIncomingTaskCount = roomBucket ? roomBucket.healthyCount : 0;"
  ],
  [
    "observation-room-wrapper",
    "        rooms.push(deepFreezeRoom({\n            roomName: room.name,\n            storage: freezeLocation(room.name, \"storage\", storageScan),\n            terminal: freezeLocation(room.name, \"terminal\", terminalScan),\n        }));",
    "        // VII: freeze the one final room object, not a temporary clone.\n        rooms.push(Object.freeze({\n            roomName: room.name,\n            storage: freezeLocation(room.name, \"storage\", storageScan),\n            terminal: freezeLocation(room.name, \"terminal\", terminalScan),\n        }));"
  ],
  [
    "observation-no-entry-pairs",
    "            for (const [resource, amount] of Object.entries(scan.amounts)) {\n                empireTotals[resource] = ((_e = empireTotals[resource]) !== null && _e !== void 0 ? _e : 0) + amount;\n            }",
    "            // VII: amounts is an owned, frozen primitive snapshot here.\n            // Preserve Object.keys order and additions; avoid [key,value] pairs.\n            for (const resource of Object.keys(scan.amounts)) {\n                const amount = scan.amounts[resource];\n                empireTotals[resource] = ((_e = empireTotals[resource]) !== null && _e !== void 0 ? _e : 0) + amount;\n            }"
  ]
];
function check(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function substitute(text, before, after, name) {
  check(text.split(before).length === 2, 'BUILD_TRANSFORM_COUNT:' + name);
  return text.replace(before, () => after);
}
function transform(text) {
  let result = text;
  for (const [name, before, after] of RULES) result = substitute(result, before, after, name);
  check(restore(result) === text, 'BUILD_TRANSFORM_NOT_REVERSIBLE');
  return result;
}
function restore(text) {
  for (const [name, before, after] of [...RULES].reverse()) text = substitute(text, after, before, name);
  return text;
}
module.exports = { transform, restore, rules: RULES.map(([name]) => ({ name, replacements: 1 })) };

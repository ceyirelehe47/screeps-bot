#!/usr/bin/env python3
"""只投影 T2 业务证据；不复制完整生产 Memory，也不访问生产 API。"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def select(value, names):
    return {name: value[name] for name in names if name in value}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="只读现场快照 JSON")
    parser.add_argument("memory", help="私有生产 Memory JSON；不会复制到输出")
    parser.add_argument("output", help="脱敏业务投影 JSON")
    args = parser.parse_args()
    snapshot = json.loads(Path(args.snapshot).read_text())
    memory = json.loads(Path(args.memory).read_text())
    runtime = memory["runtime"]
    resource = runtime["resourceControl"]
    task_id = "74073650:1:UH:E4N58->E1N57"
    tasks = snapshot["canonicalTasks"]["records"]
    result = {
        "schema": "treasury-t2-business-preflight/v1",
        "inputSha256": {"snapshot": digest(args.snapshot), "memory": digest(args.memory)},
        "capturedAtUtc": snapshot["capturedAtUtc"],
        "completedAtUtc": snapshot["completedAtUtc"],
        "shard": snapshot["shard"],
        "memoryTick": snapshot["memory"]["latestTick"],
        "runtimeUpdatedAt": resource["updatedAt"],
        "lastDeploy": select(runtime, ["lastDeployTag", "lastDeployCommit", "lastDeployBundleHash"]),
        "canonicalTaskStoreComplete": snapshot["canonicalTasks"]["complete"],
        "task": tasks.get(task_id),
        "relatedPendingTasks": [
            task for task in tasks.values()
            if task["status"] == "pending"
            and (task["fromRoomName"] == "E4N58" or task["toRoomName"] == "E1N57")
        ],
        "resourceConfig": select(memory["cfg"]["resourceControl"], ["enabled", "taskMaxPerRun", "sampleInterval", "capacityBalancing"]),
        "capacityPolicy": resource["capacityPolicy"],
        "lastActions": resource["lastActions"],
        "rooms": {},
        "productionReservations": [
            entry for entry in runtime.get("resourceReservations", {}).values()
            if entry.get("roomName") in ("E4N58", "E1N57")
        ],
        "market": {},
        "limitations": [
            "各 API 快照并非同一 tick；runtimeUpdatedAt 包含非规划 tick 的 readiness 刷新，不足以确定 lastActions 发生 tick。",
            "房间 API 的 terminal 原始对象没有 cooldown；真实 Game 的 cooldown/isActive 尚待补读。",
            "carrier board、creep assignment state 与 arbiter 当前 tick claims 位于 heap，完整 Memory 不能证明它们不存在。",
            "没有交易窗口，不能证明全部历史 4095 tick 都由同一原因阻塞。",
        ],
    }
    room_fields = ["state", "capacityState", "storageUsedCapacity", "storageFreeCapacity", "terminalUsedCapacity", "terminalFreeCapacity", "capacityReservation", "staging", "storageEnergy", "terminalEnergy", "energyFloor", "energyTarget", "energyExportStart", "terminalEnergyReserve", "taskHealth"]
    for room_name in ("E4N58", "E1N57", "E3N59"):
        objects = snapshot["rooms"][room_name]["objects"]
        entry = {"resourceControl": select(resource["rooms"][room_name], room_fields)}
        if room_name in ("E4N58", "E1N57"):
            entry["synthesisConfig"] = memory["cfg"]["synthesisControl"]["rooms"][room_name]
            entry["synthesisRuntime"] = select(runtime["synthesisControl"]["rooms"][room_name], ["stage", "activeProduct", "reagentA", "reagentB", "reagentLabIds", "productLabIds", "targetAmount", "batchSize", "missing", "loadingSinceTick", "pendingTasks"])
        entry["structures"] = [
            {"id": obj["_id"], "type": obj["type"], "storeCapacity": obj.get("storeCapacity"), "usedCapacity": sum(obj.get("store", {}).values()), "store": select(obj.get("store", {}), ["energy", "UH", "OH", "UH2O"])}
            for obj in objects if obj["type"] in ("storage", "terminal", "lab", "factory")
        ]
        entry["carriers"] = [
            {"name": obj["name"], "store": {key: value for key, value in obj.get("store", {}).items() if value}, "role": memory["creeps"].get(obj["name"], {}).get("role"), "configName": memory["creeps"].get(obj["name"], {}).get("configName")}
            for obj in objects if obj["type"] == "creep" and "carrier" in obj["name"].lower()
        ]
        result["rooms"][room_name] = entry
    market_data = memory["data"]["marketSaleAutomation"]
    market_runtime = runtime["marketSaleAutomation"]
    result["market"] = {
        "dataCollectionCounts": {name: len(market_data.get(name, {})) for name in ("managedOrders", "pendingMutations", "pendingDirectDeals", "marketStaging", "marketReservations")},
        "persistentDirectAccountClaim": market_data.get("directMarketClaim"),
        "runtime": select(market_runtime, ["updatedAt", "terminalClaims", "managedOrderCount", "pendingCreateCount", "pendingMutationCount", "exposureAmount", "stagingAmount", "reservationAmount"]),
        "terminalEnergyReserve": memory["cfg"]["marketSaleAutomation"]["terminalEnergyReserve"],
        "sellResources": memory["cfg"]["marketSaleAutomation"]["sellResources"],
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"已写入 T2 业务投影：{args.output}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""只读文件复核四 shard 终态与现役链连续性，输出小型证据投影。"""
import argparse
import hashlib
import json
from pathlib import Path


def select(value, names):
    return {key: value[key] for key in names if key in value}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def treasury_paths(value, path=""):
    result = []
    if isinstance(value, dict):
        for key, child in value.items():
            next_path = f"{path}.{key}" if path else key
            if "treasury" in key.lower():
                result.append(next_path)
            result.extend(treasury_paths(child, next_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            result.extend(treasury_paths(child, f"{path}[{index}]"))
    return result


def room_analytics(memory):
    rooms = memory.get("analytics", {}).get("production", {}).get("rooms", {})
    return {room: select(rooms.get(room, {}).get("latest", {}), ["tick", "workerCount", "carrierCount", "harvesterCount", "spawnSpawning", "controllerLevel", "controllerProgress"]) for room in ("E4N58", "E1N57")}


def market_summary(memory):
    market = memory["data"]["marketSaleAutomation"]
    direct = market["directAutomation"]
    v3 = direct["baseResourceV3"]
    chain = v3["permitChain"]
    ledger = v3["ledger"]
    anchor = market["baseResourceV3ActivationAnchor"]
    return {
        "permit": select(chain, ["currentPermitEpoch", "currentPermitId", "permitChainHead", "permitEpochHighWater", "permitChainHeadHighWater", "totalChainLength"]),
        "receipt": select(ledger, ["receiptHeadHash", "finalizedAttemptSeq", "nextAttemptSeq", "coverageStartTick", "lifetimeConfirmed"]),
        "permitRetainedDigest": digest(chain.get("retainedPermits")),
        "receiptRetainedDigest": digest(ledger.get("receipts")),
        "anchor": select(anchor, ["updatedAt", "anchorHash", "hardBlocker", "activationBlocker", "roomRegistryCheckpointCommitment", "laneLifecycleCommitment", "pricingRatchetCommitment", "trustedFloorsCommitment"]),
        "anchorMirrorEqual": anchor == market.get("baseResourceV3ActivationAnchorMirror"),
        "roomIncarnationHighWater": anchor.get("roomIncarnationHighWater"),
        "laneLifecycleHighWaterDigest": digest(anchor.get("laneLifecycleHighWater")),
        "pricingRatchetHighWater": anchor.get("pricingRatchetHighWater"),
        "trustedFloorHighWater": anchor.get("trustedFloorHighWater"),
        "persistentDirectAccountClaim": market.get("directMarketClaim"),
        "pendingCounts": {key: len(market.get(key, {})) for key in ("managedOrders", "pendingMutations", "pendingDirectDeals", "marketStaging", "marketReservations")},
        "directPendingCount": len(direct.get("pendingDirectDeals", {})),
        "v3PendingPresent": bool(v3.get("pendingAttempt")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("initial_memory")
    parser.add_argument("initial_snapshot")
    parser.add_argument("ending_snapshot")
    parser.add_argument("ending_private_directory")
    parser.add_argument("output")
    args = parser.parse_args()
    initial = json.loads(Path(args.initial_memory).read_text())
    first_snapshot = json.loads(Path(args.initial_snapshot).read_text())
    ending = json.loads(Path(args.ending_snapshot).read_text())
    private_dir = Path(args.ending_private_directory)
    full_shards = {shard: json.loads((private_dir / f"{shard}-memory.json").read_text()) for shard in ("shard0", "shard1", "shard2", "shard3")}
    current = full_shards["shard1"]
    market_before = market_summary(initial)
    market_after = market_summary(current)
    before_floors = {item["resource"]: item for item in market_before["trustedFloorHighWater"]}
    after_floors = {item["resource"]: item for item in market_after["trustedFloorHighWater"]}
    floor_nonregression = all(resource in after_floors and after_floors[resource]["value"] >= value["value"] and after_floors[resource].get("updatedAt", 0) >= value.get("updatedAt", 0) for resource, value in before_floors.items())
    task_id = "74073650:1:UH:E4N58->E1N57"
    all_paths = {shard: [path for branch in ("cfg", "runtime", "data") for path in treasury_paths(memory.get(branch, {}), branch)] for shard, memory in full_shards.items()}
    assert all(not paths for paths in all_paths.values()), all_paths
    code_before = first_snapshot["code"]["modules"]["main"]
    code_after = ending["code"]["modules"]["main"]
    assert code_before["sha256"] == code_after["sha256"]
    assert market_before["permit"] == market_after["permit"]
    assert market_before["receipt"] == market_after["receipt"]
    assert market_before["permitRetainedDigest"] == market_after["permitRetainedDigest"]
    assert market_before["receiptRetainedDigest"] == market_after["receiptRetainedDigest"]
    assert market_before["anchorMirrorEqual"] and market_after["anchorMirrorEqual"]
    assert floor_nonregression
    before_hub = initial["runtime"]["hub"]
    after_hub = current["runtime"]["hub"]
    assert after_hub["protectionAttemptHighWater"] >= before_hub["protectionAttemptHighWater"]
    assert after_hub["protectionConfigIncarnationHighWater"] >= before_hub["protectionConfigIncarnationHighWater"]
    result = {
        "schema": "treasury-t2-ending-readonly-projection/v1",
        "capturedAtUtc": ending["capturedAtUtc"],
        "completedAtUtc": ending["completedAtUtc"],
        "observation": {"startedAtUtc": "2026-10-02T10:03:32Z", "startedAtTick": 74077720, "endedAtTick": ending["shards"]["shard1"]["latestTick"], "newTicks": ending["shards"]["shard1"]["latestTick"] - 74077720, "closed": True, "furtherProductionPolling": False},
        "main": code_after,
        "liveDeployTag": current["runtime"]["lastDeployTag"],
        "currentDeployBundleHash": current["runtime"]["lastDeployBundleHash"],
        "sameRemoteMainAsInitial": True,
        "shards": {shard: {"memorySha256": ending["shards"][shard]["sha256"], "memoryBytes": ending["shards"][shard]["utf8Bytes"], "latestTick": ending["shards"][shard]["latestTick"], "lastDeployTag": memory.get("runtime", {}).get("lastDeployTag"), "treasuryKeyPathsInCfgRuntimeData": all_paths[shard], "treasuryInstrumentationKeyPaths": treasury_paths(memory.get("analytics", {}), "analytics"), "treasuryPersistedResponsibilityPresent": False} for shard, memory in full_shards.items()},
        "originalTask": current["data"]["resourceControl"]["tasks"][task_id],
        "endingBusinessDemand": {
            "synthesisConfig": current["cfg"]["synthesisControl"]["rooms"]["E1N57"],
            "synthesisRuntime": select(current["runtime"]["synthesisControl"]["rooms"]["E1N57"], ["stage", "activeProduct", "targetAmount", "batchSize", "reagentA", "reagentB", "missing", "pendingTasks"]),
            "ownedStructureResourceTotals": {room: {resource: sum(obj.get("store", {}).get(resource, 0) for obj in ending["rooms"][room]["objects"] if obj["type"] in ("storage", "terminal", "factory", "lab", "powerSpawn")) for resource in ("UH", "OH", "UH2O")} for room in ("E4N58", "E1N57")},
        },
        "businessResult": "no_actual_UH_need_not_deployed_not_armed",
        "productionActionBoundary": {"candidateCodeUploaded": False, "treasuryArmCalled": False, "treasuryNativeCalled": False, "ordinaryProductionActionsContinued": True, "basis": "代码独立GET原件不变、四shard完整Memory无Treasury责任、原任务未扣减；普通交易与analytics推进另有正向证据。"},
        "marketContinuity": {"before": market_before, "after": market_after, "permitAndReceiptChainContinuous": True, "trustedFloorHighWaterNonRegression": floor_nonregression, "note": "anchorHash/trustedFloorsCommitment随普通行情刷新变化；不机械要求整个市场对象完全相同。"},
        "ordinaryProgress": {
            "hubBefore": select(before_hub, ["updatedAt", "status", "protectionConfigIncarnationHighWater", "protectionAttemptHighWater"]),
            "hubAfter": select(after_hub, ["updatedAt", "status", "protectionConfigIncarnationHighWater", "protectionAttemptHighWater"]),
            "roomAnalyticsBefore": room_analytics(initial),
            "roomAnalyticsAfter": room_analytics(current),
            "resourceControlLastActions": current["runtime"]["resourceControl"]["lastActions"],
            "synthesisSuccessfulRunsBefore": initial["runtime"]["synthesisControl"].get("successfulRunCount"),
            "synthesisSuccessfulRunsAfter": current["runtime"]["synthesisControl"].get("successfulRunCount"),
        },
        "inputSha256": {"initialMemory": hashlib.sha256(Path(args.initial_memory).read_bytes()).hexdigest(), "endingSnapshot": hashlib.sha256(Path(args.ending_snapshot).read_bytes()).hexdigest()},
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"endedAtTick": result["observation"]["endedAtTick"], "newTicks": result["observation"]["newTicks"], "sameRemoteMain": True, "fourShardsTreasuryKeyCount": 0, "marketChainContinuous": True, "hubProtectionAttempt": [before_hub["protectionAttemptHighWater"], after_hub["protectionAttemptHighWater"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""用本轮 Game 原件复算当前 UH2O 目标的实际 UH 补料缺口。零网络、零生产写入。"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preflight_projection")
    parser.add_argument("game_result")
    parser.add_argument("output")
    parser.add_argument("--expect-uh-missing", type=int)
    args = parser.parse_args()
    preflight = json.loads(Path(args.preflight_projection).read_text())
    raw = json.loads(Path(args.game_result).read_text())
    game = raw["result"]
    assert raw["status"] == "returned", raw["status"]
    assert game["shard"] == "shard1", game["shard"]
    config = preflight["rooms"]["E1N57"]["synthesisConfig"]
    reaction = next(plan for plan in config["reactions"] if plan["product"] == "UH2O")
    labs = game["labs"]
    product_amount = sum(lab["store"].get("UH2O", 0) for lab in labs)
    # 两次现场 Terminal 均无产物；preflight Storage/Factory 中该产物为零。
    terminal = next(room for room in game["rooms"] if room["room"] == "E1N57")
    assert terminal["store"].get("UH2O", 0) == 0
    other_structures = [obj for obj in preflight["rooms"]["E1N57"]["structures"] if obj["type"] in ("storage", "factory")]
    assert sum(obj["store"].get("UH2O", 0) for obj in other_structures) == 0
    product_deficit = max(0, reaction["targetAmount"] - product_amount)
    rounded_deficit = ((product_deficit + 4) // 5) * 5
    desired_reagent = min(3000, reaction["batchSize"], rounded_deficit)
    uh_local = sum(lab["store"].get("UH", 0) for lab in labs)
    oh_local = sum(lab["store"].get("OH", 0) for lab in labs)
    uh_missing = max(0, desired_reagent - uh_local)
    # accepted cargo 尚未纳入；它只能减少该缺口，不会把已经为0的缺口变正。
    transactions = {tx["transactionId"]: tx for tx in game["incoming"] + game["outgoing"]}
    automatic_energy = sorted(
        (tx for tx in transactions.values() if tx["from"] == "E4N58" and tx["to"] == "E3N59" and tx["description"] == "resourceControl:auto-balance"),
        key=lambda tx: tx["time"],
    )
    relief_energy = sorted(
        (tx for tx in transactions.values() if tx["from"] == "E3N59" and tx["to"] == "E4N58" and tx["description"].startswith("resourceControl:task:")),
        key=lambda tx: tx["time"],
    )
    result = {
        "schema": "treasury-t2-current-demand-verification/v1",
        "inputSha256": {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in (("preflight", args.preflight_projection), ("game", args.game_result))},
        "tick": game["tick"],
        "shard": game["shard"],
        "currentProduct": "UH2O",
        "configuredTargetAmount": reaction["targetAmount"],
        "configuredBatchSize": reaction["batchSize"],
        "productInLabs": product_amount,
        "productDeficit": product_deficit,
        "desiredReagentAmount": desired_reagent,
        "reagentUHInLabs": uh_local,
        "reagentOHInLabs": oh_local,
        "actualUHMissingBeforeOtherCoverage": uh_missing,
        "actualOHMissingBeforeOtherCoverage": max(0, desired_reagent - oh_local),
        "businessGate": "blocked_no_actual_UH_need" if uh_missing == 0 else "requires_same_tick_task_and_other_coverage_recheck",
        "sourceTerminal": {name: next(room for room in game["rooms"] if room["room"] == "E4N58")[name] for name in ("id", "owner", "active", "cooldown", "free")},
        "targetTerminal": {name: terminal[name] for name in ("id", "owner", "active", "cooldown", "free")},
        "recentAutomaticEnergySourceWindow": {
            "transactionCount": len(automatic_energy),
            "amount": sum(tx["amount"] for tx in automatic_energy),
            "firstTick": automatic_energy[0]["time"],
            "lastTick": automatic_energy[-1]["time"],
            "tickIntervals": sorted({right["time"] - left["time"] for left, right in zip(automatic_energy, automatic_energy[1:])}),
            "transactions": automatic_energy,
        },
        "recentOpposingEnergyRelief": {
            "transactionCount": len(relief_energy),
            "amount": sum(tx["amount"] for tx in relief_energy),
            "transactions": relief_energy,
        },
        "recentUHTransactionCount": sum(tx["resourceType"] == "UH" for tx in transactions.values()),
        "limits": [
            "Game labs和terminal为tick74077911同tick实物；配置及Storage/Factory零库存取自本轮较早preflight。",
            "未读取有效accepted cargo；额外覆盖只会降低UH补料缺口，本次UH缺口已经为0。",
            "近40条交易去重后的观测窗口只覆盖74077770至74077910，不能追溯原任务全部历史。",
        ],
    }
    if args.expect_uh_missing is not None:
        assert uh_missing == args.expect_uh_missing, (uh_missing, args.expect_uh_missing)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"tick": game["tick"], "productDeficit": product_deficit, "UHLocal": uh_local, "UHMissing": uh_missing, "businessGate": result["businessGate"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

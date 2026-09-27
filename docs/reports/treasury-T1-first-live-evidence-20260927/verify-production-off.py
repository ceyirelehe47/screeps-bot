#!/usr/bin/env python3
"""Check frozen release and bounded post-deploy OFF evidence."""
import json
from pathlib import Path

base = Path(__file__).resolve().parent
manifest = json.loads((base / "release-manifest.json").read_text())
before = json.loads((base / "production-before.json").read_text())
after = json.loads((base / "production-after.json").read_text())
engine = json.loads((base / "engine" / "verification.json").read_text())
raw_monitor = (base / "post-deploy-stable-monitor.txt").read_text()
monitor = json.loads(raw_monitor[raw_monitor.index("\n{") + 1:])["memory"]

assert before["account"] == after["account"] == {
    "id": manifest["accountId"], "username": manifest["accountName"]}
assert before["target"] == after["target"] == manifest["target"]
assert before["code"]["mainSha256"] == manifest["expectedLiveSha256"]
assert after["code"]["mainSha256"] == manifest["mainSha256"]
assert after["code"]["mainBytes"] == manifest["mainBytes"] < 5_000_000
assert before["code"]["modules"] == after["code"]["modules"] == ["main"]
assert before["memory"]["deployTag"] == manifest["expectedLiveDeployTag"]
assert after["memory"]["deployTag"] == manifest["buildTag"]
assert after["gameTick"] > before["gameTick"]
assert before["memory"]["marketV3"] == after["memory"]["marketV3"]
assert before["memory"]["marketV3"]["configRevision"] == "market-base-resource-v3-r7"
assert before["memory"]["marketV3"]["permitEpoch"] == 17
assert before["memory"]["marketV3"]["ledgerPending"] is None
for view in (before, after):
    memory = view["memory"]
    assert memory["t1Mode"] == "off(default)"
    assert memory["t1ControlPresent"] is False
    assert memory["t1Quota"] is None
    assert memory["t1Kernel"]["present"] is False
    assert memory["t1TaskLeaseCount"] == 0
    assert memory["matchingTasks"] == []
assert after["memory"]["bytes"] < 1_900_000
assert after["memory"]["cpuLatest"]["tickLimit"] == 500
assert after["memory"]["cpuLatest"]["bucket"] >= 2_000
assert all(room["objects"] for room in after["rooms"])
assert next(o for o in after["rooms"][0]["objects"] if o["type"] == "terminal")["H"] == 0
assert engine["status"] == "passed" and engine["codeSha256"] == manifest["mainSha256"]
direct = monitor["marketSaleAutomation"]["direct"]["baseResourceV3"]
assert monitor["selectedShard"] == "shard1"
assert direct["planning"]["complete"] is True and direct["blocker"] is None
assert monitor["resourceControl"]["available"] is True
assert monitor["cpuMonitor"]["latest"]["bucket"] >= 2_000

result = {
    "schema": "screeps-t1-first-live-production-off-verification/v1",
    "status": "passed",
    "sourceCommit": manifest["sourceCommit"],
    "deployedSha256": manifest["mainSha256"],
    "deployedBytes": manifest["mainBytes"],
    "buildTag": manifest["buildTag"],
    "offDeployedAndRunning": True,
    "marketIdentityPreserved": True,
    "matchingTaskAtReadback": False,
    "treasuryQuotaOrWorkCreated": False,
    "writerNativeAttempted": False,
    "writerReason": "no_existing_E3N59_to_E4N58_H_task_and_source_terminal_H_zero",
    "notes": "The OFF state and absence of quota/work are read back; no production transaction-feed assertion is made.",
}
(base / "production-off-verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))

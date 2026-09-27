#!/usr/bin/env python3
"""Verify only this final-bundle isolated-engine run; never edits evidence."""
import json
from pathlib import Path

base = Path(__file__).resolve().parent
evidence = base / "evidence"
manifest = json.loads((base.parent / "release-manifest.json").read_text())

def snapshot(name):
    x = json.loads((evidence / f"{name}.json").read_text())
    assert x["schema"] == "screeps-t1-first-live-engine-snapshot/v1"
    assert x["paused"] is True
    assert x["code"]["sha256"] == manifest["mainSha256"]
    assert x["code"]["bytes"] == manifest["mainBytes"]
    assert x["user"]["_id"] == "7dad41a4bfc9d96"
    return x, json.loads(x["rawMemory"])

def task(memory, task_id):
    return memory["data"]["resourceControl"]["tasks"].get(task_id)

def terminal(x, room):
    return next(o for o in x["objects"] if o.get("type") == "terminal" and o.get("room") == room)

pre, _ = snapshot("pre-arm")
sent, sent_m = snapshot("after-send-and-settle")
off, off_m = snapshot("off-closed")
restart, restart_m = snapshot("restart-off")
assert len(pre["transactions"]) == 7
assert len(sent["transactions"]) == len(off["transactions"]) == len(restart["transactions"]) == 8
new_tx = [t for t in sent["transactions"] if t["_id"] not in {p["_id"] for p in pre["transactions"]}]
assert len(new_tx) == 1
assert (new_tx[0]["time"], new_tx[0]["from"], new_tx[0]["to"],
        new_tx[0]["resourceType"], new_tx[0]["amount"]) == (540, "E3N59", "E4N58", "H", 100)
assert new_tx[0]["description"].startswith("treasury-T1-2026-09-24:")
assert terminal(pre, "E3N59")["store"]["H"] - terminal(sent, "E3N59")["store"]["H"] == 100
assert terminal(pre, "E3N59")["store"]["energy"] - terminal(sent, "E3N59")["store"]["energy"] == 4
assert terminal(sent, "E4N58")["store"]["H"] - terminal(pre, "E4N58")["store"]["H"] == 100
assert task(sent_m, "lab-r4b-100H")["remainingAmount"] == 0
assert task(sent_m, "lab-r4b-100H")["status"] == "done"
assert task(sent_m, "lab-r4b-100H")["treasurySlice"]["phase"] == "closing"
assert sent_m["runtime"]["treasuryT1FirstLiveControl"]["status"] == "closed"
assert sent_m["runtime"]["treasuryProductionT1Quota"]["status"] == "dispatching"
assert off_m["runtime"]["treasuryProductionT1Quota"]["status"] == "drained"
assert restart_m["runtime"]["treasuryProductionT1Quota"]["status"] == "drained"
for m in (off_m, restart_m):
    assert m["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off"
    assert task(m, "lab-r4b-100H").get("treasurySlice") is None
    assert len(m["runtime"]["treasuryCore"]["active"]) == 0
assert terminal(off, "E4N58")["store"]["energy"] - terminal(sent, "E4N58")["store"]["energy"] == 50
carrier_sent = next(o for o in sent["objects"] if o.get("name") == "lab-r2-carrier")
assert carrier_sent["store"]["energy"] == 50

pre_source, pre_source_m = snapshot("pre-source-blocked")
pre_target, pre_target_m = snapshot("pre-target-blocked")
for x, m, destination, ordinary, t1, tx_count in [
    (pre_source, pre_source_m, "E3N59", "lab-r4-pre-source-ordinary-0", "lab-r4-pre-source-H", 9),
    (pre_target, pre_target_m, "E4N58", "lab-r4-pre-target-ready-ordinary-0", "lab-r4-pre-target-ready-H", 11),
]:
    assert len(x["transactions"]) == tx_count
    latest = x["transactions"][-1]
    assert (latest["from"], latest["to"], latest["resourceType"], latest["amount"]) == (
        "W9N8", destination, "H", 100)
    assert latest["description"] == f"resourceControl:task:{ordinary}"
    assert task(m, ordinary)["status"] == "done"
    assert task(m, t1)["remainingAmount"] == 100
    assert m["runtime"].get("treasuryProductionT1Quota") is None
    assert m["runtime"]["treasuryT1FirstLiveControl"]["status"] == "active"

blocked, blocked_m = snapshot("post-both-blocked")
resumed, resumed_m = snapshot("post-off-resumed")
assert len(blocked["transactions"]) == 13
assert blocked["transactions"][-1]["description"].startswith("treasury-T1-2026-09-24:")
assert blocked["transactions"][-1]["time"] == 605
assert blocked_m["runtime"]["treasuryProductionT1Quota"]["status"] == "dispatching"
for ordinary in ("lab-r4-post-both-ordinary-1", "lab-r4-post-both-ordinary-source-late"):
    row = task(blocked_m, ordinary)
    assert row["status"] == "pending" and row["remainingAmount"] == 100
    assert row["lastError"] == "send_code_-4"
assert len(resumed["transactions"]) == 15
assert [(t["time"], t["from"], t["to"]) for t in resumed["transactions"][-2:]] == [
    (615, "W9N8", "E4N58"), (625, "W9N8", "E3N59")]
assert resumed_m["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off"
assert resumed_m["runtime"]["treasuryProductionT1Quota"]["status"] == "drained"
assert len(resumed_m["runtime"]["treasuryCore"]["active"]) == 0
assert task(resumed_m, "lab-r4-post-both-H")["remainingAmount"] == 0
assert task(resumed_m, "lab-r4-post-both-H").get("treasurySlice") is None
for ordinary in ("lab-r4-post-both-ordinary-1", "lab-r4-post-both-ordinary-source-late"):
    assert task(resumed_m, ordinary)["status"] == "done"

result = {"schema": "screeps-t1-first-live-engine-verification/v1", "status": "passed",
          "sourceCommit": manifest["sourceCommit"], "codeSha256": manifest["mainSha256"],
          "mainBytes": manifest["mainBytes"], "firstNativeTick": 540, "firstNativeH": 100,
          "firstNativeFeeEnergy": 4, "noResendAfterRestart": True,
          "thirdRoomPreSourceAndTargetBlockedT1": True,
          "thirdRoomPostSourceAndTargetHeldThenResumed": True}
(base / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))

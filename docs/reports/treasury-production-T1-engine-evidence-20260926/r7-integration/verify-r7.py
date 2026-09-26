#!/usr/bin/env python3
"""复核最终 r7+T1 合并包在独立 Screeps Engine 的原始快照。"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text())
CODE_SHA = MANIFEST["fileSha256"]
TASK_ID = "lab-r3-100H"


def snapshot(name):
    value = json.loads((ROOT / f"{name}.json").read_text())
    memory = json.loads(value["rawMemory"])
    assert value["schema"] == "screeps-treasury-t1-engine-snapshot/v1"
    assert value["paused"] is True
    assert value["user"]["username"] == "lab_treasury_t1"
    assert value["code"]["branch"] == "default"
    if name != "pre-r7-integration":
        assert value["code"]["sha256"] == CODE_SHA
        assert value["code"]["bytes"] == MANIFEST["bytes"]
    return value, memory


pre, pre_mem = snapshot("pre-r7-integration")
armed, armed_mem = snapshot("r7-pre-canary")
sent, sent_mem = snapshot("r7-after-window")
drained, drained_mem = snapshot("r7-drained")
off, off_mem = snapshot("r7-off")
restarted, restarted_mem = snapshot("r7-restart-off")

assert MANIFEST["sourceCommit"] == "c926ddeb01710c685a5546c4a19d1eaaf14a02d0"
assert MANIFEST["bytes"] <= 5 * 1024 * 1024
assert pre["code"]["sha256"] == "bd78c0719da582dbf090a9dd5f46be3c1618f17e6940eb872e6e3a98b6dfa592"
assert [len(x["transactions"]) for x in (pre, armed, sent, drained, off, restarted)] == [6, 6, 7, 7, 7, 7]

new_tx = sent["transactions"][-1]
assert new_tx["time"] == 520
assert new_tx["resourceType"] == "H" and new_tx["amount"] == 100
assert new_tx["from"] == "E3N59" and new_tx["to"] == "E4N58"

def task(memory):
    return memory["data"]["resourceControl"]["tasks"][TASK_ID]


assert armed_mem["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "canary"
assert task(armed_mem)["status"] == "pending" and task(armed_mem)["remainingAmount"] == 100
completed = task(sent_mem)
lease = completed["treasurySlice"]
assert completed["status"] == "done" and completed["remainingAmount"] == 0
assert lease["phase"] == "closing" and lease["amount"] == 0
assert lease["outcome"] == "committed"
assert new_tx["description"].endswith(lease["attemptId"])
quota = sent_mem["runtime"]["treasuryProductionT1Quota"]
assert quota["schemaVersion"] == 2 and quota["taskId"] == TASK_ID
assert quota["taskCreatedAt"] == completed["createdAt"]
assert quota["taskAmount"] == 100 and quota["amount"] == 100
assert quota["attemptId"] == lease["attemptId"]
assert drained_mem["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "drain"
assert task(drained_mem)["treasurySlice"] == lease
assert off_mem["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off"
assert "treasurySlice" not in task(off_mem)
assert off_mem["runtime"]["treasuryProductionT1Quota"]["status"] == "drained"
assert restarted_mem["runtime"]["treasuryProductionT1Quota"]["status"] == "drained"
assert "treasurySlice" not in task(restarted_mem)


def obj(snap, room, kind):
    return next(x for x in snap["objects"] if x["room"] == room and x["type"] == kind)


source_before = obj(armed, "E3N59", "terminal")
source_after = obj(sent, "E3N59", "terminal")
target_before = obj(armed, "E4N58", "terminal")
target_after = obj(sent, "E4N58", "terminal")
assert source_before["store"]["H"] - source_after["store"]["H"] == 100
assert target_after["store"]["H"] - target_before["store"]["H"] == 100
assert source_before["store"]["energy"] - source_after["store"]["energy"] == 4
assert target_after["store"]["energy"] == target_before["store"]["energy"]
creep_sent = next(x for x in sent["objects"] if x.get("name") == "lab-r2-carrier")
creep_drained = next(x for x in drained["objects"] if x.get("name") == "lab-r2-carrier")
creep_off = next(x for x in off["objects"] if x.get("name") == "lab-r2-carrier")
assert creep_sent["store"]["energy"] == creep_drained["store"]["energy"] == 50
assert creep_off["store"]["energy"] == 0
assert obj(off, "E4N58", "terminal")["store"]["energy"] - target_after["store"]["energy"] == 50

result = {
    "schema": "screeps-treasury-t1-r7-integration-verification/v1",
    "status": "passed",
    "sourceCommit": MANIFEST["sourceCommit"],
    "codeSha256": CODE_SHA,
    "engineVersion": "4.3.0",
    "sendTick": new_tx["time"],
    "sendAmountH": new_tx["amount"],
    "feeEnergy": 4,
    "carrierEnergyHeldUntilOff": 50,
    "transactionsAfterRestart": len(restarted["transactions"]),
}
(ROOT / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))

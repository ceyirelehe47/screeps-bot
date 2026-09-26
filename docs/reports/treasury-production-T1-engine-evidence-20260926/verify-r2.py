#!/usr/bin/env python3
"""校验隔离引擎 R2 原始快照中的 100 H 收尾与 carrier 并发。"""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OLD = json.loads((ROOT / "manifest-closure-v1.json").read_text())
FINAL = json.loads((ROOT / "manifest.json").read_text())


def load(name):
    snapshot = json.loads((ROOT / f"{name}.json").read_text())
    assert snapshot["paused"] is True, name
    return snapshot, json.loads(snapshot["rawMemory"])


def task(memory, task_id):
    return memory["data"]["resourceControl"]["tasks"][task_id]


def quota(memory):
    return memory["runtime"].get("treasuryProductionT1Quota")


def terminal(snapshot, room):
    matches = [x for x in snapshot["objects"] if x.get("type") == "terminal" and x.get("room") == room]
    assert len(matches) == 1
    return matches[0]


def carrier(snapshot):
    matches = [x for x in snapshot["objects"] if x.get("type") == "creep" and x.get("name") == "lab-r2-carrier"]
    assert len(matches) == 1
    return matches[0]


def transaction(snapshot, attempt_id):
    matches = [x for x in snapshot["transactions"]
               if x.get("description") == f"treasury-T1-2026-09-24:{attempt_id}"]
    assert len(matches) == 1, (attempt_id, len(matches))
    row = matches[0]
    assert (row["from"], row["to"], row["resourceType"], row["amount"]) == (
        "E3N59", "E4N58", "H", 100)
    return row


def verify():
    assert OLD["bytes"] <= 5 * 1024 * 1024
    assert FINAL["bytes"] <= 5 * 1024 * 1024
    old_names = ["r2-pre-canary", "r2-after-canary", "r2-drained", "r2-off", "r2-restart-off"]
    final_names = ["r2-carrier-pre", "r2-carrier-send", "r2-carrier-held-settled",
                   "r2-carrier-drained", "r2-carrier-off", "r2-carrier-restart-off"]
    rows = {name: load(name) for name in old_names + final_names}
    for name in old_names:
        assert rows[name][0]["code"]["sha256"] == OLD["fileSha256"], name
    for name in final_names:
        assert rows[name][0]["code"]["sha256"] == FINAL["fileSha256"], name

    first_pre, first_pre_mem = rows["r2-pre-canary"]
    first_send, first_send_mem = rows["r2-after-canary"]
    first_drain, first_drain_mem = rows["r2-drained"]
    first_off, first_off_mem = rows["r2-off"]
    first_restart, first_restart_mem = rows["r2-restart-off"]
    first_id = "lab-r2-100H"
    assert (task(first_pre_mem, first_id)["status"], task(first_pre_mem, first_id)["remainingAmount"]) == ("pending", 100)
    assert (task(first_send_mem, first_id)["status"], task(first_send_mem, first_id)["remainingAmount"]) == ("done", 0)
    assert task(first_send_mem, first_id)["treasurySlice"]["phase"] == "closing"
    first_attempt = quota(first_send_mem)["attemptId"]
    transaction(first_send, first_attempt)
    assert len(first_send["transactions"]) == len(first_pre["transactions"]) + 1
    assert terminal(first_pre, "E3N59")["store"]["H"] - terminal(first_send, "E3N59")["store"]["H"] == 100
    assert terminal(first_pre, "E3N59")["store"]["energy"] - terminal(first_send, "E3N59")["store"]["energy"] == 4
    assert terminal(first_send, "E4N58")["store"]["H"] - terminal(first_pre, "E4N58")["store"]["H"] == 100
    assert not first_drain_mem["runtime"]["treasuryCore"]["active"]
    assert quota(first_off_mem)["status"] == "drained"
    assert "treasurySlice" not in task(first_off_mem, first_id)
    assert task(first_restart_mem, first_id)["remainingAmount"] == 0
    assert len(first_restart["transactions"]) == len(first_send["transactions"])

    carrier_pre, carrier_pre_mem = rows["r2-carrier-pre"]
    carrier_send, carrier_send_mem = rows["r2-carrier-send"]
    carrier_hold, carrier_hold_mem = rows["r2-carrier-held-settled"]
    carrier_drain, carrier_drain_mem = rows["r2-carrier-drained"]
    carrier_off, carrier_off_mem = rows["r2-carrier-off"]
    carrier_restart, carrier_restart_mem = rows["r2-carrier-restart-off"]
    carrier_id = "lab-r2-carrier-100H"
    assert (task(carrier_pre_mem, carrier_id)["status"], task(carrier_pre_mem, carrier_id)["remainingAmount"]) == ("pending", 100)
    assert carrier_pre_mem["creeps"]["lab-r2-carrier"]["role"] == "carrier"
    assert carrier(carrier_pre)["store"].get("energy", 0) == 0
    carrier_attempt = quota(carrier_send_mem)["attemptId"]
    transaction(carrier_send, carrier_attempt)
    assert len(carrier_send["transactions"]) == len(carrier_pre["transactions"]) + 1
    assert carrier(carrier_send)["store"]["energy"] == 50
    assert carrier_send_mem["creeps"]["lab-r2-carrier"]["working"] is True
    assert (task(carrier_hold_mem, carrier_id)["status"], task(carrier_hold_mem, carrier_id)["remainingAmount"]) == ("done", 0)
    assert carrier(carrier_hold)["store"]["energy"] == 50
    assert terminal(carrier_hold, "E4N58")["store"]["energy"] == terminal(carrier_send, "E4N58")["store"]["energy"]
    assert not carrier_drain_mem["runtime"]["treasuryCore"]["active"]
    assert carrier(carrier_drain)["store"]["energy"] == 50
    assert quota(carrier_off_mem)["status"] == "drained"
    assert "treasurySlice" not in task(carrier_off_mem, carrier_id)
    assert terminal(carrier_off, "E4N58")["store"]["energy"] - terminal(carrier_drain, "E4N58")["store"]["energy"] == 50
    assert len(carrier_restart["transactions"]) == len(carrier_send["transactions"])
    assert task(carrier_restart_mem, carrier_id)["remainingAmount"] == 0

    setup_first = json.loads((ROOT / "setup-100h.json").read_text())
    setup_carrier = json.loads((ROOT / "setup-carrier.json").read_text())
    assert setup_first["afterMemorySha256"] == hashlib.sha256(first_pre["rawMemory"].encode()).hexdigest()
    assert setup_carrier["afterMemorySha256"] == hashlib.sha256(carrier_pre["rawMemory"].encode()).hexdigest()
    return {
        "schema": "screeps-treasury-t1-r2-verification/v1",
        "status": "passed", "engineVersion": FINAL["engineVersion"],
        "closureCodeSha256": OLD["fileSha256"], "finalCodeSha256": FINAL["fileSha256"],
        "firstAttempt": first_attempt, "carrierAttempt": carrier_attempt,
        "firstSendTick": transaction(first_send, first_attempt)["time"],
        "carrierSendTick": transaction(carrier_send, carrier_attempt)["time"],
        "carrierEnergyHeld": 50, "carrierEnergyDeliveredAfterOff": 50,
        "transactionCountAfterRestart": len(carrier_restart["transactions"]),
        "snapshotCount": len(rows),
    }


if __name__ == "__main__":
    result = verify()
    (ROOT / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))

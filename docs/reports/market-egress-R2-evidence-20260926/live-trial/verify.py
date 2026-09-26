#!/usr/bin/env python3
"""复核 G1 R2 唯一正式试运行的代码、协议、额度和退出原件。"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OLD_HEAD = "csh1:8ca735c4bdcdce158e8a379e175f4a5b"
DEPLOYED_SHA = "0f13b0c4814686567e7ed3c72a3c22376a6b22ae304e02b3c17858763cfe0a4f"
RUN_ID = "market-base-egress-r2-2026-09-26"


def load(name):
    return json.loads((ROOT / name).read_text())


preflight = load("preflight-summary.json")
upload = load("upload-readback.json")
cfg = load("cfg-readback.json")
proposal = load("proposal-readback.json")
accepted = load("accept-readback.json")
before = load("before-trial.json")
started = load("start-readback.json")
final = load("final-readback.json")
assert preflight["codeSha256"] == "13d3c5e698c5ef8d60bb1d0baf5420d9e3081c040494343ff3a1080fbabf2caa"
assert preflight["cfgRevision"] == "market-base-resource-v3-r6"
assert preflight["permitEpoch"] == 16
assert preflight["receiptHead"] == OLD_HEAD and preflight["pending"] is None
assert upload["matches"] is True
assert upload["localSha256"] == upload["remoteSha256"] == DEPLOYED_SHA
assert upload["localBytes"] == upload["remoteBytes"] == 4_558_659
assert cfg["cfgRevision"] == "market-base-resource-v3-r7"
assert cfg["permitEpoch"] == 16 and cfg["receiptHead"] == OLD_HEAD
assert proposal["kind"] == "v3-policy-migration"
assert proposal["targetPermitEpoch"] == 17
assert proposal["receiptHead"] == proposal["targetLedgerReceiptHead"] == OLD_HEAD
assert proposal["pending"] is None and proposal["quarantine"] == 0
assert accepted["cfgRevision"] == "market-base-resource-v3-r7"
assert accepted["permitEpoch"] == 17 and accepted["receiptHead"] == OLD_HEAD
assert accepted["finalizedSeq"] == 15 and accepted["notBefore"] == 73_958_767
assert accepted["pending"] is None and accepted["quarantine"] == 0
assert accepted["proposal"] is None
assert {(lane["room"], lane["resource"], lane["stage"], lane["cooldown"])
        for lane in accepted["writable"]} == {
            ("E4N58", "X", "continuous", 100),
            ("E1N57", "L", "continuous", 100),
            ("E3N59", "H", "canary", 1_000),
        }
assert before["codeSha256"] == DEPLOYED_SHA
assert before["trial"] is None and before["pending"] is None
assert before["receiptHead"] == OLD_HEAD and before["finalizedSeq"] == 15

trial = started["state"]
assert started["mirrorMatches"] is True
assert trial["runId"] == RUN_ID and trial["status"] == "active"
assert trial["startedAtTick"] == 73_958_367
assert trial["endTick"] == trial["startedAtTick"] + 3_000
assert trial["endMs"] == trial["startedAtMs"] + 60 * 60 * 1_000
assert trial["controlUntilMs"] == trial["startedAtMs"] + 60_000
assert trial["originalNotBefore"] == 73_958_767
assert trial["startAttemptSeq"] == 16
assert trial["callsReserved"] == trial["amountReserved"] == 0

events = [json.loads(line) for line in (ROOT / "observer.jsonl").read_text().splitlines()]
heartbeats = [event for event in events if event["event"] == "heartbeat"]
assert len(heartbeats) == 118
assert len({event["operationId"] for event in heartbeats}) == len(heartbeats)
assert events[0]["event"] == "observed"
assert events[-1]["event"] == "closed"
assert events[-1]["closeReason"] == "capacity_recovered"
assert all(event["event"] in ("observed", "heartbeat", "closed") for event in events)
assert all(event.get("callsReserved", 0) == 0 and event.get("amountReserved", 0) == 0
           for event in events)

samples = sorted(ROOT.glob("sample-*.json"))
assert len(samples) == 7
for path in samples:
    sample = json.loads(path.read_text())
    value = sample["runtime"]["marketBaseResourceEgressTrialR2"]
    mirror = sample["runtime"]["marketBaseResourceEgressTrialR2Mirror"]
    ledger = sample["ledger"]
    assert value == mirror
    assert value["runId"] == RUN_ID
    assert value["callsReserved"] == value["amountReserved"] == 0
    assert ledger["receiptHeadHash"] == OLD_HEAD
    assert ledger["finalizedAttemptSeq"] == 15 and ledger.get("pending") is None
    assert not [row for row in sample["moneyHistory"]["list"]
                if row["type"] == "market.sell" and row["tick"] >= trial["startedAtTick"]]
post_close = load("sample-2026-09-26T135410-689Z.json")
assert post_close["runtime"]["marketBaseResourceEgressTrialR2"]["status"] == "closed"
assert post_close["runtime"]["marketBaseResourceEgressTrialR2"]["closeReason"] == "capacity_recovered"
assert post_close["planning"]["complete"] is True
assert post_close["ledger"].get("pending") is None

open_monitor = load("trial-monitor-open.json")["memory"]
later_monitor = load("trial-monitor-1339.json")["memory"]
for monitor in (open_monitor, later_monitor):
    candidate = next(row for row in monitor["marketSaleAutomation"]["candidates"]
                     if row["key"] == "E4N58:X")
    assert candidate["sellableAmount"] == 0
    assert candidate["rejectedReason"] == "direct_terminal_stock_shortage"
    assert monitor["marketSaleAutomation"]["direct"]["baseResourceV3"]["planning"]["complete"] is True
    assert monitor["marketSaleAutomation"]["direct"]["baseResourceV3"]["planning"]["selected"] is None
room = load("e4-room-objects.json")
storage = next(value for value in room["stores"] if value["type"] == "storage")
terminal = next(value for value in room["stores"] if value["type"] == "terminal")
assert storage["store"]["X"] == 2_942_223
assert terminal["store"]["X"] == 0
assert terminal["store"]["energy"] >= 25_000

closed = final["trial"]
assert final["mirrorMatches"] is True
assert final["codeSha256"] == DEPLOYED_SHA
assert final["cfgRevision"] == "market-base-resource-v3-r7"
assert final["mode"] == "direct" and final["permitEpoch"] == 17
assert final["treasuryMode"] == "absent"
assert closed["runId"] == RUN_ID and closed["status"] == "closed"
assert closed["closeReason"] == "capacity_recovered"
assert closed["callsReserved"] == closed["amountReserved"] == 0
assert closed["lastAttemptSeq"] == 15
assert final["ledger"]["receiptHead"] == OLD_HEAD
assert final["ledger"]["finalizedSeq"] == 15
assert final["ledger"]["notBefore"] == 73_958_767
assert final["ledger"]["pending"] is None
assert final["ledger"]["blocker"] is None
assert final["quarantine"] == 0 and final["newMarketSales"] == []

early = load("trial-monitor-early.json")["memory"]
end = load("trial-monitor-closed.json")["memory"]
early_rooms = {row["roomName"]: row for row in early["resourceControl"]["rooms"]}
end_rooms = {row["roomName"]: row for row in end["resourceControl"]["rooms"]}
assert set(early_rooms) == set(end_rooms) and len(end_rooms) == 8
assert all(row["capacityState"] == "normal" for row in end_rooms.values())
free_before = free_after = 0
for name, row in early_rooms.items():
    now = end_rooms[name]
    size_before = sum(row[key] for key in ("storageUsedCapacity", "storageFreeCapacity",
                                           "terminalUsedCapacity", "terminalFreeCapacity"))
    size_after = sum(now[key] for key in ("storageUsedCapacity", "storageFreeCapacity",
                                          "terminalUsedCapacity", "terminalFreeCapacity"))
    assert size_before == size_after
    free_before += row["storageFreeCapacity"] + row["terminalFreeCapacity"]
    free_after += now["storageFreeCapacity"] + now["terminalFreeCapacity"]

result = {
    "schema": "screeps-market-egress-r2-live-trial-verification/v1",
    "status": "passed",
    "deployedSha256": DEPLOYED_SHA,
    "runId": RUN_ID,
    "startTick": trial["startedAtTick"],
    "endReason": closed["closeReason"],
    "heartbeats": len(heartbeats),
    "nativeCallsReserved": closed["callsReserved"],
    "newConfirmedSales": len(final["newMarketSales"]),
    "finalizedAttemptSeq": final["ledger"]["finalizedSeq"],
    "empireFreeChangeInMonitorWindow": free_after - free_before,
    "terminalXAtBlocker": terminal["store"]["X"],
}
(ROOT / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))

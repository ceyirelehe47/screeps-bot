#!/usr/bin/env python3
"""Verify the isolated real-engine success and handback snapshots."""

from pathlib import Path
import json
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/srv/screeps-treasury-t1")
evidence = root if (root / "manifest.json").exists() else root / "evidence"
manifest_path = evidence / "manifest.json" if (evidence / "manifest.json").exists() else root / "candidate/manifest.json"
manifest = json.loads(manifest_path.read_text())
phases = ["pre-canary", "post-canary", "drain", "post-off", "post-restart-off"]
snapshots = {name: json.loads((evidence / f"{name}.json").read_text()) for name in phases}
memories = {name: json.loads(snapshots[name]["rawMemory"]) for name in phases}
failures = []


def check(condition, label):
    if not condition:
        failures.append(label)


def terminal(phase, room):
    return next(o for o in snapshots[phase]["objects"] if o.get("type") == "terminal" and o.get("room") == room)


def task(phase):
    return memories[phase]["data"]["resourceControl"]["tasks"]["lab-existing-H-task"]


def quota(phase):
    return memories[phase]["runtime"].get("treasuryProductionT1Quota")


def transactions(phase):
    return sorted(snapshots[phase]["transactions"], key=lambda x: x["time"])


for phase in phases:
    snap = snapshots[phase]
    check(snap["paused"] is True, f"{phase}: world not paused at snapshot")
    check(snap["code"]["sha256"] == manifest["fileSha256"], f"{phase}: module SHA drift")
    check(snap["code"]["bytes"] == manifest["bytes"], f"{phase}: module size drift")
    check(snap["user"]["username"] == "lab_treasury_t1", f"{phase}: user drift")

pre = memories["pre-canary"]
check(pre["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "shadow", "pre: not shadow")
check("treasuryCore" not in pre.get("runtime", {}), "pre: core already present")
check(quota("pre-canary") is None, "pre: quota already present")
check(len(pre["runtime"]["resourceReservations"]) == 1, "pre: nonempty reservation missing")
check(task("pre-canary")["remainingAmount"] == 250, "pre: task amount")
check((terminal("pre-canary", "E3N59")["store"]["H"], terminal("pre-canary", "E3N59")["store"]["energy"]) == (1000, 10000), "pre: source stock")
check(terminal("pre-canary", "E4N58")["store"]["H"] == 200, "pre: target stock")
check(len(transactions("pre-canary")) == 0, "pre: prior transaction")
check(pre.get("labT1Probe", {}).get("quote100") == 4, "pre: native 100 H fee quote")

canary = memories["post-canary"]
ring = canary["runtime"]["treasuryCore"]["ring"]
attempt = quota("post-canary")["attemptId"]
first = transactions("post-canary")
check(canary["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "canary", "canary: wrong mode")
check(canary["runtime"]["resourceReservationsOwnerVersion"] == 4, "canary: reservation migration")
check(len(canary["runtime"]["resourceReservations"]) == 1, "canary: reservation lost")
check(quota("post-canary")["amount"] == 100 and quota("post-canary")["status"] == "dispatching", "canary: quota")
check(task("post-canary")["remainingAmount"] == 150, "canary: task progress")
check(task("post-canary").get("treasurySlice", {}).get("outcome") == "committed", "canary: task lease outcome")
check(len(canary["runtime"]["treasuryCore"]["active"]) == 0, "canary: active work not retired")
check(len(ring) == 1 and ring[0]["attemptId"] == attempt and ring[0]["terminalPhase"] == "committed", "canary: ring")
check(len(first) == 1 and first[0]["amount"] == 100 and first[0]["time"] == 320, "canary: native transaction")
check(first[0]["description"] == "treasury-T1-2026-09-24:" + attempt, "canary: transaction identity")
check((terminal("post-canary", "E3N59")["store"]["H"], terminal("post-canary", "E3N59")["store"]["energy"]) == (900, 9996), "canary: source delta")
check(terminal("post-canary", "E4N58")["store"]["H"] == 300, "canary: target delta")

drain = memories["drain"]
check(drain["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "drain", "drain: wrong mode")
check(task("drain")["remainingAmount"] == 150, "drain: task changed")
check(len(transactions("drain")) == 1, "drain: duplicate dispatch")
check(terminal("drain", "E3N59")["store"]["H"] == 900 and terminal("drain", "E4N58")["store"]["H"] == 300, "drain: stock changed")

off = memories["post-off"]
final_tx = transactions("post-off")
check(off["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off", "off: wrong mode")
check(task("post-off")["status"] == "done" and task("post-off")["remainingAmount"] == 0, "off: legacy remaining")
check("treasurySlice" not in task("post-off"), "off: lease not released")
check(quota("post-off")["status"] == "drained", "off: quota not drained")
check(len(off["runtime"]["treasuryCore"]["active"]) == 0, "off: active work")
check(len(final_tx) == 2 and [x["amount"] for x in final_tx] == [100, 150], "off: transaction amounts")
check(final_tx[1]["description"] == "resourceControl:task:lab-existing-H-task", "off: legacy transaction identity")
check((terminal("post-off", "E3N59")["store"]["H"], terminal("post-off", "E3N59")["store"]["energy"]) == (750, 9991), "off: source delta")
check(terminal("post-off", "E4N58")["store"]["H"] == 450, "off: target delta")

restart = memories["post-restart-off"]
check(snapshots["post-restart-off"]["tick"] >= 400, "restart: insufficient ticks")
check(task("post-restart-off")["status"] == "done" and task("post-restart-off")["remainingAmount"] == 0, "restart: task changed")
check(quota("post-restart-off")["status"] == "drained", "restart: quota changed")
check(len(transactions("post-restart-off")) == 2, "restart: resend")
check(terminal("post-restart-off", "E3N59")["store"]["H"] == 750 and terminal("post-restart-off", "E4N58")["store"]["H"] == 450, "restart: stock changed")

cpu_phases = [
    "cpu-off-steady", "cpu-shadow-steady", "cpu-canary-first",
    "cpu-canary-settlement", "cpu-canary-steady", "cpu-drain-steady", "cpu-off-handback",
]
cpu_snapshots = {name: json.loads((evidence / f"{name}.json").read_text()) for name in cpu_phases}
cpu_memories = {name: json.loads(cpu_snapshots[name]["rawMemory"]) for name in cpu_phases}


def cpu_task(phase):
    return cpu_memories[phase]["data"]["resourceControl"]["tasks"]["lab-cpu-H-task"]


def cpu_terminal(phase, room):
    return next(o for o in cpu_snapshots[phase]["objects"] if o.get("type") == "terminal" and o.get("room") == room)


cpu_summary = {}
for phase in cpu_phases:
    snap = cpu_snapshots[phase]
    memory = cpu_memories[phase]
    monitor = memory["analytics"]["cpuMonitor"]
    latest = monitor["latest"]
    summary = monitor["summary"]
    check(snap["paused"] is True, f"{phase}: world not paused")
    check(snap["code"]["sha256"] == manifest["fileSha256"], f"{phase}: module SHA drift")
    check(monitor["sampleInterval"] == 1 and summary["ticks"] == 10, f"{phase}: CPU sampling window")
    check(latest["tick"] < snap["tick"] and latest["totalUsed"] > 0, f"{phase}: CPU sample missing")
    cpu_summary[phase] = {
        "tick": latest["tick"],
        "totalUsed": round(latest["totalUsed"], 3),
        "avgTotalUsedLast10": round(summary["avgTotalUsed"], 3),
        "phases": {key: round(value, 3) for key, value in latest["phases"].items()
                   if key.startswith("treasury") or key == "resourceControl"},
    }

check(cpu_memories["cpu-off-steady"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off", "CPU trial: OFF mode")
check(cpu_memories["cpu-shadow-steady"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "shadow", "CPU trial: shadow mode")
check(cpu_task("cpu-off-steady")["remainingAmount"] == 250 and cpu_task("cpu-shadow-steady")["remainingAmount"] == 250, "CPU trial: task changed before canary")
check(len(cpu_snapshots["cpu-shadow-steady"]["transactions"]) == 2, "CPU trial: prior transaction count")

cpu_first = cpu_snapshots["cpu-canary-first"]["transactions"]
cpu_attempt = cpu_memories["cpu-canary-first"]["runtime"]["treasuryProductionT1Quota"]["attemptId"]
check(len(cpu_first) == 3 and cpu_first[-1]["amount"] == 100 and cpu_first[-1]["time"] == 440, "CPU trial: actual native dispatch")
check(cpu_first[-1]["description"] == "treasury-T1-2026-09-24:" + cpu_attempt, "CPU trial: native dispatch identity")
check(cpu_task("cpu-canary-first")["remainingAmount"] == 250, "CPU trial: premature task decrement")
check((cpu_terminal("cpu-canary-first", "E3N59")["store"]["H"], cpu_terminal("cpu-canary-first", "E3N59")["store"]["energy"]) == (650, 9987), "CPU trial: source stock and fee")
check(cpu_terminal("cpu-canary-first", "E4N58")["store"]["H"] == 550, "CPU trial: target stock")
check(cpu_task("cpu-canary-settlement")["remainingAmount"] == 150 and len(cpu_snapshots["cpu-canary-settlement"]["transactions"]) == 3, "CPU trial: settlement")
check(cpu_task("cpu-canary-steady")["remainingAmount"] == 150 and len(cpu_snapshots["cpu-canary-steady"]["transactions"]) == 3, "CPU trial: canary duplicate")
check(cpu_memories["cpu-drain-steady"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "drain", "CPU trial: drain mode")
check(cpu_task("cpu-drain-steady")["remainingAmount"] == 150 and len(cpu_snapshots["cpu-drain-steady"]["transactions"]) == 3, "CPU trial: drain duplicate")
check(cpu_memories["cpu-off-handback"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off", "CPU trial: final OFF mode")
check(cpu_task("cpu-off-handback")["status"] == "done" and cpu_task("cpu-off-handback")["remainingAmount"] == 0, "CPU trial: legacy handback")
check(cpu_memories["cpu-off-handback"]["runtime"]["treasuryProductionT1Quota"]["status"] == "drained", "CPU trial: quota not drained")
check(len(cpu_snapshots["cpu-off-handback"]["transactions"]) == 4 and cpu_snapshots["cpu-off-handback"]["transactions"][-1]["amount"] == 150, "CPU trial: legacy transaction")
check((cpu_terminal("cpu-off-handback", "E3N59")["store"]["H"], cpu_terminal("cpu-off-handback", "E3N59")["store"]["energy"]) == (500, 9982), "CPU trial: final source stock")
check(cpu_terminal("cpu-off-handback", "E4N58")["store"]["H"] == 700, "CPU trial: final target stock")

result = {
    "schema": "screeps-treasury-t1-engine-verification/v1",
    "status": "success_path_pass" if not failures else "failed",
    "scope": "isolated engine success, drain, OFF handback, and restart; unknown/conflict only in deterministic tests",
    "sourceCommit": manifest["sourceCommit"],
    "moduleSha256": manifest["fileSha256"],
    "engineVersion": manifest["engineVersion"],
    "ticks": {name: snapshots[name]["tick"] for name in phases},
    "treasuryDispatches": 1,
    "legacyHandbackDispatches": 1,
    "treasuryAmount": 100,
    "legacyRemainingAmount": 150,
    "firstFeeEnergy": 4,
    "secondFeeEnergy": 5,
    "cpuTrial": cpu_summary,
    "failures": failures,
}
output = evidence / "verification.json"
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
if failures:
    raise SystemExit(1)

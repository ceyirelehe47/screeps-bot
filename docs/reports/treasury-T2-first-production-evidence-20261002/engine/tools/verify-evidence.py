#!/usr/bin/env python3
"""从同一冻结 main、隔离引擎原始 Store/transaction/Memory 与 journal 重算 C 项。

不读取既有 passed、结论或派生结果文件。输入标签只定位原件，不能授予通过。
"""
import argparse
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path


RUN_ID = "treasury-production-T2-2026-10-02"
CONTROL_RUN_ID = "treasury-t2-first-live-2026-10-02"
CONTROL_KEY = "treasuryT2FirstLiveControl"
MIRROR_KEY = "treasuryT2FirstLiveControlMirror"
QUOTA_KEY = "treasuryProductionT2Quota"
CONFIG_KEY = "treasuryTerminalTransferT2"
ACTION_KIND = "production.terminal-transfer.uh-synthesis.slice0"
SEMANTIC_ID = "production.terminal-transfer.uh-synthesis.slice0@E4N58-E1N57-UH-v1"
PREFIX = "treasury-T2-2026-10-02:"
SOURCE = "E4N58"
TARGET = "E1N57"
RESOURCE = "UH"
MASK32 = 0xffffffff
FROZEN_MAIN_SHA = "a33ca56e530060f0e719630324bfe3d55649786ff19525483fd04197d315653f"
FROZEN_MAIN_BYTES = 3308853
FINAL_LABELS = (["c1-1715-" + suffix for suffix in
                 ("before-native", "real-native", "first-settlement", "recovered-no-rededuct", "ordinary-restored")]
                + ["c1-100-" + suffix for suffix in
                   ("before-native", "real-native", "first-settlement", "recovered-no-rededuct")]
                + ["c2-" + suffix for suffix in
                   ("ordinary-pre-baseline", "ordinary-pre-observed", "bound-after-ordinary-pre", "real-native", "unknown-off-held",
                    "unrelated-native-while-unknown", "carrier-target-held", "carrier-source-held",
                    "unknown-after-real-restart", "carrier-source-after-reset-held",
                    "first-restored-settlement", "confirmed-ordinary-and-carrier-restored")]
                + ["c3-" + suffix for suffix in
                   ("armed-bound-no-responsibility", "expired-ordinary-restored", "off-after-real-restart", "rearm-rejected")]
                + ["c2-carrier-prestate-supplement-" + suffix for suffix in ("before", "held", "settled", "released")])


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def timestamp(snapshot):
    return datetime.fromisoformat(snapshot["capturedAtUtc"].replace("Z", "+00:00")).timestamp()


def utf16_units(value):
    encoded = value.encode("utf-16-le")
    return [int.from_bytes(encoded[index:index + 2], "little")
            for index in range(0, len(encoded), 2)]


def fnv32(value, seed):
    result = seed & MASK32
    for code in utf16_units(value):
        result = ((result ^ code) * 0x01000193) & MASK32
    return result


def treasury_hash(value):
    first = fnv32(value, 0x811c9dc5)
    second = fnv32(value, 0x9e3779b9 ^ ((first * 0x85ebca6b) & MASK32))
    return f"{first:08x}{second:08x}"


def stable_hash(value):
    # Control 只含字符串、布尔与安全整数；JSON 排序键与产品 canonical 合同一致。
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    multipliers = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f]
    for code in utf16_units(canonical):
        words = [((word ^ code) * multiplier) & MASK32
                 for word, multiplier in zip(words, multipliers)]
    def avalanche(value):
        value ^= value >> 16
        value = (value * 0x7feb352d) & MASK32
        value ^= value >> 15
        value = (value * 0x846ca68b) & MASK32
        value ^= value >> 16
        return value & MASK32
    return "csh1:" + "".join(f"{avalanche(word):08x}" for word in words)


def safe_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1


def room_coordinate(room):
    match = re.fullmatch(r"([WE])(\d+)([NS])(\d+)", room)
    require(match is not None, f"非法房间坐标：{room}")
    horizontal, x, vertical, y = match.groups()
    return (int(x) if horizontal == "E" else -int(x) - 1,
            int(y) if vertical == "S" else -int(y) - 1)


def fee(amount, source, target):
    left, right = room_coordinate(source), room_coordinate(target)
    distance = max(abs(left[0] - right[0]), abs(left[1] - right[1]))
    return math.ceil(amount * (1 - math.exp(-distance / 30)))


class Evidence:
    def __init__(self, root, candidate, manifest_path, schema, lab_account, service, labels=None):
        self.root = root
        self.directory = root / "engine/evidence"
        self.labels = list(labels or FINAL_LABELS)
        self.manifest = load(manifest_path)
        main_path = candidate / "main.js" if candidate.is_dir() else candidate
        self.main = main_path.read_bytes()
        self.sha = hashlib.sha256(self.main).hexdigest()
        require(self.sha == self.manifest["mainSha256"], "候选 main SHA 与冻结清单不符")
        require(len(self.main) == self.manifest["mainBytes"] < 5_000_000,
                "候选 main 大小与冻结清单不符")
        require(self.sha == FROZEN_MAIN_SHA and len(self.main) == FROZEN_MAIN_BYTES, "候选不是本轮批准的精确最终构建")
        self.candidate_manifest = self.manifest
        candidate_manifest_path = main_path.parent / "manifest.json"
        if candidate_manifest_path.exists():
            self.candidate_manifest = load(candidate_manifest_path)
            require(all(self.candidate_manifest[key] == self.manifest[key] for key in
                        ("mainSha256", "mainBytes", "buildTag", "deployBundleHash", "sourceCommit", "accountId")),
                    "候选身份清单与冻结清单不符")
        self.lab_account = lab_account
        require(lab_account != self.manifest["accountId"], "隔离账号不能是生产账号")
        self.service = service
        self.snapshots = {}
        try:
            manifest_label = str(manifest_path.relative_to(root))
        except ValueError:
            manifest_label = str(manifest_path)
        self.inputs = {manifest_label: hashlib.sha256(manifest_path.read_bytes()).hexdigest()}
        self.non_adopted_snapshots = []
        self.independent_baseline_sha = None
        for path in sorted(self.directory.glob("*-snapshot.json")):
            raw = path.read_bytes()
            snapshot = json.loads(raw)
            label = path.stem.removesuffix("-snapshot")
            if label not in self.labels:
                self.non_adopted_snapshots.append({"label": label, "capturedAtUtc": snapshot.get("capturedAtUtc"),
                    "tick": snapshot.get("tick"), "code": snapshot.get("code"),
                    "rawSha256": hashlib.sha256(raw).hexdigest(),
                    "scope": "不作为 C 发送/结算/退出状态结果；辅助身份读取另按具体用途核验"})
                continue
            require(snapshot["schema"] == schema, f"{label} snapshot schema 不符")
            require(snapshot["label"] == label, f"{label} 标签与文件名不符")
            require(snapshot["paused"] is True, f"{label} 未暂停采集")
            require(snapshot["user"]["_id"] == lab_account, f"{label} 非指定隔离账号")
            require(snapshot["code"] == {"sha256": self.sha, "bytes": len(self.main)},
                    f"{label} 运行字节不是同一最终 main")
            require(snapshot["memoryUtf8Bytes"] == len(snapshot["rawMemory"].encode("utf-8")),
                    f"{label} rawMemory 字节数不符")
            require(safe_integer(snapshot["tick"]), f"{label} 非法 tick")
            tx_ids = [item["_id"] for item in snapshot["transactions"]]
            require(len(set(tx_ids)) == len(tx_ids), f"{label} transaction ID 重复")
            object_ids = [item["_id"] for item in snapshot["objects"]]
            require(len(set(object_ids)) == len(object_ids), f"{label} object ID 重复")
            snapshot["m"] = json.loads(snapshot["rawMemory"])
            self.snapshots[label] = snapshot
            self.inputs[str(path.relative_to(root))] = hashlib.sha256(raw).hexdigest()
        require(set(self.snapshots) == set(self.labels), "缺少指定 C1/C2/C3 原始 snapshot：" +
                ",".join(sorted(set(self.labels) - set(self.snapshots))))
        journal_path = root / "engine/service-journal-original.jsonl"
        self.journal = [json.loads(line) for line in journal_path.read_text().splitlines() if line.strip()]
        self.inputs[str(journal_path.relative_to(root))] = hashlib.sha256(journal_path.read_bytes()).hexdigest()

    def snap(self, label):
        require(label in self.snapshots, f"缺少 snapshot：{label}")
        return self.snapshots[label]

    def artifact(self, name):
        path = self.directory / name
        raw = path.read_bytes()
        self.inputs[str(path.relative_to(self.root))] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    def synthetic_setup(self, name, identifier, amount):
        artifact = self.artifact(name)
        require(artifact["isolatedWorldOnly"] is True and artifact["spec"]["amount"] == amount and
                artifact["taskId"] == identifier, "合成装夹声明/任务身份不符")
        raw = artifact["beforeRawMemory"]
        require(hashlib.sha256(raw.encode("utf-8")).hexdigest() == artifact["beforeMemorySha256"],
                "setup 前 Memory 原件 SHA 不符")
        before, after = json.loads(raw), json.loads(artifact["afterRawMemory"])
        require(not before["runtime"]["treasuryCore"]["active"], "合成独立用例开始前有未知责任")
        require(all(key not in before["runtime"] for key in (QUOTA_KEY, CONTROL_KEY, MIRROR_KEY)) and
                not any(entry["workKey"].startswith("biz:treasury-production-T2-")
                        for entry in before["runtime"]["treasuryCore"]["ring"]),
                "装夹前 T2 已消费/控制事实存在，不能清掉后称作独立新实例")
        instance = self.artifact(artifact["spec"]["case"] + "-independent-instance.json")
        require(instance["schema"] == "screeps-t2-independent-lab-instance/v1" and
                instance["isolatedWorldOnly"] is True and instance["case"] == artifact["spec"]["case"], "独立实例原件身份不符")
        require(instance["mainSha256"] == self.sha and instance["mainBytes"] == len(self.main), "独立副本非同一最终 main")
        kernel_facts = lambda kernel: {key: value for key, value in kernel.items() if key not in ("lifecycle", "recovery")}
        require(instance["oldHControl"] == before["runtime"]["treasuryT1FirstLiveControl"] and
                instance["oldHQuota"] == before["runtime"]["treasuryProductionT1Quota"] and
                kernel_facts(instance["oldKernel"]) == kernel_facts(before["runtime"]["treasuryCore"]),
                "独立副本原持久核心与 setup 前 Memory 不符（仅允许真实对齐tick bookkeeping）")
        baseline_sha = instance["baselineSha256"]
        require(re.fullmatch(r"[a-f0-9]{64}", baseline_sha) is not None, "独立 DB 基线 SHA 非法")
        if self.independent_baseline_sha is None:
            self.independent_baseline_sha = baseline_sha
        require(baseline_sha == self.independent_baseline_sha and int(instance["baselineTick"]) <= artifact["tick"],
                "独立用例不是同一 pre-T2 冻结 DB 副本")
        restore_at = datetime.fromisoformat(instance["restoredAtUtc"].replace("Z", "+00:00")).timestamp()
        first_snapshot_path = self.directory / (artifact["spec"]["case"] + "-before-setup-snapshot.json")
        first_snapshot = self.artifact(first_snapshot_path.name)
        for record in self.non_adopted_snapshots:
            if record["label"] == artifact["spec"]["case"] + "-before-setup":
                record["scope"] = "辅助独立实例启动身份读回；不作为 C 发送/结算/退出状态结果"
        require(first_snapshot["code"] == {"sha256": self.sha, "bytes": len(self.main)} and
                first_snapshot["user"]["_id"] == self.lab_account and first_snapshot["paused"] is True,
                "独立副本首次读回非同一冻结字节/实验账号/停态")
        require(first_snapshot["tick"] == int(instance["baselineTick"]) and
                first_snapshot["memoryUtf8Bytes"] == len(first_snapshot["rawMemory"].encode("utf-8")),
                "独立 DB 首次停态读回 tick/Memory 字节与基线不符")
        first_memory = json.loads(first_snapshot["rawMemory"])
        require(first_memory["runtime"]["treasuryCore"] == instance["oldKernel"], "首次停态读回核心不是原始 pre-T2 副本")
        if first_snapshot["tick"] % 5:
            require(first_snapshot["rawMemory"] == raw and artifact["tick"] == first_snapshot["tick"],
                    "无需对齐时 setup 前 Memory/tick 发生未声明改变")
        else:
            first_state = min((snapshot for label, snapshot in self.snapshots.items()
                               if label.startswith(artifact["spec"]["case"] + "-")), key=timestamp)
            # setup 原件直接读 tick 但没有 UTC 字段；后续首次状态 capture 给出推进时间上界。
            aligned = {"tick": artifact["tick"], "capturedAtUtc": first_state["capturedAtUtc"]}
            self.driver_between(artifact["spec"]["case"] + "-align-driver.json", first_snapshot, aligned, 1, kind="ticks")
            require(artifact["tick"] <= first_snapshot["tick"] + 2, "对齐推进超过有界一次tick机会")
            before_kernel = before["runtime"]["treasuryCore"]
            for section in ("lifecycle", "recovery"):
                original_section, later_section = instance["oldKernel"][section], before_kernel[section]
                require(set(original_section) == set(later_section), "对齐 tick 新增/删除 kernel bookkeeping 字段")
                for key in original_section:
                    if section == "lifecycle" or key == "budgetTick":
                        value = later_section[key]
                        require(value == original_section[key] or safe_integer(value) and
                                first_snapshot["tick"] <= value <= artifact["tick"], "对齐 kernel tick 字段越界/倒退")
                    else:
                        require(later_section[key] == original_section[key], "无 active 对齐 tick 改变 recovery 责任 bookkeeping")
        starts = [event for event in self.journal if event.get("_PID") == "1" and
                  event.get("MESSAGE", "").startswith("Started " + self.service) and
                  restore_at < int(event["__REALTIME_TIMESTAMP"]) / 1_000_000 < timestamp(first_snapshot)]
        require(len(starts) == 1, "独立 DB 副本恢复后没有唯一真实服务 start")
        for key in ("treasuryProductionT1Quota", "treasuryT1FirstLiveControl", "treasuryT1FirstLiveControlMirror", "treasuryCore"):
            require(before["runtime"][key] == after["runtime"][key], f"合成装夹改变旧持久事实：{key}")
        require(all(key not in after["runtime"] for key in (QUOTA_KEY, CONTROL_KEY, MIRROR_KEY)),
                "独立用例未从未消费的新 T2 合成身份开始")
        tasks = after["data"]["resourceControl"]["tasks"]
        require(set(tasks) == {identifier}, "合成用例含未声明任务")
        task = tasks[identifier]
        require((task["id"], task["amount"], task["remainingAmount"], task["status"], task["createdAt"]) ==
                (identifier, amount, amount, "pending", artifact["tick"]), "合成原任务创建/数量不符")
        require((task["fromRoomName"], task["toRoomName"], task["resource"], task["origin"], task["reason"]) ==
                (SOURCE, TARGET, RESOURCE, "automatic", "synthesis:E1N57:UH2O"), "合成任务非等价正式业务语义")
        require("treasurySlice" not in task, "装夹手造 task lease")
        return {"artifact": name, "kind": "明确合成的独立隔离任务", "taskId": identifier,
                "amount": amount, "createdAt": task["createdAt"], "independentBaselineSha256": baseline_sha,
                "startedMicroseconds": starts[0]["__REALTIME_TIMESTAMP"]}

    def driver_between(self, name, before, after, minimum_ticks=1, kind=None):
        driver = self.artifact(name)
        require(driver["schema"] == "screeps-t2-lab-driver/v1" and driver["isolatedWorldOnly"] is True,
                "引擎推进原件身份不符")
        require(driver["label"] == name.removesuffix("-driver.json") and (kind is None or driver["kind"] == kind),
                "引擎推进文件/运行标签/操作不符")
        require(safe_integer(driver["startTick"]) and safe_integer(driver["endTick"]) and
                before["tick"] <= driver["startTick"] <= before["tick"] + 1 and
                driver["endTick"] <= after["tick"] <= driver["endTick"] + 1 and
                driver["endTick"] - driver["startTick"] >= minimum_ticks and after["tick"] > before["tick"],
                "阶段未由真实引擎推进所需 tick")
        start = datetime.fromisoformat(driver["startedAtUtc"].replace("Z", "+00:00")).timestamp()
        end = datetime.fromisoformat(driver["endedAtUtc"].replace("Z", "+00:00")).timestamp()
        require(timestamp(before) <= start <= end <= timestamp(after), "引擎推进/capture 原始时间顺序不符")
        # matched/last 等已派生字段不是通过依据；只用直接读出的 tick 与原始时间。
        return {"artifact": name, "startTick": driver["startTick"], "endTick": driver["endTick"]}

    def synthesis_purpose(self, snapshot, amount):
        configuration = snapshot["m"]["cfg"]["synthesisControl"]
        room_config = configuration["rooms"][TARGET]
        state = self.runtime(snapshot)["synthesisControl"]["rooms"][TARGET]
        require(configuration["enabled"] is True and room_config["enabled"] is True and
                room_config["batchSize"] == amount and room_config["donorRoomNames"] == [SOURCE], "等价 UH2O 配置目标/供给房不符")
        reactions = room_config["reactions"]
        require(len(reactions) == 1 and reactions[0]["product"] == "UH2O" and
                reactions[0]["targetAmount"] == reactions[0]["batchSize"] == amount and
                reactions[0]["donorRoomNames"] == [SOURCE], "等价 UH2O 生产计划不符")
        require((state["stage"], state["activeProduct"], state["reagentA"], state["reagentB"],
                 state["targetAmount"], state["batchSize"]) == ("loading", "UH2O", "UH", "OH", amount, amount),
                "等价 UH2O 当前加载状态不符")
        require(room_config["reagentLabIds"] == state["reagentLabIds"] and len(state["reagentLabIds"]) == 2,
                "等价 UH2O reagent lab 绑定不符")
        labs = [self.obj(snapshot, identifier) for identifier in state["reagentLabIds"]]
        require(all((lab["type"], lab["room"], lab["user"]) == ("lab", TARGET, self.lab_account) for lab in labs),
                "等价用途没有真实自有 reagent labs")
        require(self.store(labs[1], "OH") == amount and self.store(labs[0], RESOURCE) == 0,
                "等价用途 OH 实货/缺 UH 事实不符")
        target_objects = [obj for obj in snapshot["objects"] if obj["room"] == TARGET and obj.get("user") == self.lab_account]
        require(sum(self.store(obj, RESOURCE) for obj in target_objects) == 0 and
                sum(self.store(obj, "UH2O") for obj in target_objects) == 0,
                "等价测试目标已有 UH/UH2O，需求不是声明的完整原始缺口")
        return {"product": "UH2O", "targetAmount": amount, "actualLocalUH": 0, "actualLocalUH2O": 0,
                "actualReagentLabOH": amount, "reagentLabIds": state["reagentLabIds"]}

    def carrier_held_trace(self, before, after, artifact, driver_name, require_prestate=True, minimum_ticks=2):
        driver = self.driver_between(driver_name, before, after, minimum_ticks, kind="ticks")
        name, target = artifact["name"], artifact["targetTerminalId"]
        readbacks = self.runtime(after)["__labT2CarrierPlanReadbacks"]
        relevant = [item for item in readbacks if item["name"] == name and
                    before["tick"] <= item["atTick"] < after["tick"] and item["targetId"] == target]
        require(relevant, "carrier 实验 plan 未有实际执行读回")
        latest = max(relevant, key=lambda item: item["atTick"])
        require(latest["resource"] == "H" and latest["storeH"] == 50 and
                latest["plan"] == {"synthesisCarrierPendingToId": target, "synthesisCarrierPendingResource": "H",
                    "synthesisCarrierPendingTaskType": "terminal_feed", "carrierStorageOnlyMode": False},
                "实际 carrier plan/readback/持货不符")
        events = [item for item in self.runtime(after)["__labT2CarrierWork"] if item["name"] == name and
                  latest["atTick"] <= item["tick"] < after["tick"] and item.get("toId") == target and
                  item.get("resource") == "H"]
        require(events, "真实 main 没有委托该 carrier 原 .work 的实际记录")
        for item in events:
            require(item["beforeH"] == item["afterH"] == 50 and "throwError" in item and item["throwError"] is None,
                    "carrier 原 .work 异常/持货扰动，不能作为正常保护证据")
        eligible = events
        if require_prestate:
            eligible = [item for item in events if item.get("traceSchemaVersion") == 2 and
                        item.get("role") == "carrier" and item.get("ready") is True and
                        item.get("working") is True and item.get("spawnYield", "missing") is None and
                        item.get("configName", "missing") is None]
            require(eligible, "carrier .work 没有 v2 真实调用前可执行 target 状态，不能排除提前返回")
        return {"name": name, "targetId": target, "planReadbackAtTick": latest["atTick"],
                "actualWorkTicks": sorted({item["tick"] for item in eligible}), "driver": driver,
                "scope": "v2 调用前标量证明真实 target 执行点" if require_prestate else
                         "原连续链 .work 委托/持货；调用前 target 状态由独立补充分支证明"}

    @staticmethod
    def runtime(snapshot):
        return snapshot["m"]["runtime"]

    @staticmethod
    def task(snapshot, identifier):
        task = snapshot["m"]["data"]["resourceControl"]["tasks"][identifier]
        require(task["id"] == identifier, f"任务 canonical ID 不符：{identifier}")
        return task

    @staticmethod
    def obj(snapshot, identifier):
        matches = [item for item in snapshot["objects"] if item["_id"] == identifier]
        require(len(matches) == 1, f"实体非唯一：{identifier}")
        return matches[0]

    @staticmethod
    def terminal(snapshot, room):
        matches = [item for item in snapshot["objects"] if item["type"] == "terminal" and item["room"] == room]
        require(len(matches) == 1, f"terminal 非唯一：{room}")
        return matches[0]

    @staticmethod
    def store(obj, resource):
        return obj.get("store", {}).get(resource, 0)

    def control(self, snapshot):
        runtime = self.runtime(snapshot)
        require(runtime["lastDeployTag"] == self.manifest["buildTag"] and
                runtime["lastDeployBundleHash"] == self.manifest["deployBundleHash"], "原件运行部署 tag/hash 不符")
        control = runtime[CONTROL_KEY]
        require(control == runtime[MIRROR_KEY], "control 主/镜像不一致")
        fields = {"schemaVersion", "runId", "status", "startedAtTick", "deadlineTick", "startedAtMs",
                  "deadlineMs", "lastHeartbeatAtMs", "controlUntilMs", "taskId", "taskCreatedAt",
                  "taskAmount", "taskRemainingAtArm", "sourceTerminalId", "targetTerminalId",
                  "deployTag", "deployBundleHash", "closeReason", "hash"}
        require(set(control) == fields, "control 字段合同不符")
        require(control["schemaVersion"] == 1 and control["runId"] == CONTROL_RUN_ID, "control 身份不符")
        require(control["status"] in ("active", "closed"), "control 状态非法")
        require(isinstance(control["closeReason"], str) and len(control["closeReason"]) <= 80 and
                ((control["status"] == "active" and control["closeReason"] == "") or
                 (control["status"] == "closed" and control["closeReason"] != "")), "control 关闭原因不符")
        for key in ("startedAtTick", "deadlineTick", "startedAtMs", "deadlineMs", "lastHeartbeatAtMs",
                    "controlUntilMs", "taskCreatedAt", "taskAmount", "taskRemainingAtArm"):
            require(safe_integer(control[key]), f"control {key} 不是非负安全整数")
        require(0 < control["taskRemainingAtArm"] <= control["taskAmount"], "control 任务数量非法")
        require(control["deadlineTick"] == control["startedAtTick"] + 600, "600 tick 边界不符")
        require(control["deadlineMs"] == control["startedAtMs"] + 1_800_000, "30 分钟边界不符")
        require(control["startedAtMs"] <= control["lastHeartbeatAtMs"] < control["deadlineMs"], "heartbeat 时段非法")
        require(control["lastHeartbeatAtMs"] <= control["controlUntilMs"] <=
                min(control["deadlineMs"], control["lastHeartbeatAtMs"] + 60_000), "60 秒 lease 边界不符")
        require(control["deployTag"] == self.manifest["buildTag"] and
                control["deployBundleHash"] == self.manifest["deployBundleHash"], "control 部署身份不符")
        payload = {key: value for key, value in control.items() if key != "hash"}
        require(control["hash"] == stable_hash({"domain": "treasury-t2:first-live-control-v1", "payload": payload}),
                "control hash 无法重导")
        task = self.task(snapshot, control["taskId"])
        require((task["createdAt"], task["amount"]) == (control["taskCreatedAt"], control["taskAmount"]),
                "control 未绑定原任务创建身份")
        require((task["fromRoomName"], task["toRoomName"], task["resource"], task["origin"], task["reason"]) ==
                (SOURCE, TARGET, RESOURCE, "automatic", "synthesis:E1N57:UH2O"), "非正式 UH2O 需求语义")
        for identifier, room in ((control["sourceTerminalId"], SOURCE), (control["targetTerminalId"], TARGET)):
            endpoint = self.obj(snapshot, identifier)
            require((endpoint["type"], endpoint["room"], endpoint["user"]) ==
                    ("terminal", room, self.lab_account), "control 未绑定自有新两端 terminal")
        return control

    @staticmethod
    def new_transactions(before, after):
        old = {item["_id"]: item for item in before["transactions"]}
        now = {item["_id"]: item for item in after["transactions"]}
        require(old.keys() <= now.keys(), "交易原件被删除")
        require(all(now[identifier] == transaction for identifier, transaction in old.items()), "既有交易原件被修改")
        return [item for item in after["transactions"] if item["_id"] not in old]

    def ordinary(self, transaction, identifier, amount, source, target, resource=RESOURCE):
        require(transaction["description"] == "resourceControl:task:" + identifier, "普通交易来源不符")
        require((transaction["from"], transaction["to"], transaction["resourceType"], transaction["amount"]) ==
                (source, target, resource, amount), "普通交易路线/数量不符")
        require(transaction["sender"] == transaction["recipient"] == self.lab_account, "普通交易账号不符")

    def endpoint_delta(self, before, after, source, target, amount, resource=RESOURCE):
        left0, left1 = self.terminal(before, source), self.terminal(after, source)
        right0, right1 = self.terminal(before, target), self.terminal(after, target)
        require(left0["_id"] == left1["_id"] and right0["_id"] == right1["_id"], "terminal 实体漂移")
        actual_fee = self.store(left0, "energy") - self.store(left1, "energy")
        require(self.store(left0, resource) - self.store(left1, resource) == amount, "源端实际货量不符")
        require(self.store(right1, resource) - self.store(right0, resource) == amount, "目标实际货量不符")
        require(actual_fee == fee(amount, source, target), "源端实际费用不符")
        require(self.store(right1, "energy") == self.store(right0, "energy"), "目标 Energy 外来扰动")
        return actual_fee

    def transaction_store_deltas(self, before, after, transactions, cargo_credits=None, checked_resources=None):
        expected = {}
        for transaction in transactions:
            source, target = transaction["from"], transaction["to"]
            resource, amount = transaction["resourceType"], transaction["amount"]
            for room, item_resource, delta in ((source, resource, -amount),
                                               (source, "energy", -fee(amount, source, target)),
                                               (target, resource, amount)):
                key = (room, item_resource)
                expected[key] = expected.get(key, 0) + delta
        for (room, resource), amount in (cargo_credits or {}).items():
            expected[(room, resource)] = expected.get((room, resource), 0) + amount
        rooms = {room for room, _ in expected}
        for room in rooms:
            left, right = self.terminal(before, room), self.terminal(after, room)
            require(left["_id"] == right["_id"], f"{room} terminal 身份漂移")
            resources = set(left.get("store", {})) | set(right.get("store", {})) | {resource for name, resource in expected if name == room}
            if checked_resources is not None:
                resources &= set(checked_resources)
            for resource in resources:
                require(self.store(right, resource) - self.store(left, resource) == expected.get((room, resource), 0),
                        f"{room} {resource} Store 差值不能由真实交易/明确 carrier cargo 重导")

    def native(self, before, after, identifier, original_amount):
        runtime = self.runtime(after)
        quota = runtime[QUOTA_KEY]
        expected_fields = {"schemaVersion", "runId", "status", "taskId", "taskCreatedAt", "taskAmount",
                           "workKey", "attemptId", "amount", "reservedAtTick"}
        require(set(quota) == expected_fields, "quota 字段合同不符")
        require((quota["schemaVersion"], quota["runId"], quota["status"], quota["taskId"], quota["amount"]) ==
                (2, RUN_ID, "dispatching", identifier, 100), "quota 身份/状态/数量不符")
        require(all(safe_integer(quota[key]) for key in ("taskCreatedAt", "taskAmount", "amount", "reservedAtTick")),
                "quota 数量/创建身份不是非负安全整数")
        task = self.task(after, identifier)
        before_task = self.task(before, identifier)
        require((before_task["createdAt"], before_task["amount"], before_task["remainingAmount"], before_task["status"]) ==
                (task["createdAt"], original_amount, original_amount, "pending"), "native 前后不是同一未推进原任务")
        require((task["amount"], task["remainingAmount"], task["createdAt"]) ==
                (original_amount, original_amount, quota["taskCreatedAt"]), "native 后业务被提前扣减")
        require(quota["taskAmount"] == original_amount and quota["workKey"] ==
                "biz:" + RUN_ID + ":" + treasury_hash(identifier), "quota 任务工作身份不符")
        control = self.control(after)
        require(control["taskId"] == identifier and control["status"] == "closed" and
                control["closeReason"] == "native_attempt", "native 未关闭唯一活动授权")
        require(control["taskRemainingAtArm"] == original_amount, "arm 余量不符")
        kernel = runtime["treasuryCore"]
        before_counters = self.runtime(before).get("treasuryCore", {}).get("counters", {})
        require(kernel["counters"]["dispatched"] == before_counters.get("dispatched", 0) + 1 and
                kernel["counters"]["settledCommitted"] == before_counters.get("settledCommitted", 0),
                "本片 native delta 不是一，或尚未确认却发生结算")
        require(set(kernel["active"]) == {quota["attemptId"]}, "native 活跃 attempt 非唯一")
        work = kernel["active"][quota["attemptId"]]
        require(work["attemptId"] == quota["attemptId"] and work["workKey"] == quota["workKey"], "work 与 quota 身份不符")
        require(work["phase"] == "outcome_unknown" and work["outcome"] == "unknown", "OK 被错误立即确认")
        require(work["invocationBoundary"] == work["invocation"] and work["external"]["accepted"] is True,
                "native 调用边界证据缺失")
        identity = work["identity"]
        require(identity["actionKind"] == ACTION_KIND and identity["adapterSemanticIdentity"] == SEMANTIC_ID,
                "非正式 T2 adapter 语义")
        lease = task["treasurySlice"]
        require(lease["runId"] == RUN_ID and lease["attemptId"] == quota["attemptId"] and
                lease["workKey"] == quota["workKey"] and lease["amount"] == 100, "task lease 与原 attempt 不符")
        new = self.new_transactions(before, after)
        require(len(new) == 1, "native 时段不是唯一真实交易")
        transaction = new[0]
        require(transaction["description"] == PREFIX + quota["attemptId"], "真实 T2 交易未绑定原 attempt")
        require((transaction["from"], transaction["to"], transaction["resourceType"], transaction["amount"], transaction["time"]) ==
                (SOURCE, TARGET, RESOURCE, 100, work["invocation"]["atTick"]), "真实 T2 交易事实不符")
        require(transaction["sender"] == transaction["recipient"] == self.lab_account, "真实交易账号不符")
        fields = identity["durableFacts"]["payload"].split("|")
        require(len(fields) == 27 and fields[:8] ==
                ["t2", RUN_ID, RESOURCE, SOURCE, TARGET, "automatic", "synthesis:E1N57:UH2O", identifier],
                "durable T2 资源/两端/用途/任务语义不符")
        require((int(fields[8]), int(fields[9]), int(fields[10])) ==
                (quota["taskCreatedAt"], 100, work["invocation"]["atTick"]), "durable 创建/数量/tick 不符")
        require(fields[12] == after["user"]["username"], "durable 账号不符")
        actual_fee = self.endpoint_delta(before, after, SOURCE, TARGET, 100)
        require(int(fields[11]) == actual_fee, "durable quote 与实际费用不符")
        source, target = self.obj(before, fields[13]), self.obj(before, fields[20])
        require((fields[13], fields[20]) == (control["sourceTerminalId"], control["targetTerminalId"]), "durable terminal 身份不符")
        for endpoint, offset in ((source, 13), (target, 20)):
            require(self.store(endpoint, RESOURCE) == int(fields[offset + 1]) and
                    self.store(endpoint, "energy") == int(fields[offset + 2]), "durable Store 基线非原始实货")
            used = sum(endpoint.get("store", {}).values())
            require(used == int(fields[offset + 3]) and int(fields[offset + 3]) + int(fields[offset + 4]) ==
                    int(fields[offset + 5]) == 300_000, "durable 容量基线不符")
            require(endpoint.get("cooldown", 0) == int(fields[offset + 6]), "durable cooldown 基线不符")
        expected_postings = [(SOURCE, "terminal", RESOURCE, -100),
                             (SOURCE, "terminal", "energy", -actual_fee),
                             (TARGET, "terminal", RESOURCE, 100)]
        require([(item["roomName"], item["locationKind"], item["resource"], item["delta"])
                 for item in work["worstCase"]] == expected_postings, "UH/Energy postings 未分别记账")
        return quota, transaction, actual_fee

    def committed(self, snapshot, identifier, original_amount, quota, before):
        runtime = self.runtime(snapshot)
        task = self.task(snapshot, identifier)
        remaining = original_amount - quota["amount"]
        require(task["remainingAmount"] == remaining, "原任务未恰扣一次")
        require(task["status"] == ("done" if remaining == 0 else "pending"), "业务终态不符")
        require("treasurySlice" not in task, "结算后 task lease 未交回")
        require(runtime[QUOTA_KEY] == {**quota, "status": "drained"}, "消费额度事实被删除/重置")
        control = self.control(snapshot)
        require(control["status"] == "closed" and snapshot["m"]["cfg"][CONFIG_KEY]["mode"] == "off", "结算后未 closed/OFF")
        kernel = runtime["treasuryCore"]
        require(not kernel["active"], "结算责任未清理")
        entries = [entry for entry in kernel["ring"] if entry["attemptId"] == quota["attemptId"]]
        require(len(entries) == 1 and entries[0]["workKey"] == quota["workKey"] and
                entries[0]["terminalPhase"] == "committed", "原 attempt 非唯一 committed")
        before_counters = self.runtime(before).get("treasuryCore", {}).get("counters", {})
        require(kernel["counters"]["dispatched"] == before_counters.get("dispatched", 0) + 1 and
                kernel["counters"]["settledCommitted"] == before_counters.get("settledCommitted", 0) + 1,
                "本片 native 或结算 delta 不是一")
        return entries[0]

    def held(self, snapshot, identifier, original_amount, quota, native):
        runtime = self.runtime(snapshot)
        native_runtime = self.runtime(native)
        require(runtime[QUOTA_KEY] == quota, "未知责任期间原 quota 漂移")
        require(self.control(snapshot) == self.control(native), "未知责任期间原 control 漂移")
        require(snapshot["m"]["cfg"][CONFIG_KEY]["mode"] == "drain", "未知责任 OFF/失联未保留 drain")
        work = runtime["treasuryCore"]["active"][quota["attemptId"]]
        original_work = native_runtime["treasuryCore"]["active"][quota["attemptId"]]
        for key in ("workKey", "attemptId", "generation", "parentAttemptId", "identity", "worstCase",
                    "invocationBoundary", "invocation", "external"):
            require(work[key] == original_work[key], f"未知期间原 work {key} 漂移")
        for key in ("dispatched", "settledCommitted"):
            require(runtime["treasuryCore"]["counters"][key] == native_runtime["treasuryCore"]["counters"][key],
                    f"未知期间 {key} 不应推进")
        require(work["phase"] == "outcome_unknown" and work["outcome"] == "unknown", "未知责任被错误释放")
        require(not [item for item in runtime["treasuryCore"]["ring"] if item["attemptId"] == quota["attemptId"]],
                "矛盾未消除却写入终态")
        task = self.task(snapshot, identifier)
        require(task["status"] == "pending" and task["remainingAmount"] == original_amount and
                task["treasurySlice"]["attemptId"] == quota["attemptId"], "未知期间任务/lease 漂移")
        return work

    def real_restart(self, before, after):
        require(timestamp(after) > timestamp(before), "重启 snapshot 时间逆序")
        events = [item for item in self.journal
                  if timestamp(before) < int(item["__REALTIME_TIMESTAMP"]) / 1_000_000 < timestamp(after)]
        stops = [item for item in events if item.get("_PID") == "1" and
                 item.get("MESSAGE", "").startswith("Stopped " + self.service)]
        starts = [item for item in events if item.get("_PID") == "1" and
                  item.get("MESSAGE", "").startswith("Started " + self.service)]
        require(len(stops) == len(starts) == 1, "缺少唯一 systemd 真实进程 stop/start")
        require(int(stops[0]["__REALTIME_TIMESTAMP"]) < int(starts[0]["__REALTIME_TIMESTAMP"]), "重启 journal 顺序不符")
        return {"stoppedMicroseconds": stops[0]["__REALTIME_TIMESTAMP"],
                "startedMicroseconds": starts[0]["__REALTIME_TIMESTAMP"]}

    def legacy_preserved(self):
        ordered = sorted(self.snapshots.values(), key=timestamp)
        first_runtime = self.runtime(ordered[0])
        keys = ("treasuryProductionT1Quota", "treasuryT1FirstLiveControl", "treasuryT1FirstLiveControlMirror")
        reference = {key: first_runtime[key] for key in keys}
        quota = reference[keys[0]]
        require(quota["status"] == "drained" and quota["runId"] == "treasury-production-T1-2026-09-24",
                "隔离世界未保留旧 H 已消费额度事实")
        require(reference[keys[1]] == reference[keys[2]] and reference[keys[1]]["status"] == "closed",
                "旧 H control 原件不一致/未关闭")
        original_ring = [item for item in first_runtime["treasuryCore"]["ring"]
                         if item["attemptId"] == quota["attemptId"]]
        require(len(original_ring) == 1 and original_ring[0]["terminalPhase"] == "committed",
                "旧 H 唯一结算事实缺失")
        for snapshot in ordered:
            runtime = self.runtime(snapshot)
            require({key: runtime[key] for key in keys} == reference, "新 T2 用例重置/改变旧 H 持久身份")
            require([item for item in runtime["treasuryCore"]["ring"]
                     if item["attemptId"] == quota["attemptId"]] == original_ring, "旧 H ring 事实漂移")
            require(snapshot["m"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] in ("off", "drain"),
                    "本轮意外重新 arm 旧 H 切片")
        return {"runId": quota["runId"], "attemptId": quota["attemptId"], "status": quota["status"],
                "snapshotCount": len(ordered)}

    def environment(self):
        initial = self.artifact("initial-environment.json")
        require(initial["schema"] == "screeps-t2-lab-environment/v1" and initial["isolatedWorldOnly"] is True and
                initial["userId"] == self.lab_account and initial["username"] == self.manifest["accountName"] and
                initial["paused"] is True, "初始隔离世界身份/停态原件不符")
        require(initial["root"] == "/srv/screeps-treasury-t1" and
                initial["run"] == "/srv/screeps-treasury-t1/r6-t2-20261002", "隔离数据库运行目录身份不符")
        packages = {item["name"]: item["version"] for item in initial["packages"]}
        require(packages == {"screeps": "4.3.0", "@screeps/engine": "4.3.0", "@screeps/common": "2.16.0"} and
                initial["node"] == "v22.22.1", "隔离引擎/运行时版本原件不符")
        require(initial["code"]["sha256"] == self.candidate_manifest.get("expectedLabSha256", self.manifest["expectedLiveSha256"]),
                "初始实验代码不是声明继承的旧构建")
        previous = initial["previousT1"]
        require(previous["control"]["status"] == "closed" and previous["quota"]["status"] == "drained" and
                previous["activeCount"] == 0, "开始时旧 H 持久责任未结")
        first = min(self.snapshots.values(), key=timestamp)
        require(previous["control"] == self.runtime(first)["treasuryT1FirstLiveControl"] and
                previous["quota"] == self.runtime(first)["treasuryProductionT1Quota"], "旧 H 初始原件与新实验没有持久连续性")
        path = self.root / "engine/environment-check-original.txt"
        raw = path.read_bytes()
        self.inputs[str(path.relative_to(self.root))] = hashlib.sha256(raw).hexdigest()
        original = raw.decode("utf-8")
        require("Id=" + self.service + "\nActiveState=active" in original and
                "WorkingDirectory=/srv/screeps-treasury-t1/server" in original,
                "实验 systemd 服务/数据库工作目录原件不符")
        require("Id=dsh.service\nActiveState=active" in original and "Id=nginx.service\nActiveState=active" in original,
                "原件未证实 dsh/nginx 正常状态")
        bindings = {line.split()[3] for line in original.splitlines() if line.startswith("LISTEN ")}
        require(bindings == {"127.0.0.1:21025", "127.0.0.1:21026", "[::1]:21027"}, "隔离 web/CLI/storage 非声明的回环监听")
        require(re.search(r"[a-f0-9]{64}  /srv/screeps-treasury-t1/r6-t2-20261002/db-before\.json", original) is not None,
                "初始停态数据库备份路径/SHA 原件缺失")
        result = {"userId": self.lab_account, "username": initial["username"], "databaseWorkingDirectory": "/srv/screeps-treasury-t1/server",
                  "service": self.service, "loopbackBindings": sorted(bindings), "node": initial["node"], "packages": packages,
                  "initialInheritedMainSha256": initial["code"]["sha256"]}
        ending = self.root / "engine/service-ending.txt"
        if ending.exists():
            ending_raw = ending.read_bytes()
            self.inputs[str(ending.relative_to(self.root))] = hashlib.sha256(ending_raw).hexdigest()
            text = ending_raw.decode("utf-8")
            require("Id=dsh.service\nActiveState=active" in text and "Id=nginx.service\nActiveState=active" in text,
                    "收尾原件未证实 dsh/nginx 保持 active")
            require("Id=" + self.service + "\nActiveState=inactive" in text, "实验服务收尾未停止")
            result["endingLabService"] = "inactive"
        return result


def verify_c1(evidence, case):
    identifier, amount = case["taskId"], case["amount"]
    setup = evidence.synthetic_setup(case["setup"], identifier, amount)
    before, native, confirmed, recovered = [evidence.snap(case[key])
                                            for key in ("before", "native", "confirmed", "recovered")]
    for snapshot in (before, native, confirmed, recovered):
        require(snapshot["m"]["cfg"]["resourceControl"]["enabled"] is True,
                "C1 未通过已启用的普通 production 入口运行")
    purpose = evidence.synthesis_purpose(before, amount)
    native_driver = evidence.driver_between(case["prefix"] + "-native-driver-driver.json", before, native, kind="native")
    settle_driver = evidence.driver_between(case["prefix"] + "-settle-driver-driver.json", native, confirmed, kind="settled")
    repeat_driver = evidence.driver_between(case["prefix"] + "-repeat-recovery-driver-driver.json", confirmed, recovered, 2, kind="ticks")
    quota, transaction, actual_fee = evidence.native(before, native, identifier, amount)
    committed_entry = evidence.committed(confirmed, identifier, amount, quota, before)
    require(evidence.new_transactions(native, confirmed) == [], "首次确认时段有其它真实交易")
    require(evidence.committed(recovered, identifier, amount, quota, before) == committed_entry,
            "重复恢复修改原 attempt 唯一终态")
    require(evidence.new_transactions(confirmed, recovered) == [], "重复恢复重发/推进普通业务")
    require(evidence.control(confirmed) == evidence.control(recovered), "重复恢复重新打开授权")
    result = {"syntheticSetup": setup, "synthesisPurpose": purpose,
              "actualDrivers": [native_driver, settle_driver, repeat_driver],
              "attemptId": quota["attemptId"], "transactionId": transaction["_id"],
              "treasuryAmount": 100, "actualEnergyFee": actual_fee, "remainingAfterFirstSettlement": amount - 100,
              "nativeDelta": 1, "settlementDelta": 1, "repeatRecoveryNoRededuction": True}
    if amount > 100:
        final = evidence.snap(case["ordinary"])
        result["actualDrivers"].append(evidence.driver_between(case["prefix"] + "-ordinary-driver-driver.json", recovered, final, kind="task-done"))
        ordinary_transactions = evidence.new_transactions(recovered, final)
        require(len(ordinary_transactions) == 1, "C1 余量交回时段并非唯一普通交易")
        ordinary = ordinary_transactions[0]
        evidence.ordinary(ordinary, identifier, amount - 100, SOURCE, TARGET)
        require(ordinary["time"] > transaction["time"], "普通余量交易未在 T2 后接续")
        evidence.transaction_store_deltas(recovered, final, ordinary_transactions, checked_resources={RESOURCE})
        task = evidence.task(final, identifier)
        require(task["status"] == "done" and task["remainingAmount"] == 0 and "treasurySlice" not in task,
                "旧普通路径未完成交回余量")
        require(evidence.runtime(final)[QUOTA_KEY] == {**quota, "status": "drained"}, "普通接续改变已消费额度")
        require(evidence.control(final) == evidence.control(confirmed), "普通接续重新打开 T2 授权")
        require(final["m"]["cfg"][CONFIG_KEY]["mode"] == "off", "普通接续时 T2 不再默认 OFF")
        kernel = evidence.runtime(final)["treasuryCore"]
        require(not kernel["active"] and [item for item in kernel["ring"] if item["attemptId"] == quota["attemptId"]] == [committed_entry],
                "普通接续改变原结算责任")
        require(len([item for item in evidence.new_transactions(before, final) if item["description"].startswith(PREFIX)]) == 1,
                "国库总量不是唯一 100 UH")
        result.update({"ordinaryTransactionId": ordinary["_id"], "ordinaryAmount": amount - 100,
                       "totalBusinessAmount": amount, "finalRemaining": 0,
                       "sourceEnergyChangeDuringOrdinaryHandoff": evidence.store(evidence.terminal(final, SOURCE), "energy") -
                           evidence.store(evidence.terminal(recovered, SOURCE), "energy"),
                       "energyScope": "国库本片费用由 native 原件严格重导；交回后的普通业务可伴随正常 carrier Energy 动作"})
    else:
        result["finalRemaining"] = 0
    return result


def verify_c2(evidence):
    identifier = "lab-t2-c2-UH"
    setup = evidence.synthetic_setup("c2-setup-setup.json", identifier, 100)
    baseline = evidence.snap("c2-ordinary-pre-baseline")
    observed = evidence.snap("c2-ordinary-pre-observed")
    bound = evidence.snap("c2-bound-after-ordinary-pre")
    native = evidence.snap("c2-real-native")
    first_settlement = evidence.snap("c2-first-restored-settlement")
    final = evidence.snap("c2-confirmed-ordinary-and-carrier-restored")
    pre_artifacts = [evidence.artifact("c2-pre-" + endpoint + "-ordinary.json") for endpoint in ("source", "target")]
    pre_transactions = evidence.new_transactions(baseline, observed)
    require(len(pre_transactions) == 2, "C2 两端 ordinary-pre 非两笔真实交易")
    require({item["destination"] for item in pre_artifacts} == {SOURCE, TARGET}, "C2 未覆盖新两端")
    for artifact in pre_artifacts:
        require(artifact["isolatedWorldOnly"] is True and artifact["sender"] not in (SOURCE, TARGET), "C2 非第三房普通入库")
        matches = [item for item in pre_transactions if item["description"] == "resourceControl:task:" + artifact["id"]]
        require(len(matches) == 1, "C2 普通先行交易非唯一")
        evidence.ordinary(matches[0], artifact["id"], 100, artifact["sender"], artifact["destination"], artifact["resource"])
        task = evidence.task(observed, artifact["id"])
        require(task["status"] == "done" and task["remainingAmount"] == 0, "ordinary-pre 业务未完成")
    evidence.transaction_store_deltas(baseline, observed, pre_transactions, checked_resources={"H"})
    require(all(key not in evidence.runtime(observed) for key in (CONTROL_KEY, MIRROR_KEY)), "ordinary-pre 时已先绑定 T2 活动")
    pre_driver = evidence.driver_between("c2-conflict-driver-driver.json", baseline, observed, kind="pre-inbound")
    require(evidence.control(bound)["status"] == "active", "ordinary 先行后未通过正式 arm 新鲜绑定")
    require(evidence.new_transactions(observed, bound) == [], "ordinary-pre 与正式绑定之间又发生 native")
    require(QUOTA_KEY not in evidence.runtime(observed) and not evidence.runtime(observed)["treasuryCore"]["active"],
            "ordinary 先行时 T2 提前接纳/消费额度")
    t2_task = evidence.task(observed, identifier)
    require(t2_task["status"] == "pending" and t2_task["remainingAmount"] == 100 and "treasurySlice" not in t2_task,
            "ordinary 先行时 T2 任务被提前推进")
    require(QUOTA_KEY not in evidence.runtime(bound) and not evidence.runtime(bound)["treasuryCore"]["active"], "绑定后 native 前已接纳责任")
    quota, transaction, actual_fee = evidence.native(bound, native, identifier, 100)
    purpose = evidence.synthesis_purpose(observed, 100)
    native_driver = evidence.driver_between("c2-native-driver-driver.json", bound, native, kind="native")
    require(transaction["time"] > max(item["time"] for item in pre_transactions), "T2 未在真实两端 ordinary-pre 后接纳")
    fault = evidence.artifact("c2-inject-contradiction-fault.json")
    restore = evidence.artifact("c2-restore-true-store-restore.json")
    target_native = evidence.terminal(native, TARGET)
    require(fault["isolatedWorldOnly"] is True and fault["kind"] == "target-UH-contradiction" and
            fault["terminalId"] == target_native["_id"], "未知确认故障不是指定实验目标 UH Store 矛盾")
    require(fault["beforeUH"] == evidence.store(target_native, RESOURCE) and
            fault["afterUH"] == fault["readbackUH"] == fault["beforeUH"] + 1, "故障实际注入/读回不符")
    require(fault["rawMemory"] == native["rawMemory"] and fault["transactionCount"] == len(native["transactions"]),
            "故障边界 Memory/transaction 原件漂移")
    held_labels = ("c2-unknown-off-held", "c2-unrelated-native-while-unknown", "c2-carrier-target-held",
                   "c2-carrier-source-held", "c2-unknown-after-real-restart", "c2-carrier-source-after-reset-held")
    held_snapshots = [evidence.snap(label) for label in held_labels]
    blocked_artifacts = [evidence.artifact("c2-block-" + endpoint + "-ordinary.json") for endpoint in ("source", "target")]
    for snapshot in held_snapshots:
        evidence.held(snapshot, identifier, 100, quota, native)
        require(evidence.store(evidence.terminal(snapshot, TARGET), RESOURCE) == fault["readbackUH"],
                "未知阶段故障未保留/被手改成确认实货")
        require(evidence.store(evidence.terminal(snapshot, SOURCE), RESOURCE) ==
                evidence.store(evidence.terminal(native, SOURCE), RESOURCE), "未知 fence 期间源 UH 发生外来改变")
        for artifact in blocked_artifacts:
            task = evidence.task(snapshot, artifact["id"])
            require(task["status"] == "pending" and task["remainingAmount"] == 100 and task["lastError"] == "send_code_-4",
                    "T2 先接纳后新两端普通入库未真实受保护")
        after_native = evidence.new_transactions(native, snapshot)
        require(not [item for item in after_native if item["description"].startswith(PREFIX)], "未知恢复重发 T2")
        require(not [item for item in after_native if item["description"] in
                     {"resourceControl:task:" + artifact["id"] for artifact in blocked_artifacts}], "未知阶段 fence 放过相关 ordinary")
        for room in (SOURCE, TARGET):
            require(evidence.store(evidence.terminal(snapshot, room), "energy") ==
                    evidence.store(evidence.terminal(native, room), "energy"), "未知 fence 期间两端发生 cargo Energy 改变")
            require(evidence.store(evidence.terminal(snapshot, room), "H") ==
                    evidence.store(evidence.terminal(native, room), "H"), "未知 fence 期间两端发生 ordinary/carrier H 改变")
    request_off = evidence.artifact("c2-request-off-queue.json")
    require(request_off["expression"] == 'Memory.cfg.treasuryTerminalTransferT2.mode="off"', "OFF 请求原件不符")
    unrelated = held_snapshots[1]
    unrelated_artifact = evidence.artifact("c2-unrelated-ordinary.json")
    unrelated_transactions = evidence.new_transactions(native, unrelated)
    require(len(unrelated_transactions) == 1, "未知期间无关路径非唯一真实 ordinary")
    unrelated_transaction = unrelated_transactions[0]
    evidence.ordinary(unrelated_transaction, unrelated_artifact["id"], 100, "E3N59", "W8N8", "H")
    unrelated_task = evidence.task(unrelated, unrelated_artifact["id"])
    require(unrelated_task["status"] == "done" and unrelated_task["remainingAmount"] == 0, "无关旧 H 端点普通业务被误锁")
    # 两端各有独立合成已持 H 的真实 creep；克隆/装夹不是自然 pickup 或 spawn 证据。
    carrier_artifacts = {}
    carrier_traces = []
    for endpoint, room, snapshot in (("target", TARGET, held_snapshots[2]), ("source", SOURCE, held_snapshots[3])):
        artifact = evidence.artifact("c2-carrier-" + endpoint + "-carrier.json")
        carrier_artifacts[endpoint] = artifact
        require(artifact["isolatedWorldOnly"] is True and artifact["kind"] == "synthetic-already-carried-50-H" and
                artifact["resource"] == "H" and artifact["after"]["store"].get("H") == 50,
                "carrier 非声明的合成已持 H 装夹")
        carrier = evidence.obj(snapshot, artifact["after"]["_id"])
        terminal = evidence.obj(snapshot, artifact["targetTerminalId"])
        require((carrier["type"], carrier["user"], carrier["room"]) == ("creep", evidence.lab_account, room), "carrier 实体/端点不符")
        require(terminal["room"] == room and terminal["type"] == "terminal", "carrier 原计划目标非对应 terminal")
        require(carrier["name"] == artifact["name"] and evidence.store(carrier, "H") == 50 and
                snapshot["tick"] > artifact["tick"], "真实 carrier 执行后未保留实货")
        require(max(abs(carrier["x"] - terminal["x"]), abs(carrier["y"] - terminal["y"])) <= 1,
                "carrier 未在真实可交付距离检验保护")
        creep_memory = snapshot["m"]["creeps"][carrier["name"]]
        require(creep_memory["role"] == "carrier" and creep_memory["ready"] is True and creep_memory["working"] is True,
                "非真实 carrier role 可执行状态")
        plan = evidence.artifact("c2-carrier-" + endpoint + "-plan-queue.json")
        require(f"Game.rooms.{room}.terminal.id" in plan["expression"] and
                'synthesisCarrierPendingResource:"H"' in plan["expression"] and
                'synthesisCarrierPendingTaskType:"terminal_feed"' in plan["expression"], "carrier 实验交付计划原件不符")
        previous = unrelated if endpoint == "target" else held_snapshots[2]
        carrier_traces.append(evidence.carrier_held_trace(previous, snapshot, artifact,
                              "c2-carrier-" + endpoint + "-driver-driver.json", require_prestate=False))
    carrier_ids = {endpoint: artifact["after"]["_id"] for endpoint, artifact in carrier_artifacts.items()}
    require(len(set(carrier_ids.values())) == 2, "两端 carrier 不是两只独立声明 creep")
    restarted, after_reset_held = held_snapshots[4], held_snapshots[5]
    restart_driver = evidence.driver_between("c2-post-restart-driver-driver.json", held_snapshots[3], restarted, 2, kind="ticks")
    post_reset_driver = evidence.driver_between("c2-carrier-source-post-reset-driver-driver.json", restarted, after_reset_held, 2, kind="ticks")
    require(timestamp(restarted) * 1000 > evidence.control(native)["controlUntilMs"], "未知责任没有真实超过 60 秒失联")
    restart = evidence.real_restart(held_snapshots[3], restarted)
    require(evidence.new_transactions(held_snapshots[3], restarted) == [], "未知真实重启发生新 native")
    for carrier_id in carrier_ids.values():
        require(evidence.store(evidence.obj(restarted, carrier_id), "H") == 50, "真实重启后物理 cargo 丢失")
    source_plan = evidence.artifact("c2-carrier-source-plan-queue.json")
    target_plan = evidence.artifact("c2-carrier-target-plan-queue.json")
    reset_plan = evidence.artifact("c2-carrier-source-plan-after-reset-queue.json")
    require(all(f'global.__creepAssignmentState["{artifact["name"]}"]=' in reset_plan["expression"]
                for artifact in carrier_artifacts.values()), "reset 后没有重建原两只 carrier 实验计划")
    for carrier_id in carrier_ids.values():
        require(evidence.store(evidence.obj(after_reset_held, carrier_id), "H") == 50,
                "reset 后 fence 未继续保持 cargo/原 attempt")
    require(evidence.new_transactions(restarted, after_reset_held) == [], "reset 后 fence 期间发生新 native")
    for artifact in carrier_artifacts.values():
        carrier_traces.append(evidence.carrier_held_trace(restarted, after_reset_held, artifact,
                              "c2-carrier-source-post-reset-driver-driver.json", require_prestate=False))
    require(restore["isolatedWorldOnly"] is True and restore["kind"] == fault["kind"] and
            restore["terminalId"] == fault["terminalId"] and
            restore["beforeUH"] == fault["readbackUH"] and restore["afterUH"] == restore["readbackUH"] == fault["beforeUH"],
            "没有只撤除真实实验 Store 故障")
    require(restore["rawMemory"] == after_reset_held["rawMemory"] and
            restore["transactionCount"] == len(after_reset_held["transactions"]), "撤故障前持久责任/交易原件漂移")
    first_entry = evidence.committed(first_settlement, identifier, 100, quota, bound)
    settle_driver = evidence.driver_between("c2-restored-settle-driver-driver.json", after_reset_held, first_settlement, kind="settled")
    require(evidence.committed(final, identifier, 100, quota, bound) == first_entry, "恢复后原 attempt 再结算")
    restored_transactions = evidence.new_transactions(after_reset_held, final)
    require(len(restored_transactions) == 2, "fence 交回后相关普通业务不是两笔真实交易")
    for artifact in blocked_artifacts:
        matches = [item for item in restored_transactions if item["description"] == "resourceControl:task:" + artifact["id"]]
        require(len(matches) == 1, "交回普通业务交易非唯一")
        evidence.ordinary(matches[0], artifact["id"], 100, artifact["sender"], artifact["destination"], artifact["resource"])
        task = evidence.task(final, artifact["id"])
        require(task["status"] == "done" and task["remainingAmount"] == 0, "fence 交回后普通业务未恢复")
    for carrier_id in carrier_ids.values():
        require(evidence.store(evidence.obj(final, carrier_id), "H") == 0, "fence 交回后 carrier 未交付 50 H 实货")
    evidence.transaction_store_deltas(after_reset_held, final, restored_transactions,
                                     {(SOURCE, "H"): 50, (TARGET, "H"): 50}, checked_resources={"H"})
    require(len([item for item in evidence.new_transactions(bound, final) if item["description"].startswith(PREFIX)]) == 1,
            "C2 原 attempt 非唯一真实 T2 native")
    require(final["m"]["cfg"]["treasuryTerminalTransferSlice0"]["mode"] == "off", "C2最终未交回旧 H OFF")
    return {"syntheticSetup": setup, "synthesisPurpose": purpose,
            "actualDrivers": [pre_driver, native_driver, restart_driver, post_reset_driver, settle_driver],
            "attemptId": quota["attemptId"], "transactionId": transaction["_id"],
            "treasuryAmount": 100, "actualEnergyFee": actual_fee, "ordinaryBeforeT2": [item["_id"] for item in pre_transactions],
            "unknownUnrelatedOrdinary": unrelated_transaction["_id"], "ordinaryAfterRelease": [item["_id"] for item in restored_transactions],
            "nativeDelta": 1, "settlementDelta": 1, "originalAttemptHeldAfterOffAndLoss": True,
            "systemdRestart": restart, "carrier": {"kind": "两只独立合成已持货 50 H 的真实 creep",
                "heldRooms": [TARGET, SOURCE], "actualDeliveredRooms": [TARGET, SOURCE], "deliveredAmountEach": 50,
                "experimentBothPlansRestoredAfterReset": True,
                "actualDelegatedWork": carrier_traces,
                "limitation": "只证明合成持货保护与解除交付；不证明自然 spawn/pickup 或 global 计划跨 reset 持久性"}}


def verify_carrier_supplement(evidence):
    branch = "c2-carrier-prestate-supplement"
    before, held, settled, released = [evidence.snap(branch + "-" + suffix)
                                      for suffix in ("before", "held", "settled", "released")]
    instance = evidence.artifact(branch + "-instance.json")
    require(instance["schema"] == "screeps-t2-carrier-trace-supplement-instance/v1" and
            instance["isolatedWorldOnly"] is True and instance["mainSha256"] == evidence.sha,
            "carrier 补充分支实例/最终 main 身份不符")
    native = evidence.snap("c2-real-native")
    bound = evidence.snap("c2-bound-after-ordinary-pre")
    quota = evidence.runtime(native)[QUOTA_KEY]
    primary_source = evidence.artifact("c2-unknown-restart-before-persistence-snapshot.json")
    require(primary_source["code"] == {"sha256": evidence.sha, "bytes": len(evidence.main)} and
            primary_source["user"]["_id"] == evidence.lab_account and primary_source["paused"] is True,
            "补充分支源快照不是原 C2 同构建实验状态")
    require(hashlib.sha256(primary_source["rawMemory"].encode()).hexdigest() == instance["sourceMemorySha256"] ==
            hashlib.sha256(before["rawMemory"].encode()).hexdigest(), "补充分支不是原 C2 实际未知 Memory 副本")
    require(instance["sourcePrivateDatabase"] == "/srv/screeps-treasury-t1/r6-t2-20261002/db-before-c2-unknown-restart.json" and
            re.fullmatch(r"[a-f0-9]{64}", instance["sourceDatabaseSha256"]) is not None,
            "补充分支没有标明真实未知期私有数据库身份")
    native_transactions = [item for item in native["transactions"] if item["description"] == PREFIX + quota["attemptId"]]
    require(len(native_transactions) == 1, "原 C2 native 交易不唯一")
    transaction = native_transactions[0]
    require((instance["originalAttemptId"], instance["originalWorkKey"], instance["originalNativeTransactionId"], instance["originalNativeAtTick"]) ==
            (quota["attemptId"], quota["workKey"], transaction["_id"], transaction["time"]), "补充分支不是同一原 attempt/真实交易")
    require(evidence.new_transactions(primary_source, before) == [], "补充分支复制期间改变原交易")
    source_objects = {item["_id"]: item for item in primary_source["objects"] if item.get("user") == evidence.lab_account}
    before_objects = {item["_id"]: item for item in before["objects"] if item.get("user") == evidence.lab_account}
    require(source_objects.keys() == before_objects.keys() and
            all(source_objects[identifier].get("store") == before_objects[identifier].get("store")
                for identifier in source_objects), "补充分支启动时实货不是原 C2 数据库副本")
    for snapshot in (before, held):
        evidence.held(snapshot, "lab-t2-c2-UH", 100, quota, native)
        require(evidence.store(evidence.terminal(snapshot, TARGET), RESOURCE) == 101,
                "补充分支没有保留真实 target UH +1 未知故障")
    require(evidence.new_transactions(before, held) == [], "v2 持货保护补证期间产生 native")
    traces = []
    carrier_artifacts = [evidence.artifact("c2-carrier-" + endpoint + "-carrier.json") for endpoint in ("source", "target")]
    for artifact in carrier_artifacts:
        traces.append(evidence.carrier_held_trace(before, held, artifact, branch + "-held-driver-driver.json", minimum_ticks=3))
        require(evidence.store(evidence.obj(before, artifact["after"]["_id"]), "H") ==
                evidence.store(evidence.obj(held, artifact["after"]["_id"]), "H") == 50,
                "v2 补证时原物理 H 持货丢失")
    for room in (SOURCE, TARGET):
        require(evidence.store(evidence.terminal(before, room), "H") == evidence.store(evidence.terminal(held, room), "H"),
                "v2 受保护真实执行点泄漏 H cargo")
    restore = evidence.artifact(branch + "-restore-restore.json")
    require(restore["kind"] == "target-UH-contradiction" and restore["beforeUH"] == 101 and
            restore["afterUH"] == restore["readbackUH"] == 100 and restore["rawMemory"] == held["rawMemory"],
            "补充分支未只撤除原实验 Store 故障")
    settle_driver = evidence.driver_between(branch + "-settle-driver-driver.json", held, settled, kind="settled")
    release_driver = evidence.driver_between(branch + "-release-driver-driver.json", settled, released, 5, kind="ticks")
    first_entry = evidence.committed(settled, "lab-t2-c2-UH", 100, quota, bound)
    require(evidence.committed(released, "lab-t2-c2-UH", 100, quota, bound) == first_entry, "补充分支重扣原 attempt")
    new_transactions = evidence.new_transactions(before, released)
    require(not [item for item in new_transactions if item["description"].startswith(PREFIX)], "补充分支重发国库 native")
    require(all(item["description"].startswith("resourceControl:task:") for item in new_transactions), "补充分支有未解释外来交易")
    release_work = []
    for artifact in carrier_artifacts:
        require(evidence.store(evidence.obj(released, artifact["after"]["_id"]), "H") == 0, "补充分支解除后原 H cargo 未交付")
        events = [item for item in evidence.runtime(released)["__labT2CarrierWork"] if item["name"] == artifact["name"] and
                  held["tick"] <= item["tick"] < released["tick"] and item.get("traceSchemaVersion") == 2 and
                  item.get("role") == "carrier" and item.get("ready") is True and item.get("working") is True and
                  item.get("spawnYield", "missing") is None and item.get("configName", "missing") is None and
                  item.get("throwError", "missing") is None and item["beforeH"] == 50]
        require(events, "解除后没有 v2 真实调用前 carrier target 状态记录")
        release_work.append({"name": artifact["name"], "actualWorkTicks": sorted({item["tick"] for item in events}),
                             "scope": "v2 调用前 role 状态；成功清 plan 后 toId 可空，实际目的地由 H Store 差值证明"})
    evidence.transaction_store_deltas(before, released, new_transactions,
                                     {(SOURCE, "H"): 50, (TARGET, "H"): 50}, checked_resources={"H"})
    return {"scope": "原 C2 实际未知 DB 的独立补充分支；不合并为原连续世界，不叠加 native/结算数量",
            "sourceDatabaseSha256": instance["sourceDatabaseSha256"], "originalAttemptId": quota["attemptId"],
            "originalNativeTransactionId": transaction["_id"], "newTreasuryNative": 0,
            "actualHeldTargetWork": traces, "actualReleaseWork": release_work,
            "actualDrivers": [settle_driver, release_driver], "actualHDeliveredEach": 50}


def verify_c3(evidence):
    identifier = "lab-t2-c3-UH"
    setup = evidence.synthetic_setup("c3-setup-setup.json", identifier, 100)
    armed, expired, restarted = [evidence.snap(label) for label in
                                 ("c3-armed-bound-no-responsibility", "c3-expired-ordinary-restored", "c3-off-after-real-restart")]
    rearmed = evidence.snap("c3-rearm-rejected")
    initial_control = evidence.control(armed)
    purpose = evidence.synthesis_purpose(armed, 100)
    require(initial_control["status"] == "active" and initial_control["taskId"] == identifier and
            armed["m"]["cfg"]["resourceControl"]["enabled"] is False, "C3 非已绑定尚未接纳活动")
    require(evidence.task(armed, identifier)["status"] == "pending" and evidence.task(armed, identifier)["remainingAmount"] == 100,
            "C3 arm 后任务已提前推进")
    require(timestamp(armed) * 1000 < initial_control["controlUntilMs"], "C3 初始 capture 已过期")
    require(timestamp(expired) * 1000 > initial_control["lastHeartbeatAtMs"] + 60_000 and
            timestamp(expired) - timestamp(armed) > 60, "C3 没有真实超过 60 秒失联原件")
    for snapshot in (armed, expired, restarted, rearmed):
        require(QUOTA_KEY not in evidence.runtime(snapshot) and not evidence.runtime(snapshot)["treasuryCore"]["active"] and
                "treasurySlice" not in evidence.task(snapshot, identifier), "C3 存在接纳/未结责任")
    ending_control = evidence.control(expired)
    require(ending_control["status"] == "closed" and ending_control["closeReason"] == "control_lease_expired" and
            expired["m"]["cfg"][CONFIG_KEY]["mode"] == "off", "C3 未自动 lease expired / closed / OFF")
    preserved_fields = lambda control: {key: value for key, value in control.items() if key not in ("hash", "status", "closeReason")}
    require(preserved_fields(initial_control) == preserved_fields(ending_control), "C3 失联期间授权事实被手造/延长")
    enable = evidence.artifact("c3-enable-ordinary-queue.json")
    require(enable["expression"] == "Memory.cfg.resourceControl.enabled=true", "C3 操作员额外 close 或手写 mode")
    arm_queue = evidence.artifact("c3-arm-queue.json")
    require(f'armTreasuryT2FirstLive("{identifier}",' in arm_queue["expression"], "C3 非正式 arm 入口")
    for path in sorted(evidence.directory.glob("c3-*-queue.json")):
        expression = evidence.artifact(path.name)["expression"]
        require(not re.search(r"closeTreasury|treasuryTerminalTransferT2\.mode\s*=|treasuryT2FirstLiveControl\s*=|treasuryProductionT2Quota\s*=", expression),
                "C3 queued expression 含人工 close/mode/control/quota 写入")
    ordinary_transactions = evidence.new_transactions(armed, expired)
    require(len(ordinary_transactions) == 1, "C3 自动交回后非唯一普通真实机会")
    ordinary_transaction = ordinary_transactions[0]
    evidence.ordinary(ordinary_transaction, identifier, 100, SOURCE, TARGET)
    evidence.transaction_store_deltas(armed, expired, ordinary_transactions)
    for snapshot in (expired, restarted):
        task = evidence.task(snapshot, identifier)
        require(task["status"] == "done" and task["remainingAmount"] == 0 and
                snapshot["m"]["cfg"][CONFIG_KEY]["mode"] == "off", "C3 普通完成/默认 OFF 未保留")
    restart = evidence.real_restart(expired, restarted)
    ordinary_driver = evidence.driver_between("c3-expired-ordinary-driver-driver.json", armed, expired, kind="task-done")
    restart_driver = evidence.driver_between("c3-restart-driver-driver.json", expired, restarted, 4, kind="ticks")
    require(evidence.new_transactions(expired, restarted) == [] and evidence.control(restarted) == ending_control,
            "C3 真实重启重新开活动/发送")
    rearm_queue = evidence.artifact("c3-rearm-after-close-queue.json")
    require(rearm_queue["expression"] == f'Memory.runtime.__labT2RearmResult=armTreasuryT2FirstLive("{identifier}",{setup["createdAt"]})',
            "闭合后重开检验不是同一官方 arm 身份入口")
    rearm_driver = evidence.driver_between("c3-rearm-rejected-driver-driver.json", restarted, rearmed, kind="ticks")
    rearm_return = evidence.runtime(rearmed)["__labT2RearmResult"]
    require(rearm_return == {"ok": False, "reason": "already_used_or_unsettled"}, "已关闭授权没有拒绝重开")
    require(evidence.control(rearmed) == ending_control and rearmed["m"]["cfg"][CONFIG_KEY]["mode"] == "off" and
            evidence.task(rearmed, identifier) == evidence.task(restarted, identifier) and
            evidence.new_transactions(restarted, rearmed) == [], "拒绝重开后原闭合事实/任务/交易改变")
    before_counters, after_counters = [evidence.runtime(snapshot)["treasuryCore"]["counters"] for snapshot in (armed, rearmed)]
    require(all(before_counters[key] == after_counters[key] for key in ("dispatched", "settledCommitted")),
            "C3 无责任退出仍推进 kernel native/结算")
    return {"syntheticSetup": setup, "synthesisPurpose": purpose, "actualDrivers": [ordinary_driver, restart_driver, rearm_driver],
            "ordinaryTransactionId": ordinary_transaction["_id"], "nativeT2": 0,
            "observedLossSeconds": round(timestamp(expired) - timestamp(armed), 3),
            "closeReason": ending_control["closeReason"], "automaticClosedOff": True,
            "operatorCloseOrModeWrite": False, "systemdRestart": restart, "closedRestartNoResend": True,
            "sameIdentityRearmRejected": rearm_return}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    main_input = parser.add_mutually_exclusive_group(required=True)
    main_input.add_argument("--candidate", type=Path, help="包含最终 main.js 的候选目录")
    main_input.add_argument("--main-path", type=Path, help="最终 main.js 的绝对路径；ZIP 可只保留根 candidate 一份")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--snapshot-schema", default="screeps-t2-first-production-engine-snapshot/v1")
    parser.add_argument("--lab-account", default="7dad41a4bfc9d96")
    parser.add_argument("--service", default="screeps-treasury-t1.service")
    parser.add_argument("--c1-1715-prefix", default="c1-1715-r4", help="明确采用的1715独立实例标签；校准/失败原件不计通过")
    parser.add_argument("--c1-100-prefix", default="c1-100", help="明确采用的100独立实例标签；校准/失败原件不计通过")
    args = parser.parse_args()
    for prefix, expected in ((args.c1_1715_prefix, "c1-1715"), (args.c1_100_prefix, "c1-100")):
        require(re.fullmatch(re.escape(expected) + r"(?:-r[2-9][0-9]*)?", prefix) is not None,
                "C1 标签不是指定独立实例类型/重试边界")
    labels = [label.replace("c1-1715-", args.c1_1715_prefix + "-", 1) if label.startswith("c1-1715-") else
              label.replace("c1-100-", args.c1_100_prefix + "-", 1) if label.startswith("c1-100-") else label
              for label in FINAL_LABELS]
    evidence = Evidence(args.root, args.main_path or args.candidate, args.manifest or args.root / "release-manifest-T2.json",
                        args.snapshot_schema, args.lab_account, args.service, labels)
    def c1_case(prefix, amount):
        result = {"prefix": prefix, "taskId": "lab-t2-" + prefix + "-UH", "amount": amount,
                  "setup": prefix + "-setup-setup.json", "before": prefix + "-before-native",
                  "native": prefix + "-real-native", "confirmed": prefix + "-first-settlement",
                  "recovered": prefix + "-recovered-no-rededuct"}
        if amount > 100:
            result["ordinary"] = prefix + "-ordinary-restored"
        return result
    c1 = {"1715": verify_c1(evidence, c1_case(args.c1_1715_prefix, 1715)),
          "100": verify_c1(evidence, c1_case(args.c1_100_prefix, 100))}
    c2 = verify_c2(evidence)
    c3 = verify_c3(evidence)
    carrier_supplement = verify_carrier_supplement(evidence)
    legacy = evidence.legacy_preserved()
    environment = evidence.environment()
    result = {"schema": "screeps-t2-first-production-engine-verification/v1", "passed": True,
              "scope": "同一最终 main 的隔离引擎 C1/C2/C3；不据此宣称正式生产首片通过",
              "mainSha256": evidence.sha, "mainBytes": len(evidence.main),
              "labAccountId": evidence.lab_account, "labService": evidence.service,
              "inputSnapshotCount": len(evidence.snapshots), "verifiedScenarioSnapshotLabels": evidence.labels,
              "nonAdoptedSnapshots": evidence.non_adopted_snapshots, "environment": environment,
              "C1": c1, "C2": c2, "C3": c3, "carrierPrestateSupplement": carrier_supplement,
              "inheritedHDrainedFactsPreserved": legacy,
              "rawInputSha256": evidence.inputs}
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()

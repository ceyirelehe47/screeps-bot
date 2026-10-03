import {
  sortWorkStatusViews,
  type TaskSystemAdapter,
  type TaskSystemAdapterResult,
  type WorkActivity,
  type WorkAuthorityRef,
  type WorkProjectionIssue,
  type WorkStatusView,
} from "@/runtime/taskSystem/model";

const WAR_NAMESPACE = "warControl";
const ROOM_NAME_PATTERN = /^[WE]\d+[NS]\d+$/;

const WAR_STATUSES = new Set([
  "queued",
  "staging",
  "clearing",
  "downgrading",
  "patrol_waiting",
  "done",
  "failed",
]);

const WAR_GENERATION_PHASES = new Set(["preparing", "assembling", "deployed"]);
const WAR_REASONS = new Set(["npc_reservation", "manual"]);
const WAR_SQUADS = new Set(["standard", "t3Duo", "towerDrainDuo"]);
const WAR_BOOST_TIERS = new Set(["t3"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function ownValue(record: UnknownRecord, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
}

function issue(code: string, message: string, field?: string): WorkProjectionIssue {
  return field === undefined ? { code, message } : { code, message, field };
}

function optionalFiniteNumber(
  record: UnknownRecord,
  field: string,
  issues: WorkProjectionIssue[],
): { value?: number; malformed: boolean } {
  const value = ownValue(record, field);
  if (value === undefined) return { malformed: false };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { value, malformed: false };
  }
  issues.push(issue("war-invalid-number", `${field} must be a finite non-negative number`, field));
  return { malformed: true };
}

function activityForStatus(status: string, blocker: string | undefined): WorkActivity {
  if (status === "done" || status === "failed") return "terminal";
  if (blocker) return "blocked";
  if (status === "queued") return "available";
  if (WAR_STATUSES.has(status)) return "running";
  return "unknown";
}

interface WarGenerationProjection {
  readonly authorities: readonly WorkAuthorityRef[];
  readonly malformed: boolean;
}

function projectGeneration(
  generationValue: unknown,
  issues: WorkProjectionIssue[],
): WarGenerationProjection {
  if (generationValue === undefined) {
    return { authorities: [], malformed: false };
  }
  if (!isRecord(generationValue)) {
    issues.push(issue(
      "war-malformed-generation",
      "activeGeneration must be an object",
      "activeGeneration",
    ));
    return { authorities: [], malformed: true };
  }

  let malformed = false;
  const id = ownValue(generationValue, "id");
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    issues.push(issue(
      "war-invalid-generation-id",
      "activeGeneration.id must be a non-negative integer",
      "activeGeneration.id",
    ));
    malformed = true;
  }

  const phase = ownValue(generationValue, "phase");
  if (typeof phase !== "string" || !WAR_GENERATION_PHASES.has(phase)) {
    issues.push(issue(
      "war-unknown-generation-phase",
      "activeGeneration.phase is not recognized",
      "activeGeneration.phase",
    ));
    malformed = true;
  }

  const boostTaskId = ownValue(generationValue, "boostTaskId");
  if (typeof boostTaskId !== "string" || boostTaskId.length === 0) {
    issues.push(issue(
      "war-invalid-boost-owner",
      "activeGeneration.boostTaskId must be a non-empty string",
      "activeGeneration.boostTaskId",
    ));
    malformed = true;
  }

  const configNames = ownValue(generationValue, "configNames");
  if (!isRecord(configNames)) {
    issues.push(issue(
      "war-malformed-generation-configs",
      "activeGeneration.configNames must be an object",
      "activeGeneration.configNames",
    ));
    malformed = true;
  }

  const generation = typeof id === "number" && Number.isInteger(id) && id >= 0
    ? id
    : undefined;
  const authorities: WorkAuthorityRef[] = [];
  let attackerConfigName: string | undefined;
  let healerConfigName: string | undefined;
  if (typeof boostTaskId === "string" && boostTaskId.length > 0) {
    authorities.push({
      role: "lease_owner",
      id: boostTaskId,
      generation,
      component: "boost",
    });
  }

  if (isRecord(configNames)) {
    for (const component of ["meleeAttacker", "healer"] as const) {
      const configName = ownValue(configNames, component);
      if (typeof configName === "string" && configName.length > 0) {
        if (component === "meleeAttacker") attackerConfigName = configName;
        else healerConfigName = configName;
        authorities.push({ role: "executor", id: configName, generation, component });
      } else {
        issues.push(issue(
          "war-invalid-generation-config",
          `activeGeneration.configNames.${component} must be a non-empty string`,
          `activeGeneration.configNames.${component}`,
        ));
        malformed = true;
      }
    }
  }
  if (
    attackerConfigName !== undefined
    && healerConfigName !== undefined
    && attackerConfigName === healerConfigName
  ) {
    issues.push(issue(
      "war-generation-component-identity-conflict",
      "active generation attacker and healer must not share one config identity",
      "activeGeneration.configNames",
    ));
    malformed = true;
  }

  return { authorities, malformed };
}

function projectWarEntry(
  localId: string,
  value: unknown,
): { entry?: WorkStatusView; invalidIssue?: WorkProjectionIssue } {
  if (!isRecord(value)) {
    return {
      invalidIssue: issue(
        "war-unprojectable-record",
        `war record ${localId} cannot prove its source room`,
      ),
    };
  }

  const sourceRoom = ownValue(value, "sourceRoom");
  const targetRoom = ownValue(value, "targetRoom");
  if (!isRoomName(sourceRoom) || !isRoomName(targetRoom) || localId.length === 0) {
    return {
      invalidIssue: issue(
        "war-unprojectable-identity",
        `war record ${localId || "<empty>"} lacks a provable cross-room identity`,
        isRoomName(sourceRoom) ? "targetRoom" : "sourceRoom",
      ),
    };
  }

  const issues: WorkProjectionIssue[] = [];
  let malformed = false;

  if (targetRoom !== localId) {
    issues.push(issue(
      "war-store-key-mismatch",
      "war store key and targetRoom disagree",
      "targetRoom",
    ));
    malformed = true;
  }

  const status = ownValue(value, "status");
  const sourceState = typeof status === "string" ? status : "unknown";
  if (typeof status !== "string" || !WAR_STATUSES.has(status)) {
    issues.push(issue("war-unknown-status", "war status is not recognized", "status"));
    malformed = true;
  }

  const reason = ownValue(value, "reason");
  if (typeof reason !== "string" || !WAR_REASONS.has(reason)) {
    issues.push(issue("war-unknown-reason", "war reason is not recognized", "reason"));
    malformed = true;
  }

  const squad = ownValue(value, "squad");
  if (squad !== undefined && (typeof squad !== "string" || !WAR_SQUADS.has(squad))) {
    issues.push(issue("war-unknown-squad", "war squad is not recognized", "squad"));
    malformed = true;
  }

  const boostTier = ownValue(value, "boostTier");
  if (
    boostTier !== undefined
    && (typeof boostTier !== "string" || !WAR_BOOST_TIERS.has(boostTier))
  ) {
    issues.push(issue("war-unknown-boost-tier", "war boostTier is not recognized", "boostTier"));
    malformed = true;
  }

  const oneShot = ownValue(value, "oneShot");
  if (oneShot !== undefined && typeof oneShot !== "boolean") {
    issues.push(issue("war-invalid-one-shot", "oneShot must be a boolean", "oneShot"));
    malformed = true;
  }

  const failReason = ownValue(value, "failReason");
  if (failReason !== undefined && typeof failReason !== "string") {
    issues.push(issue("war-invalid-blocker", "failReason must be a string", "failReason"));
    malformed = true;
  }
  const blocker = typeof failReason === "string" && failReason.length > 0
    ? failReason
    : undefined;

  const generation = projectGeneration(ownValue(value, "activeGeneration"), issues);
  malformed ||= generation.malformed;

  const createdAt = optionalFiniteNumber(value, "createdAt", issues);
  const updatedAt = optionalFiniteNumber(value, "updatedAt", issues);
  const retryAt = optionalFiniteNumber(value, "patrolNextSweepAt", issues);
  const completedAt = optionalFiniteNumber(value, "completedAt", issues);
  const assetsReleasedAt = optionalFiniteNumber(value, "assetsReleasedAt", issues);
  malformed ||= createdAt.malformed
    || updatedAt.malformed
    || retryAt.malformed
    || completedAt.malformed
    || assetsReleasedAt.malformed;

  const terminal = status === "done" || status === "failed";
  if (terminal && assetsReleasedAt.value === undefined && !assetsReleasedAt.malformed) {
    issues.push(issue(
      "war-terminal-release-unconfirmed",
      "legacy terminal owner has no evidence that production and execution assets were released",
      "assetsReleasedAt",
    ));
  }
  if (!terminal && completedAt.value !== undefined) {
    issues.push(issue(
      "war-active-completed-at-conflict",
      "non-terminal war owner must not retain completedAt",
      "completedAt",
    ));
    malformed = true;
  }
  if (!terminal && assetsReleasedAt.value !== undefined) {
    issues.push(issue(
      "war-active-release-at-conflict",
      "non-terminal war owner must not retain assetsReleasedAt",
      "assetsReleasedAt",
    ));
    malformed = true;
  }
  if (
    terminal
    && completedAt.value !== undefined
    && assetsReleasedAt.value !== undefined
    && assetsReleasedAt.value < completedAt.value
  ) {
    issues.push(issue(
      "war-release-before-completion-conflict",
      "assetsReleasedAt must not precede completedAt",
      "assetsReleasedAt",
    ));
    malformed = true;
  }

  const authorities: WorkAuthorityRef[] = [
    { role: "producer", id: WAR_NAMESPACE },
    { role: "workflow_owner", id: sourceRoom, component: "source-room" },
    ...generation.authorities,
  ];

  const activity = malformed
    ? "unknown"
    : activityForStatus(sourceState, blocker);

  return {
    entry: {
      ref: {
        system: "war-workflow",
        namespace: WAR_NAMESPACE,
        scope: {
          kind: "cross_room",
          fromRoomName: sourceRoom,
          toRoomName: targetRoom,
        },
        localId,
      },
      activity,
      sourceState,
      authorities,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      blocker,
      retryAt: retryAt.value,
      issues,
    },
  };
}

export function snapshotWarWorkflow(): TaskSystemAdapterResult {
  const data = (Memory as unknown as { data?: unknown }).data;
  if (data === undefined) {
    return { entries: [], invalidCount: 0, issues: [] };
  }
  if (!isRecord(data)) {
    return {
      entries: [],
      invalidCount: 1,
      issues: [issue("war-malformed-data", "Memory.data must be an object", "Memory.data")],
    };
  }

  const store = ownValue(data, "war");
  if (store === undefined) {
    return { entries: [], invalidCount: 0, issues: [] };
  }
  if (!isRecord(store)) {
    return {
      entries: [],
      invalidCount: 1,
      issues: [issue("war-malformed-store", "Memory.data.war must be an object", "Memory.data.war")],
    };
  }

  const entries: WorkStatusView[] = [];
  const issues: WorkProjectionIssue[] = [];
  let invalidCount = 0;
  for (const [localId, value] of Object.entries(store)) {
    const projected = projectWarEntry(localId, value);
    if (projected.entry) entries.push(projected.entry);
    if (projected.invalidIssue) {
      invalidCount += 1;
      issues.push(projected.invalidIssue);
    }
  }

  return {
    entries: sortWorkStatusViews(entries),
    invalidCount,
    issues,
  };
}

export const warWorkflowAdapter: TaskSystemAdapter = {
  system: "war-workflow",
  snapshot: snapshotWarWorkflow,
};

export default warWorkflowAdapter;

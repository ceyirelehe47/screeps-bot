/** 本地派发引用只支持当前正在使用的两种系统和房间作用域。 */
interface WorkRef {
  readonly system: "worker-work" | "carrier-logistics";
  readonly namespace: string;
  readonly scope: { readonly kind: "room"; readonly roomName: string };
  readonly localId: string;
}

export type WorkerDispatchRef = WorkRef & {
  readonly system: "worker-work";
  readonly namespace: "workerTaskPool";
  readonly scope: {
    readonly kind: "room";
    readonly roomName: string;
  };
  readonly localId: string;
};

export type CarrierDispatchRef = WorkRef & {
  readonly system: "carrier-logistics";
  readonly namespace: string;
  readonly scope: {
    readonly kind: "room";
    readonly roomName: string;
  };
  readonly localId: string;
};

export type DispatchRef = WorkerDispatchRef | CarrierDispatchRef;

const ROOM_NAME_PATTERN = /^(?:[WE]\d+[NS]\d+|sim)$/;
const WORKER_SYSTEM = "worker-work" as const;
const WORKER_NAMESPACE = "workerTaskPool" as const;
const CARRIER_SYSTEM = "carrier-logistics" as const;
const CARRIER_DISPATCH_STEP_KEY_TAG = "carrier-dispatch-step-v1" as const;

type DataPropertyResult =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    return false;
  }
}

function ownDataProperty(value: object, key: string): DataPropertyResult {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return { found: false };
  }
  if (!descriptor || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value };
}

function ownString(value: object, key: string): string | undefined {
  const property = ownDataProperty(value, key);
  return property.found && typeof property.value === "string"
    ? property.value
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidDispatchRoomName(value: unknown): value is string {
  return typeof value === "string" && ROOM_NAME_PATTERN.test(value);
}

function readRoomScope(value: unknown): { readonly kind: "room"; readonly roomName: string } | undefined {
  if (!isRecord(value)) return undefined;
  const kind = ownString(value, "kind");
  const roomName = ownString(value, "roomName");
  if (kind !== "room" || !isValidDispatchRoomName(roomName)) return undefined;
  return { kind: "room", roomName };
}

interface DispatchRefFields {
  readonly system: string;
  readonly namespace: string;
  readonly scope: { readonly kind: "room"; readonly roomName: string };
  readonly localId: string;
}

function readDispatchRefFields(value: unknown): DispatchRefFields | undefined {
  if (!isRecord(value)) return undefined;
  const system = ownString(value, "system");
  const namespace = ownString(value, "namespace");
  const scopeProperty = ownDataProperty(value, "scope");
  const localId = ownString(value, "localId");
  if (
    !isNonEmptyString(system)
    || !isNonEmptyString(namespace)
    || !scopeProperty.found
    || !isNonEmptyString(localId)
  ) {
    return undefined;
  }
  const scope = readRoomScope(scopeProperty.value);
  if (!scope) return undefined;
  return { system, namespace, scope, localId };
}

export function isWorkerDispatchRef(value: unknown): value is WorkerDispatchRef {
  const fields = readDispatchRefFields(value);
  return fields?.system === WORKER_SYSTEM && fields.namespace === WORKER_NAMESPACE;
}

export function isCarrierDispatchRef(value: unknown): value is CarrierDispatchRef {
  const fields = readDispatchRefFields(value);
  return fields?.system === CARRIER_SYSTEM;
}

export function createWorkerDispatchRef(
  roomName: string,
  localId: string,
): WorkerDispatchRef | undefined {
  if (!isValidDispatchRoomName(roomName) || !isNonEmptyString(localId)) return undefined;
  return {
    system: WORKER_SYSTEM,
    namespace: WORKER_NAMESPACE,
    scope: { kind: "room", roomName },
    localId,
  };
}

export function createCarrierDispatchRef(
  namespace: string,
  roomName: string,
  localId: string,
): CarrierDispatchRef | undefined {
  if (
    !isNonEmptyString(namespace)
    || !isValidDispatchRoomName(roomName)
    || !isNonEmptyString(localId)
  ) {
    return undefined;
  }
  return {
    system: CARRIER_SYSTEM,
    namespace,
    scope: { kind: "room", roomName },
    localId,
  };
}

export function cloneWorkerDispatchRef(value: unknown): WorkerDispatchRef | undefined {
  const fields = readDispatchRefFields(value);
  if (fields?.system !== WORKER_SYSTEM || fields.namespace !== WORKER_NAMESPACE) return undefined;
  return createWorkerDispatchRef(fields.scope.roomName, fields.localId);
}

export function cloneCarrierDispatchRef(value: unknown): CarrierDispatchRef | undefined {
  const fields = readDispatchRefFields(value);
  if (fields?.system !== CARRIER_SYSTEM) return undefined;
  return createCarrierDispatchRef(fields.namespace, fields.scope.roomName, fields.localId);
}

export function cloneDispatchRef(value: unknown): DispatchRef | undefined {
  return cloneWorkerDispatchRef(value) ?? cloneCarrierDispatchRef(value);
}

export function equalDispatchRefs(left: unknown, right: unknown): boolean {
  const leftRef = cloneDispatchRef(left);
  const rightRef = cloneDispatchRef(right);
  return leftRef !== undefined
    && rightRef !== undefined
    && leftRef.system === rightRef.system
    && leftRef.namespace === rightRef.namespace
    && leftRef.scope.roomName === rightRef.scope.roomName
    && leftRef.localId === rightRef.localId;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Produces an injective opaque key. Consumers must retain the structured ref
 * and must not parse this representation to recover identity fields.
 */
export function encodeCarrierDispatchStepKey(
  ref: CarrierDispatchRef,
  stepId: string,
): string {
  const ownedRef = cloneCarrierDispatchRef(ref);
  if (!ownedRef || !isNonEmptyString(stepId)) {
    throw new TypeError("A valid CarrierDispatchRef and non-empty stepId are required");
  }
  return JSON.stringify([
    CARRIER_DISPATCH_STEP_KEY_TAG,
    ownedRef.system,
    ownedRef.namespace,
    ownedRef.scope.kind,
    ownedRef.scope.roomName,
    ownedRef.localId,
    stepId,
  ]);
}

/** Validates an opaque stable key without exposing or reconstructing its fields. */
export function isCarrierDispatchStepKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let tuple: unknown;
  try {
    tuple = JSON.parse(value) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(tuple) || tuple.length !== 7) return false;
  const [tag, system, namespace, scopeKind, roomName, localId, stepId] = tuple;
  if (
    tag !== CARRIER_DISPATCH_STEP_KEY_TAG
    || system !== CARRIER_SYSTEM
    || scopeKind !== "room"
    || !isNonEmptyString(namespace)
    || !isValidDispatchRoomName(roomName)
    || !isNonEmptyString(localId)
    || !isNonEmptyString(stepId)
  ) {
    return false;
  }
  const ref = createCarrierDispatchRef(namespace, roomName, localId);
  return ref !== undefined && encodeCarrierDispatchStepKey(ref, stepId) === value;
}

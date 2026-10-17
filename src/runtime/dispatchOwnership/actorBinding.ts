import {
  ensureCreepAssignmentState,
  getCreepAssignmentState,
  type CreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import {
  cloneCarrierDispatchRef,
  cloneWorkerDispatchRef,
  isValidDispatchRoomName,
  type CarrierDispatchRef,
  type DispatchRef,
  type WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

export type DispatchBindingKind = "worker" | "carrier";
export type LegacyWorkerDispatchResolver = (
  roomName: string,
  localId: string,
) => readonly unknown[];
export type LegacyCarrierDispatchResolver = LegacyWorkerDispatchResolver;

type BindingForKind<K extends DispatchBindingKind> = K extends "worker"
  ? WorkerDispatchRef
  : CarrierDispatchRef;

interface BindingSlot<R extends DispatchRef> {
  readonly present: boolean;
  readonly malformed: boolean;
  readonly ref?: R;
}

type OwnDescriptorResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly descriptor?: PropertyDescriptor };

interface BindingTransactionSnapshot {
  readonly bindings: OwnDescriptorResult & { readonly ok: true };
  readonly mirror: OwnDescriptorResult & { readonly ok: true };
}

const MIRROR_BY_KIND: Readonly<Record<DispatchBindingKind, "taskId" | "synthesisCarrierTaskId">> = {
  worker: "taskId",
  carrier: "synthesisCarrierTaskId",
};

function isActorName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    return false;
  }
}

function ownDataValue(
  target: object,
  key: string,
): { readonly present: boolean; readonly accessor: boolean; readonly value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return { present: true, accessor: true };
  }
  if (!descriptor) return { present: false, accessor: false };
  if (!("value" in descriptor)) return { present: true, accessor: true };
  return { present: true, accessor: false, value: descriptor.value };
}

function ownDescriptor(target: object, key: string): OwnDescriptorResult {
  try {
    return {
      ok: true,
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    };
  } catch {
    return { ok: false };
  }
}

function defineOwnDataValue(target: object, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function deleteOwnValue(target: object, key: string): boolean {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return true;
    return delete (target as Record<string, unknown>)[key];
  } catch {
    return false;
  }
}

function restoreOwnDescriptor(
  target: object,
  key: string,
  snapshot: OwnDescriptorResult & { readonly ok: true },
): boolean {
  if (!snapshot.descriptor) return deleteOwnValue(target, key);
  try {
    Object.defineProperty(target, key, snapshot.descriptor);
    return true;
  } catch {
    return false;
  }
}

function captureBindingTransaction(
  state: CreepAssignmentState,
  kind: DispatchBindingKind,
): BindingTransactionSnapshot | undefined {
  const bindings = ownDescriptor(state, "dispatchBindings");
  const mirror = ownDescriptor(state, MIRROR_BY_KIND[kind]);
  if (!bindings.ok || !mirror.ok) return undefined;
  return { bindings, mirror };
}

function restoreBindingTransaction(
  state: CreepAssignmentState,
  kind: DispatchBindingKind,
  snapshot: BindingTransactionSnapshot,
): boolean {
  const bindingsRestored = restoreOwnDescriptor(
    state,
    "dispatchBindings",
    snapshot.bindings,
  );
  const mirrorRestored = restoreOwnDescriptor(
    state,
    MIRROR_BY_KIND[kind],
    snapshot.mirror,
  );
  return bindingsRestored && mirrorRestored;
}

function cloneForKind<K extends DispatchBindingKind>(
  kind: K,
  value: unknown,
): BindingForKind<K> | undefined {
  return (
    kind === "worker"
      ? cloneWorkerDispatchRef(value)
      : cloneCarrierDispatchRef(value)
  ) as BindingForKind<K> | undefined;
}

function equalOwnedDispatchRefs(left: DispatchRef, right: DispatchRef): boolean {
  return left.system === right.system
    && left.namespace === right.namespace
    && left.scope.kind === right.scope.kind
    && left.scope.roomName === right.scope.roomName
    && left.localId === right.localId;
}

function readBindingSlot<K extends DispatchBindingKind>(
  state: unknown,
  kind: K,
): BindingSlot<BindingForKind<K>> {
  if (state === undefined) return { present: false, malformed: false };
  if (!isRecord(state)) return { present: true, malformed: true };
  const bindingsProperty = ownDataValue(state, "dispatchBindings");
  if (!bindingsProperty.present) {
    return { present: false, malformed: false };
  }
  if (bindingsProperty.accessor) return { present: true, malformed: true };
  if (bindingsProperty.value === undefined) return { present: false, malformed: false };
  if (!isRecord(bindingsProperty.value)) {
    return { present: true, malformed: true };
  }
  const refProperty = ownDataValue(bindingsProperty.value, kind);
  if (!refProperty.present) {
    return { present: false, malformed: false };
  }
  if (refProperty.accessor) return { present: true, malformed: true };
  if (refProperty.value === undefined) return { present: false, malformed: false };
  const ref = cloneForKind(kind, refProperty.value);
  return ref
    ? { present: true, malformed: false, ref }
    : { present: true, malformed: true };
}

function readMirror(state: unknown, kind: DispatchBindingKind): string | undefined {
  if (!isRecord(state)) return undefined;
  const property = ownDataValue(state, MIRROR_BY_KIND[kind]);
  return property.present && !property.accessor && typeof property.value === "string"
    ? property.value
    : undefined;
}

function writeMirror(
  state: CreepAssignmentState,
  kind: DispatchBindingKind,
  localId: string,
): boolean {
  return defineOwnDataValue(state, MIRROR_BY_KIND[kind], localId);
}

function clearMirror(state: CreepAssignmentState, kind: DispatchBindingKind): boolean {
  return deleteOwnValue(state, MIRROR_BY_KIND[kind]);
}

function synchronizeMirror(
  state: CreepAssignmentState,
  kind: DispatchBindingKind,
  localId: string,
): boolean {
  if (readMirror(state, kind) === localId) return true;
  const mirrorSnapshot = ownDescriptor(state, MIRROR_BY_KIND[kind]);
  if (!mirrorSnapshot.ok) return false;
  if (writeMirror(state, kind, localId)) return true;
  restoreOwnDescriptor(state, MIRROR_BY_KIND[kind], mirrorSnapshot);
  return false;
}

function writeBinding<K extends DispatchBindingKind>(
  state: CreepAssignmentState,
  kind: K,
  nextRef: BindingForKind<K> | undefined,
): boolean {
  const oppositeKind: DispatchBindingKind = kind === "worker" ? "carrier" : "worker";
  const bindingsProperty = ownDescriptor(state, "dispatchBindings");
  if (!bindingsProperty.ok) return false;
  let sourceBindings: Record<string, unknown> | undefined;
  if (bindingsProperty.descriptor) {
    if (!("value" in bindingsProperty.descriptor)) return false;
    if (bindingsProperty.descriptor.value !== undefined) {
      if (!isRecord(bindingsProperty.descriptor.value)) return false;
      sourceBindings = bindingsProperty.descriptor.value;
    }
  }

  const bindings: CreepAssignmentState["dispatchBindings"] = {};
  if (sourceBindings) {
    const oppositeDescriptor = ownDescriptor(sourceBindings, oppositeKind);
    if (!oppositeDescriptor.ok) return false;
    if (oppositeDescriptor.descriptor) {
      try {
        Object.defineProperty(bindings, oppositeKind, oppositeDescriptor.descriptor);
      } catch {
        return false;
      }
    }
  }
  if (nextRef) {
    if (!defineOwnDataValue(bindings, kind, nextRef)) return false;
  }

  if (Object.getOwnPropertyNames(bindings).length === 0) {
    return deleteOwnValue(state, "dispatchBindings");
  }
  return defineOwnDataValue(state, "dispatchBindings", bindings);
}

function readBinding<K extends DispatchBindingKind>(
  actorName: string,
  kind: K,
): BindingForKind<K> | undefined {
  if (!isActorName(actorName)) return undefined;
  return readBindingSlot(getCreepAssignmentState(actorName), kind).ref;
}

function bindBinding<K extends DispatchBindingKind>(
  actorName: string,
  kind: K,
  nextRefInput: BindingForKind<K>,
  expectedRefInput?: BindingForKind<K>,
): boolean {
  if (!isActorName(actorName)) return false;
  const nextRef = cloneForKind(kind, nextRefInput);
  if (!nextRef) return false;
  const expectedRef = expectedRefInput === undefined
    ? undefined
    : cloneForKind(kind, expectedRefInput);
  if (expectedRefInput !== undefined && !expectedRef) return false;

  const existingState = getCreepAssignmentState(actorName);
  const current = readBindingSlot(existingState, kind);
  if (current.malformed) return false;
  if (expectedRef === undefined) {
    if (current.present) return false;
  } else if (!current.ref || !equalOwnedDispatchRefs(current.ref, expectedRef)) {
    return false;
  }

  const state = existingState ?? ensureCreepAssignmentState(actorName);
  if (!isRecord(state)) return false;
  if (current.ref && equalOwnedDispatchRefs(current.ref, nextRef)) {
    return synchronizeMirror(state, kind, nextRef.localId);
  }
  const transaction = captureBindingTransaction(state, kind);
  if (!transaction) return false;
  if (!writeBinding(state, kind, nextRef)) return false;
  if (!writeMirror(state, kind, nextRef.localId)) {
    restoreBindingTransaction(state, kind, transaction);
    return false;
  }
  return true;
}

function releaseBinding<K extends DispatchBindingKind>(
  actorName: string,
  kind: K,
  expectedRefInput: BindingForKind<K>,
): boolean {
  if (!isActorName(actorName)) return false;
  const expectedRef = cloneForKind(kind, expectedRefInput);
  if (!expectedRef) return false;
  const state = getCreepAssignmentState(actorName);
  if (!isRecord(state)) return false;
  const current = readBindingSlot(state, kind);
  if (!current.ref || !equalOwnedDispatchRefs(current.ref, expectedRef)) return false;
  const transaction = captureBindingTransaction(state, kind);
  if (!transaction) return false;
  if (!writeBinding(state, kind, undefined)) return false;
  if (clearMirror(state, kind)) return true;
  restoreBindingTransaction(state, kind, transaction);
  return false;
}

function clearUnboundLegacyMirror(
  actorName: string,
  kind: DispatchBindingKind,
): boolean {
  const state = getCreepAssignmentState(actorName);
  if (!isRecord(state)) return false;
  if (readBindingSlot(state, kind).present) return false;
  return clearMirror(state, kind);
}

function promoteLegacyBinding<K extends DispatchBindingKind>(
  actorName: string,
  kind: K,
  expectedRoomName: string,
  resolveCandidates: (roomName: string, localId: string) => readonly unknown[],
): BindingForKind<K> | undefined {
  if (!isActorName(actorName) || !isValidDispatchRoomName(expectedRoomName)) return undefined;
  const state = getCreepAssignmentState(actorName);
  if (!isRecord(state)) return undefined;

  const current = readBindingSlot(state, kind);
  if (current.ref) {
    return synchronizeMirror(state, kind, current.ref.localId)
      ? cloneForKind(kind, current.ref)
      : undefined;
  }
  if (current.malformed) {
    const transaction = captureBindingTransaction(state, kind);
    if (
      !transaction
      || !writeBinding(state, kind, undefined)
      || !clearMirror(state, kind)
    ) {
      if (transaction) restoreBindingTransaction(state, kind, transaction);
    }
    return undefined;
  }

  const legacyLocalId = readMirror(state, kind);
  if (!legacyLocalId) {
    clearMirror(state, kind);
    return undefined;
  }

  let rawCandidates: readonly unknown[] = [];
  try {
    const resolved = resolveCandidates(expectedRoomName, legacyLocalId);
    if (Array.isArray(resolved)) rawCandidates = resolved;
  } catch {
    rawCandidates = [];
  }
  const candidates = rawCandidates
    .map((candidate) => cloneForKind(kind, candidate))
    .filter((candidate): candidate is BindingForKind<K> => (
      candidate !== undefined
      && candidate.scope.roomName === expectedRoomName
      && candidate.localId === legacyLocalId
    ));

  const currentAfterResolve = readBindingSlot(state, kind);
  if (
    currentAfterResolve.present
    || readMirror(state, kind) !== legacyLocalId
  ) {
    return undefined;
  }
  if (candidates.length !== 1) {
    clearMirror(state, kind);
    return undefined;
  }
  return bindBinding(actorName, kind, candidates[0])
    ? cloneForKind(kind, candidates[0])
    : undefined;
}

export function readWorkerDispatchBinding(actorName: string): WorkerDispatchRef | undefined {
  return readBinding(actorName, "worker");
}

export function readCarrierDispatchBinding(actorName: string): CarrierDispatchRef | undefined {
  return readBinding(actorName, "carrier");
}

export function bindWorkerDispatchBinding(
  actorName: string,
  nextRef: WorkerDispatchRef,
  expectedRef?: WorkerDispatchRef,
): boolean {
  return bindBinding(actorName, "worker", nextRef, expectedRef);
}

export function bindCarrierDispatchBinding(
  actorName: string,
  nextRef: CarrierDispatchRef,
  expectedRef?: CarrierDispatchRef,
): boolean {
  return bindBinding(actorName, "carrier", nextRef, expectedRef);
}

export function releaseWorkerDispatchBinding(
  actorName: string,
  expectedRef: WorkerDispatchRef,
): boolean {
  return releaseBinding(actorName, "worker", expectedRef);
}

export function releaseCarrierDispatchBinding(
  actorName: string,
  expectedRef: CarrierDispatchRef,
): boolean {
  return releaseBinding(actorName, "carrier", expectedRef);
}

export function promoteLegacyWorkerDispatchBinding(
  actorName: string,
  expectedRoomName: string,
  resolveCandidates: LegacyWorkerDispatchResolver,
): WorkerDispatchRef | undefined {
  return promoteLegacyBinding(actorName, "worker", expectedRoomName, resolveCandidates);
}

export function promoteLegacyCarrierDispatchBinding(
  actorName: string,
  expectedRoomName: string,
  resolveCandidates: LegacyCarrierDispatchResolver,
): CarrierDispatchRef | undefined {
  return promoteLegacyBinding(actorName, "carrier", expectedRoomName, resolveCandidates);
}

export function clearLegacyCarrierDispatchBinding(actorName: string): boolean {
  return clearUnboundLegacyMirror(actorName, "carrier");
}

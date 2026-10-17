import { utf8ByteLength } from "@/util/utf8";

export interface MemoryAuditBranch {
  path: string;
  bytes: number;
}

export interface MemoryAuditSnapshot {
  totalBytes: number;
  branches: MemoryAuditBranch[];
  top: MemoryAuditBranch[];
  persistedBytes?: number;
  creepFields?: MemoryAuditBranch[];
}

export interface MemoryAuditOptions {
  maxDepth?: number;
  topN?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_TOP_N = 25;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}

function measureBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8ByteLength(json);
  } catch {
    return 0;
  }
}

function collectBranches(
  obj: unknown,
  prefix: string,
  depth: number,
  maxDepth: number,
  branches: MemoryAuditBranch[],
): void {
  if (depth > maxDepth) {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = obj[i];
      const childPath = prefix === "" ? `[${i}]` : `${prefix}[${i}]`;
      const isContainer = Array.isArray(child) || isPlainObject(child);
      if (depth < maxDepth) {
        branches.push({ path: childPath, bytes: measureBytes(child) });
      }
      if (isContainer) {
        collectBranches(child, childPath, depth + 1, maxDepth, branches);
      }
    }
    return;
  }

  if (isPlainObject(obj)) {
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      const childPath = prefix === "" ? key : `${prefix}.${key}`;
      if (Array.isArray(child) || isPlainObject(child)) {
        if (depth < maxDepth) {
          branches.push({ path: childPath, bytes: measureBytes(child) });
        }
        collectBranches(child, childPath, depth + 1, maxDepth, branches);
      }
    }
  }
}

export function buildMemoryAuditSnapshot(memory: unknown, options?: MemoryAuditOptions): MemoryAuditSnapshot {
  const maxDepth = Math.max(1, Math.min(6, Math.floor(options?.maxDepth ?? DEFAULT_MAX_DEPTH) || DEFAULT_MAX_DEPTH));
  const topN = Math.max(1, Math.min(100, Math.floor(options?.topN ?? DEFAULT_TOP_N) || DEFAULT_TOP_N));

  if (memory == null || typeof memory !== "object") {
    return { totalBytes: 0, branches: [], top: [] };
  }

  const totalBytes = measureBytes(memory);
  const branches: MemoryAuditBranch[] = [];

  collectBranches(memory, "", 1, maxDepth, branches);

  branches.sort((a, b) => b.bytes - a.bytes);

  const top = branches.slice(0, topN);

  return { totalBytes, branches, top };
}

/** 按字段汇总 creep 内存；仅由显式只读 console 查询调用。 */
export function measureCreepMemoryFields(creeps: Memory["creeps"]): MemoryAuditBranch[] {
  const fields = new Map<string, number>();
  for (const creep of Object.values(creeps ?? {})) {
    for (const [key, value] of Object.entries(creep)) {
      fields.set(key, (fields.get(key) ?? 0) + measureBytes({ [key]: value }) - 2);
    }
  }
  return [...fields].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes);
}

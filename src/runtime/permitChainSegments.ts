import { requestMemorySegments } from "@/runtime/memorySegments";
import {
  decodePermitChain, encodePermitChain, isPermitChainManifestCandidate,
  PERMIT_CHAIN_CHUNK_KIND, PermitChainManifest, validatePermitChainManifest,
} from "@/runtime/permitChainSegmentCodec";
import { getPermitChainContainer, setPermitChainStorageBlocked } from "@/runtime/permitChainStorageGuard";

export interface PermitChainStorageMemory {
  schemaVersion: 1;
  shard: string;
  mode: "inline" | "segments";
  nextEpoch: number;
  active?: PermitChainManifest;
  pending?: { manifest: PermitChainManifest; preparedAt: number };
}

interface HeapEntry {
  manifest: PermitChainManifest;
  parts: string[];
  json: string;
  chain: Readonly<Record<string, unknown>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBook(value: unknown): PermitChainStorageMemory | undefined {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.shard !== "string" ||
    !["inline", "segments"].includes(value.mode as string) || !Number.isSafeInteger(value.nextEpoch) ||
    (value.nextEpoch as number) < 1 ||
    value.active !== undefined && !validatePermitChainManifest(value.active) ||
    value.pending !== undefined && (!record(value.pending) || !validatePermitChainManifest(value.pending.manifest) ||
      !Number.isSafeInteger(value.pending.preparedAt) || (value.pending.preparedAt as number) < 0)) return undefined;
  const book = value as unknown as PermitChainStorageMemory;
  if (book.mode === "segments" && !book.active ||
    book.active && book.nextEpoch <= book.active.epoch ||
    book.pending && (book.nextEpoch <= book.pending.manifest.epoch ||
      book.active && (book.pending.manifest.epoch <= book.active.epoch ||
        book.pending.manifest.segmentIds.some(id => book.active!.segmentIds.includes(id))))) return undefined;
  return book;
}

function chainIn(memory: Memory): unknown {
  return getPermitChainContainer(memory)?.permitChain;
}

function banksIn(memory: Memory): [number[], number[]] | undefined {
  const banks = memory.cfg?.memoryStorage?.permitChain?.banks;
  if (!Array.isArray(banks) || banks.length !== 2) return undefined;
  const ids: number[] = [];
  for (const bank of banks) {
    if (!Array.isArray(bank) || bank.length < 1 || bank.length > 4) return undefined;
    for (const id of bank) {
      const configuredTelemetryId = memory.cfg?.telemetry?.segmentId;
      const telemetryId = Number.isInteger(configuredTelemetryId) && configuredTelemetryId! >= 0 && configuredTelemetryId! <= 99 ? configuredTelemetryId : 90;
      if (!Number.isInteger(id) || id < 0 || id > 99 || ids.includes(id) || id === telemetryId) return undefined;
      ids.push(id);
    }
  }
  return banks;
}

function budget(memory: Memory): boolean {
  const config = memory.cfg?.memoryStorage?.permitChain;
  const minBucket = Number.isFinite(config?.minBucket) ? Math.max(0, Math.min(10000, config!.minBucket!)) : 9000;
  const minFreeCpu = Number.isFinite(config?.minFreeCpu) ? Math.max(50, config!.minFreeCpu!) : 150;
  return Game.cpu.bucket >= minBucket && Game.cpu.tickLimit - Game.cpu.getUsed() >= minFreeCpu;
}

/** 双 bank、下一 tick 回读后切换；堆中只缓存解码结果，不缓存业务授权。 */
export function createPermitChainSegmentStore() {
  const heap = new Map<string, HeapEntry>();
  let frame: { memory: Memory; game: typeof Game; tick: number; shard: string; entry?: HeapEntry; blocked?: string } | undefined;
  const stats = { hits: 0, decodes: 0, prepared: 0, activated: 0, lastReason: "disabled" };

  function fail(reason: string): void {
    stats.lastReason = reason;
    if (frame) frame.blocked = reason;
    setPermitChainStorageBlocked(reason);
  }

  function load(manifest: PermitChainManifest): HeapEntry {
    const parts = manifest.segmentIds.map(id => {
      const text = RawMemory.segments[id];
      if (typeof text !== "string") throw new Error("segments_not_loaded");
      return text;
    });
    const key = `${Game.shard?.name ?? ""}:${manifest.manifestHash}`;
    const cached = heap.get(key);
    if (cached && cached.parts.every((text, index) => text === parts[index])) {
      stats.hits++;
      return cached;
    }
    if (!budget(Memory)) throw new Error("decode_budget");
    const decoded = decodePermitChain(manifest, parts);
    const stableManifest = Object.freeze({ ...manifest, segmentIds: Object.freeze([...manifest.segmentIds]) }) as unknown as PermitChainManifest;
    const entry = { manifest: stableManifest, parts, ...decoded };
    while (heap.size >= 2) heap.delete(heap.keys().next().value!);
    heap.set(key, entry);
    stats.decodes++;
    return entry;
  }

  function begin(): void {
    frame = { memory: Memory, game: Game, tick: Game.time, shard: Game.shard?.name ?? "" };
    setPermitChainStorageBlocked();
    const rawBook = Memory.data?.permitChainSegments;
    const chain = chainIn(Memory);
    const enabled = Memory.cfg?.memoryStorage?.permitChain?.enabled === true;
    if (rawBook === undefined && !enabled && !isPermitChainManifestCandidate(chain)) return;
    const book = rawBook === undefined ? undefined : readBook(rawBook);
    if (rawBook !== undefined && (!book || book.shard !== frame.shard)) { fail("storage_metadata_invalid"); return; }
    // 已完整回退后释放激活名额；旧 bank 只保留数据，不继续逐 tick 加载。
    if (book?.mode === "inline" && !enabled && !isPermitChainManifestCandidate(chain)) return;
    const banks = enabled ? banksIn(Memory) : undefined;
    const targetBank = banks?.find(candidate => !candidate.some(id => book?.active?.segmentIds.includes(id)));
    const pendingBank = book?.pending && banks?.find(candidate =>
      book.pending!.manifest.segmentIds.every(id => candidate.includes(id)));
    const ids = [...new Set([...(book?.active?.segmentIds ?? []),
      ...(pendingBank || book?.pending?.manifest.segmentIds || targetBank || [])])];
    try { if (ids.length) requestMemorySegments(ids); }
    catch { stats.lastReason = "activation_request_failed"; }
    if (book?.mode === "segments" || isPermitChainManifestCandidate(chain)) {
      if (!book?.active || !validatePermitChainManifest(chain) || chain.manifestHash !== book.active.manifestHash) {
        fail("cold_reference_mismatch"); return;
      }
      try {
        const entry = load(book.active);
        const v3 = getPermitChainContainer(Memory)!;
        // 业务层始终只看到完整链；只修改 Memory 中当前可写的容器。
        v3.permitChain = entry.chain;
        frame.entry = entry;
      } catch (error) { fail(error instanceof Error ? error.message : "decode_failed"); }
    }
  }

  function prepare(): void {
    if (!frame || frame.memory !== Memory || frame.game !== Game || frame.tick !== Game.time || frame.blocked ||
      Memory.cfg?.memoryStorage?.permitChain?.enabled !== true) return;
    const banks = banksIn(Memory);
    if (!banks) { stats.lastReason = "explicit_disjoint_banks_required"; return; }
    const chain = chainIn(Memory);
    if (!record(chain) || isPermitChainManifestCandidate(chain)) return;
    const existing = Memory.data?.permitChainSegments;
    const book = existing === undefined ? undefined : readBook(existing);
    if (existing !== undefined && !book) { fail("storage_metadata_invalid"); return; }
    // 解码器创建的链已深冻结且只含 JSON 数据；同一对象无需重新 stringify。
    // 新对象即使摘要/规模相同也必须比较完整 JSON，不能按结构猜测相等。
    if (frame.entry?.chain === chain && book?.active?.manifestHash === frame.entry.manifest.manifestHash) return;
    const json = JSON.stringify(chain);
    if (frame.entry?.json === json && book?.active?.manifestHash === frame.entry.manifest.manifestHash) return;
    if (book?.pending) {
      if (Game.time <= book.pending.preparedAt) { stats.lastReason = "awaiting_next_tick"; return; }
      try {
        const entry = load(book.pending.manifest);
        if (entry.json !== json) {
          Memory.data!.permitChainSegments = { ...book, mode: "inline", pending: undefined };
          stats.lastReason = "pending_source_changed"; return;
        }
        // 只有真实 RawMemory 回读通过才能激活；写入时不预填堆缓存。
        Memory.data!.permitChainSegments = { ...book, active: entry.manifest, pending: undefined };
        frame.entry = entry;
        stats.activated++;
        stats.lastReason = "readback_confirmed";
      } catch (error) {
        stats.lastReason = error instanceof Error ? error.message : "pending_readback_failed";
        // 所有片均已回读却校验失败时，放弃未提交代次，下次重写空闲 bank。
        // 片尚未激活或预算不足时等待，不能误把本 tick 预写当成持久化确认。
        if (stats.lastReason !== "segments_not_loaded" && stats.lastReason !== "decode_budget") {
          Memory.data!.permitChainSegments = { ...book, mode: "inline", pending: undefined };
        }
      }
      return;
    }
    if (!budget(Memory)) { stats.lastReason = "prepare_budget"; return; }
    const bank = banks.find(candidate => !candidate.some(id => book?.active?.segmentIds.includes(id)));
    if (!bank || bank.some(id => typeof RawMemory.segments[id] !== "string") || Object.keys(RawMemory.segments).length > 10) {
      stats.lastReason = "inactive_bank_not_loaded"; return;
    }
    // 显式配置也不允许覆盖其它使用方已有数据。
    if (bank.some(id => {
      const text = RawMemory.segments[id];
      if (text === "") return false;
      try { const part: unknown = JSON.parse(text); return !record(part) || part.kind !== PERMIT_CHAIN_CHUNK_KIND; }
      catch { return true; }
    })) { stats.lastReason = "inactive_bank_occupied"; return; }
    try {
      const epoch = book?.nextEpoch ?? 1;
      if (epoch >= Number.MAX_SAFE_INTEGER) throw new Error("epoch_exhausted");
      const encoded = encodePermitChain(chain, epoch, bank);
      if (chainIn(Memory) !== chain || JSON.stringify(chain) !== json || encoded.json !== json) {
        stats.lastReason = "source_changed_during_prepare"; return;
      }
      for (let index = 0; index < encoded.parts.length; index++) RawMemory.segments[encoded.manifest.segmentIds[index]] = encoded.parts[index];
      const next: PermitChainStorageMemory = { schemaVersion: 1, shard: frame.shard, mode: book?.mode ?? "inline",
        nextEpoch: encoded.manifest.epoch + 1, ...(book?.active ? { active: book.active } : {}),
        pending: { manifest: encoded.manifest, preparedAt: Game.time } };
      Memory.data ??= {};
      Memory.data.permitChainSegments = next;
      stats.prepared++;
      stats.lastReason = "prepared_inline_retained";
    } catch (error) { stats.lastReason = error instanceof Error ? error.message : "prepare_failed"; }
  }

  function project(memory: Memory): Memory {
    if (!frame || frame.memory !== memory || frame.game !== Game || frame.tick !== Game.time || frame.blocked) return memory;
    const book = readBook(memory.data?.permitChainSegments);
    if (!book) return memory;
    const chain = chainIn(memory);
    const entry = frame.entry;
    const useSegments = memory.cfg?.memoryStorage?.permitChain?.enabled === true && entry &&
      book.active?.manifestHash === entry.manifest.manifestHash &&
      entry.manifest.segmentIds.every((id, index) => RawMemory.segments[id] === entry.parts[index]) &&
      (chain === entry.chain || JSON.stringify(chain) === entry.json);
    const nextBook = { ...book, mode: useSegments ? "segments" as const : "inline" as const };
    const market = memory.data!.marketSaleAutomation!;
    if (!useSegments) return { ...memory, data: { ...memory.data, permitChainSegments: nextBook } };
    return { ...memory, data: { ...memory.data, permitChainSegments: nextBook, marketSaleAutomation: {
      ...market, directAutomation: { ...market.directAutomation!, baseResourceV3: {
        ...getPermitChainContainer(memory), permitChain: entry.manifest,
      } },
    } } } as unknown as Memory;
  }

  return { begin, prepare, project, status: () => ({ ...stats }),
    needsPersistence: () => !!Memory.data?.permitChainSegments && !frame?.blocked &&
      (Memory.data.permitChainSegments.mode === "segments" || Memory.cfg?.memoryStorage?.permitChain?.enabled === true),
    persistInline: () => {
      if (frame?.memory !== Memory || frame.blocked || isPermitChainManifestCandidate(chainIn(Memory))) return;
      const book = readBook(Memory.data?.permitChainSegments);
      if (book) Memory.data!.permitChainSegments = { ...book, mode: "inline" };
    } };
}

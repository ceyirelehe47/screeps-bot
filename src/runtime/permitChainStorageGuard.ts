// 只保存当前 tick 的可用性，不保存任何授权判断。冷引用未展开时，禁止
// 正常数据恢复器把它当成损坏的业务链清空，市场/Terminal 入口也保守等待。
let blocked: { memory: Memory; game: typeof Game; tick: number; reason: string } | undefined;

export class PermitChainStorageUnavailableError extends Error {
  readonly permitChainStorageUnavailable = true;
  constructor(reason: string) {
    super(`许可链存储暂不可用：${reason}`);
  }
}

export function setPermitChainStorageBlocked(reason?: string): void {
  blocked = reason ? { memory: Memory, game: Game, tick: Game.time, reason } : undefined;
}

export function getPermitChainContainer(memory: Memory): Record<string, unknown> | undefined {
  let value: unknown = memory;
  for (const key of ["data", "marketSaleAutomation", "directAutomation", "baseResourceV3"]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function permitChainStorageUnavailableReason(): string | undefined {
  if (blocked?.memory === Memory && blocked.game === Game && blocked.tick === Game.time) return blocked.reason;
  const chain = getPermitChainContainer(Memory)?.permitChain;
  if (chain && typeof chain === "object" && ("kind" in chain || "manifestHash" in chain)) return "cold_reference_not_hydrated";
  const book = Memory.data?.permitChainSegments;
  if (book?.mode === "segments" && !chain) return "cold_reference_missing";
  return undefined;
}

export function isPermitChainStorageReady(): boolean {
  return permitChainStorageUnavailableReason() === undefined;
}

export function assertPermitChainStorageReady(): void {
  const reason = permitChainStorageUnavailableReason();
  if (reason) throw new PermitChainStorageUnavailableError(reason);
}

export function isPermitChainStorageUnavailableError(error: unknown): boolean {
  return error instanceof PermitChainStorageUnavailableError;
}

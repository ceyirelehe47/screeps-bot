/**
 * Treasury 存储边界拦截器（测试专用，非 .test.ts，不被 Jest 收集）。
 *
 * Remediation II/V3 契约：拦截期间**实际放行**的写入由独立 liveValue 承载；
 * 卸载（restore）时把拦截期间实际最终保留下来的值安装回普通属性——
 * **不恢复安装时 descriptor 中的旧快照**（那会回滚拦截期间合法放行的
 * 预扣/游标发布，撤销被测行为）。配套契约测试见 F13。
 */

export interface TreasuryStorageInterceptorOptions {
  /** 放行前 N 次写入（默认 0 = 全部丢弃）。 */
  readonly allow?: number;
  /** 是否记录每次放行写载荷的 JSON 快照（断言"同次发布"内容用）。 */
  readonly capture?: boolean;
  /** 每次放行写入时回调（硬断点捕获点——此刻写已发生、后续生产步骤未执行）。 */
  readonly onAllow?: (value: unknown) => void;
}

export interface TreasuryStorageInterceptorHandle {
  /** 卸载拦截器：安装拦截期间实际最终保留的值（普通可写属性）。 */
  readonly restore: () => void;
  /** 实际放行的写入次数。 */
  readonly allowedCount: () => number;
  /** 被丢弃的写入次数。 */
  readonly droppedCount: () => number;
  /** 每次放行写载荷的 JSON 快照（capture 开启时；否则为空数组）。 */
  readonly capturedWrites: () => readonly string[];
  /** 拦截期间实际保留的当前值（未安装回属性前的 liveValue）。 */
  readonly liveValue: () => unknown;
}

export function interceptTreasuryCoreWrites(options: TreasuryStorageInterceptorOptions = {}): TreasuryStorageInterceptorHandle {
  const runtime = Memory.runtime as unknown as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
  if (descriptor === undefined) {
    throw new Error("拦截器须在 treasuryCore 存储初始化后安装（Memory.runtime.treasuryCore 缺失）");
  }
  let liveValue = descriptor.value;
  let allowed = 0;
  let dropped = 0;
  const captures: string[] = [];
  const maxAllowed = options.allow ?? 0;
  const capture = options.capture === true;
  Object.defineProperty(runtime, "treasuryCore", {
    configurable: true,
    get: () => liveValue,
    set(value: unknown) {
      if (allowed < maxAllowed) {
        allowed += 1;
        liveValue = value;
        if (capture) captures.push(JSON.stringify(value));
        if (options.onAllow !== undefined) options.onAllow(value);
        return;
      }
      dropped += 1;
    },
  });
  return {
    restore: () => {
      delete runtime.treasuryCore;
      runtime.treasuryCore = liveValue; // 保留实际最终值（V3：不回滚已放行写入）
    },
    allowedCount: () => allowed,
    droppedCount: () => dropped,
    capturedWrites: () => captures.slice(),
    liveValue: () => liveValue,
  };
}

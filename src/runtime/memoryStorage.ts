import { createPermitChainSegmentStore } from "@/runtime/permitChainSegments";
import { setPermitChainStorageBlocked } from "@/runtime/permitChainStorageGuard";

export function createMemoryStorage() {
  const permitChainStore = createPermitChainSegmentStore();

  function begin(): void {
    try { permitChainStore.begin(); }
    catch { setPermitChainStorageBlocked("storage_begin_failed"); }
  }

  /**
   * 驱动在 loop、console 之后读取 _parsed 才落盘。getter 返回当前冷投影，
   * 由驱动原生序列化；提前读取也不落盘，不会丢失后续 console 修改。
   * 业务 Memory 保持完整。无兼容接口时取消分段切换，保存完整链。
   * _parsed 是可选兼容接口；默认配置不安装 getter，也不拦截普通 Memory。
   */
  function finish(): void {
    const raw = RawMemory as typeof RawMemory & { _parsed?: Memory };
    const descriptor = Object.getOwnPropertyDescriptor(raw, "_parsed");
    if (!descriptor?.configurable || !("value" in descriptor) || descriptor.value !== Memory) {
      permitChainStore.persistInline();
      return;
    }
    permitChainStore.prepare();
    if (!permitChainStore.needsPersistence()) return;
    let parsed = descriptor.value as Memory;
    let replaced = false;
    Object.defineProperty(raw, "_parsed", {
      configurable: true, enumerable: descriptor.enumerable,
      set(value: Memory) { parsed = value; replaced = true; },
      get() { return replaced ? parsed : permitChainStore.project(parsed); },
    });
  }
  return { begin, finish, status: permitChainStore.status };
}

const memoryStorage = createMemoryStorage();
export const beginMemoryStorageTick = memoryStorage.begin;
export const finishMemoryStorageTick = memoryStorage.finish;

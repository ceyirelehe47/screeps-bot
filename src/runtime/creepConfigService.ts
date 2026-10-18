import { type RuntimeMemoryService } from "@/runtime/memoryService";
import { isRoleName } from "@/types/roleCatalog";
import { type CreepApi, type CreepConfig, type RoleName } from "@/types/system";

export type CreepConfigEntry = readonly [name: string, config: CreepConfig];
export interface CreepConfigReadIndex {
  readonly revision: number;
  readonly entries: readonly CreepConfigEntry[];
  readonly names: readonly string[];
  byRoom(roomName: string): readonly CreepConfigEntry[];
  byRole(role: RoleName): readonly CreepConfigEntry[];
}
export interface CreepConfigService extends CreepApi {
  upsert(configName: string, role: RoleName, args: readonly string[], roomName?: string): void;
  set(configName: string, config: CreepConfig): boolean;
  patch(configName: string, patch: Partial<CreepConfig>): boolean;
  detachSpawn(configName: string): boolean;
  readStore(): Readonly<Record<string, CreepConfig>>;
  getReadIndex(): CreepConfigReadIndex;
}

const EMPTY: readonly CreepConfigEntry[] = Object.freeze([]);
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function sameArray(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return right.every((value, index) => hasOwn(left, String(index)) && Object.is(left[index], value));
}
function sameConfig(left: CreepConfig | undefined, right: CreepConfig): boolean {
  if (!left) return false;
  const keys = Object.keys(left) as Array<keyof CreepConfig>;
  return keys.length === Object.keys(right).length && keys.every(key => {
    if (!hasOwn(right, key)) return false;
    if (key === "args" || key === "body") return Object.is(left[key], right[key]) || sameArray(left[key], right[key]);
    if (key === "spawnOnce") return Object.is(left.spawnOnce, right.spawnOnce) || !!left.spawnOnce && !!right.spawnOnce &&
      Object.keys(left.spawnOnce).length === Object.keys(right.spawnOnce).length &&
      Object.keys(right.spawnOnce).every(field => hasOwn(left.spawnOnce!, field) &&
        Object.is(Reflect.get(left.spawnOnce!, field), Reflect.get(right.spawnOnce!, field)));
    return Object.is(left[key], right[key]);
  });
}
function freezeConfig(config: CreepConfig): CreepConfig {
  if (Array.isArray(config.args)) Object.freeze(config.args);
  if (Array.isArray(config.body)) Object.freeze(config.body);
  if (config.spawnOnce && typeof config.spawnOnce === "object") Object.freeze(config.spawnOnce);
  return Object.freeze(config);
}

/** 配置子树唯一生产写入者；读视图不可变，写入统一推进 revision。 */
export function createCreepConfigService(memory: RuntimeMemoryService): CreepConfigService {
  let root: Record<string, CreepConfig> | undefined;
  let revision = 0;
  let index: { tick: number; value: CreepConfigReadIndex } | undefined;
  const store = () => {
    const current = memory.getCreepConfigStore();
    if (current !== root) { root = current; revision++; index = undefined; }
    return current;
  };
  const changed = () => { revision++; index = undefined; };
  const service: CreepConfigService = {
    add(name, role, ...args) {
      service.set(name, { role, args });
      return `${name} updated: role=${role}, args=${args.join(",")}`;
    },
    remove(name) {
      const configs = store();
      if (hasOwn(configs, name)) { delete configs[name]; changed(); }
      return `${name} removed`;
    },
    get(name) {
      const configs = store();
      return hasOwn(configs, name) ? freezeConfig(configs[name]) : undefined;
    },
    list(prefix) {
      return Object.freeze(Object.fromEntries(service.getReadIndex().entries.filter(([name]) => !prefix || name.startsWith(prefix))));
    },
    readStore() { return view; },
    upsert(name, role, args, roomName) { service.set(name, { role, args: [...args], roomName }); },
    set(name, config) {
      if (!isRoleName(config.role) || !Array.isArray(config.args)) throw new Error(`invalid creep config: ${name}`);
      for (let index = 0; index < config.args.length; index++) {
        if (!hasOwn(config.args, String(index)) || typeof config.args[index] !== "string") throw new Error(`invalid creep config args: ${name}`);
      }
      const configs = store();
      if (sameConfig(hasOwn(configs, name) ? configs[name] : undefined, config)) return false;
      const next = freezeConfig({ ...config, args: [...config.args],
        ...(config.body ? { body: [...config.body] } : {}), ...(config.spawnOnce ? { spawnOnce: { ...config.spawnOnce } } : {}) });
      Object.defineProperty(configs, name, { value: next, writable: true, configurable: true, enumerable: true });
      changed(); return true;
    },
    patch(name, patch) {
      const current = service.get(name);
      if (!current) return false;
      const next = { ...current, ...patch };
      for (const key of Object.keys(patch) as Array<keyof CreepConfig>) if (patch[key] === undefined && key !== "role" && key !== "args") delete next[key];
      return service.set(name, next);
    },
    detachSpawn(name) {
      const current = service.get(name);
      if (!current?.roomName) return false;
      const { roomName: _roomName, ...next } = current;
      return service.set(name, next);
    },
    getReadIndex() {
      const configs = store();
      if (index?.tick === Game.time && index.value.revision === revision) return index.value;
      const entries = Object.freeze(Object.entries(configs).map(([name, config]) => Object.freeze([name, freezeConfig(config)] as const)));
      const rooms = new Map<string, CreepConfigEntry[]>(), roles = new Map<RoleName, CreepConfigEntry[]>();
      for (const entry of entries) {
        const [, config] = entry;
        if (config.roomName) { const rows = rooms.get(config.roomName) ?? []; rows.push(entry); rooms.set(config.roomName, rows); }
        const rows = roles.get(config.role) ?? []; rows.push(entry); roles.set(config.role, rows);
      }
      for (const rows of [...rooms.values(), ...roles.values()]) Object.freeze(rows);
      const value = Object.freeze({ revision, entries, names: Object.freeze(entries.map(([name]) => name)),
        byRoom: (name: string) => rooms.get(name) ?? EMPTY, byRole: (role: RoleName) => roles.get(role) ?? EMPTY });
      index = { tick: Game.time, value }; return value;
    },
  };
  // 兼容按名读取的现有调用方，但所有写入必须经过 owner API。
  // 枚举键同样取自 revision 索引，不另建全量扫描或可写别名。
  const view: Readonly<Record<string, CreepConfig>> = new Proxy(Object.create(null), {
    get: (_target, key) => typeof key === "string" ? service.get(key) : undefined,
    ownKeys: () => [...service.getReadIndex().names],
    has: (_target, key) => typeof key === "string" && hasOwn(store(), key),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && hasOwn(store(), key)
      ? { configurable: true, enumerable: true, writable: false, value: service.get(key) } : undefined,
    set: () => false, deleteProperty: () => false, defineProperty: () => false,
    setPrototypeOf: () => false, preventExtensions: () => false,
  });
  return service;
}

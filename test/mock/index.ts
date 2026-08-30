import * as lodash from "lodash";
import type { LoDashStatic } from "lodash";

class GameMock {
  public creeps: Record<string, Creep> = {};
  public flags: Record<string, Flag> = {};
  public rooms: Record<string, Room> = {};
  public spawns: Record<string, StructureSpawn> = {};
  public time = 1;
  /** 测试注入的对象表（treasury object-ID binding 验证用；缺省返回 undefined）。 */
  public objects: Record<string, { id: string; structureType?: string; room?: { name: string } }> = {};
  public getObjectById<T extends { id: string }>(id: string): T | null {
    const found = this.objects[id];
    return (found as unknown as T) ?? null;
  }
}

class MemoryMock {
  public creeps: Record<string, CreepMemory> = {};
  public rooms: Record<string, RoomMemory> = {};
}

type MockClass<T> = new () => T;

function getMock<T>(klass: MockClass<T>): (props?: Partial<T>) => T {
  return (props: Partial<T> = {}): T => Object.assign(new klass(), props);
}

const getMockGame = getMock<Game>(GameMock as unknown as MockClass<Game>);
const getMockMemory = getMock<Memory>(MemoryMock as unknown as MockClass<Memory>);

export function refreshGlobalMock(): void {
  Object.assign(global, {
    Game: getMockGame(),
    Memory: getMockMemory(),
    _: lodash as unknown as LoDashStatic,
  });
  Object.assign(global, require("@screeps/common/lib/constants"));
}

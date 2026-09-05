import { refreshGlobalMock } from "@mock/index";
import { registerDefaultTreasuryTestPolicyForSetup, unsealTreasuryPolicyRegistryForTest } from "@/runtime/treasury/policyAuthority";


// 第十轮：默认 test policy（无 reserve）——production 授权的 policy authority
// 前置；显式 fail closed 用例自行 clearTreasuryPolicyResolversForTest。
// 第十一轮：policy registry 默认 unseal（adapter registry 的 unseal 在
// clearTreasuryPersistenceForTest——本文件顶层不得 import actionContracts：
// 其模块体读取 RESOURCES_ALL，而常量在 refreshGlobalMock() 后才定义）。
beforeEach(() => {
  registerDefaultTreasuryTestPolicyForSetup();
  unsealTreasuryPolicyRegistryForTest();
});

const __resetRoomVisualCalls = (): void => {
  (global as any).__roomVisualCalls = [];
};

class RoomVisualMock {
  private roomName: string;
  constructor(roomName?: string) {
    this.roomName = roomName ?? "";
  }
  public text(...args: any[]): RoomVisualMock {
    (global as any).__roomVisualCalls.push({ roomName: this.roomName, method: "text", args });
    return this;
  }
  public circle(...args: any[]): RoomVisualMock {
    (global as any).__roomVisualCalls.push({ roomName: this.roomName, method: "circle", args });
    return this;
  }
  public rect(...args: any[]): RoomVisualMock {
    (global as any).__roomVisualCalls.push({ roomName: this.roomName, method: "rect", args });
    return this;
  }
  public poly(...args: any[]): RoomVisualMock {
    (global as any).__roomVisualCalls.push({ roomName: this.roomName, method: "poly", args });
    return this;
  }
  public line(...args: any[]): RoomVisualMock {
    (global as any).__roomVisualCalls.push({ roomName: this.roomName, method: "line", args });
    return this;
  }
}

Object.assign(global, {
  RoomVisual: RoomVisualMock,
  __resetRoomVisualCalls,
});

__resetRoomVisualCalls();
refreshGlobalMock();
// 【Core Rewrite I】旧协议栈（resolution cleanup handlers / proof probes /
// recovery driver）已退役删除，全局装配不再 require 已删模块。新内核的
// 装配经 facade 的显式 createTreasuryService 完成（测试各自构造 service）。
beforeEach(() => {
  __resetRoomVisualCalls();
  refreshGlobalMock();
});

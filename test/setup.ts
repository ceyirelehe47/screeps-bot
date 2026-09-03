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
// 【Round 22 Remediation III】cleanup stage handlers / proof probes /
// recovery driver 全局装配：模拟生产模块图（facade 加载即装配），使直接
// 调用 resolutionStore/coordinator/journal 恢复的底层测试与生产入口共享同一阶段外部事实
// 验证器。延迟到 refreshGlobalMock 之后（模块图中部分模块顶层读取 RESOURCES_ALL）；显式
// fail-closed 用例仍可在自己的 beforeEach 里
// registerTreasuryResolutionCleanupHandlersForAssembly(null) 覆盖（测试文件的 beforeEach 在本文件的
// beforeEach 之后执行）。
require("@/runtime/treasury/resolutionCleanupStageHandlers");
beforeEach(() => {
  __resetRoomVisualCalls();
  refreshGlobalMock();
});

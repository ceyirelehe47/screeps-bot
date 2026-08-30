import { refreshGlobalMock } from "@mock/index";
import { registerDefaultTreasuryTestPolicyForSetup } from "@/runtime/treasury/policyAuthority";

// 第十轮：默认 test policy（无 reserve）——production 授权的 policy authority
// 前置；显式 fail closed 用例自行 clearTreasuryPolicyResolversForTest。
beforeEach(() => {
  registerDefaultTreasuryTestPolicyForSetup();
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
beforeEach(() => {
  __resetRoomVisualCalls();
  refreshGlobalMock();
});

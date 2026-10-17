import { createTreasuryService } from "@/runtime/treasury/facade";
import { cancelAutomaticResourceTransferTaskForReplan, createAutomaticResourceTransferTask, createResourceTransferTask, patchResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { resetRuntimeServices } from "@mock/movement";

describe("重规划取消的同 tick 承诺失效", () => {
  beforeEach(() => {
    Game.time = 100; Game.rooms = {}; Game.creeps = {};
    Memory.data = undefined; Memory.runtime = undefined; Memory.cfg = undefined;
    resetRuntimeServices();
  });
  it("真实 Treasury facade 在取消后重建；旧快照保持点时值与审计字段", () => {
    const created = createAutomaticResourceTransferTask("W1N1", "W2N2", RESOURCE_HYDROGEN, 500, "synthesis:direct:H");
    if (typeof created === "string") throw new Error(created);
    const service = createTreasuryService({ getRooms: () => [] });
    const before = service.commitments();
    expect(before.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(500);
    expect(cancelAutomaticResourceTransferTaskForReplan(created.task.id)).toBe(true);
    const after = service.commitments();
    expect(Game.time).toBe(100);
    expect(after).not.toBe(before);
    expect(after.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(0);
    expect(before.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(500);
    expect(service.commitments()).toBe(after);
    expect(created.task).toMatchObject({ status: "cancelled", updatedAt: 100, lastError: "cancelled_by_replan" });
    expect(cancelAutomaticResourceTransferTaskForReplan(created.task.id)).toBe(false);
    expect(service.commitments()).toBe(after);
  });
  it("缺失、手动或终态任务不会被重规划入口改写", () => {
    const manual = createResourceTransferTask("W1N1", "W2N2", RESOURCE_HYDROGEN, 500);
    if (typeof manual === "string") throw new Error(manual);
    const service = createTreasuryService({ getRooms: () => [] });
    const snapshot = service.commitments();
    expect(cancelAutomaticResourceTransferTaskForReplan("missing")).toBe(false);
    expect(cancelAutomaticResourceTransferTaskForReplan(manual.task.id)).toBe(false);
    expect(manual.task.status).toBe("pending");
    expect(service.commitments()).toBe(snapshot);
  });
  it("patch API 修改数量/终态后同 tick 重查真实 facade；相同值不重复失效", () => {
    const created = createAutomaticResourceTransferTask("W1N1", "W2N2", RESOURCE_HYDROGEN, 500, "synthesis:direct:H");
    if (typeof created === "string") throw new Error(created);
    const service = createTreasuryService({ getRooms: () => [] });
    const before = service.commitments();
    expect(before.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(500);
    expect(patchResourceTransferTask(created.task, { remainingAmount: 200, updatedAt: Game.time })).toBe(true);
    const after = service.commitments();
    expect(after.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(200);
    expect(before.outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(500);
    expect(patchResourceTransferTask(created.task, { remainingAmount: 200, updatedAt: Game.time })).toBe(false);
    expect(service.commitments()).toBe(after);
    patchResourceTransferTask(created.task, { status: "done" });
    expect(service.commitments().outgoing("W1N1", RESOURCE_HYDROGEN)).toBe(0);
  });
});

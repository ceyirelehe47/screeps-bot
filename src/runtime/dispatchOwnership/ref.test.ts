import {
  createCarrierDispatchRef,
  createWorkerDispatchRef,
  isValidDispatchRoomName,
} from "@/runtime/dispatchOwnership/ref";

describe("local dispatch structured refs", () => {
  test("保留本地派发系统和 namespace 字面量", () => {
    const worker = createWorkerDispatchRef("W1N1", "build:1");
    const carrier = createCarrierDispatchRef("producer:a", "W1N1", "haul:1");

    expect(worker).toEqual({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "build:1",
    });
    expect(carrier?.system).toBe("carrier-logistics");
  });

  test("accepts Screeps room names and rejects empty and prototype-like outer scopes", () => {
    expect(["W0N0", "E12S34", "sim"].every(isValidDispatchRoomName)).toBe(true);
    expect(["", "W1", "__proto__", "constructor", "toString", "W-1N1"]
      .some(isValidDispatchRoomName)).toBe(false);
    expect(createWorkerDispatchRef("constructor", "task")).toBeUndefined();
    expect(createCarrierDispatchRef("producer", "__proto__", "task")).toBeUndefined();
    expect(createCarrierDispatchRef("", "W1N1", "task")).toBeUndefined();
  });
});

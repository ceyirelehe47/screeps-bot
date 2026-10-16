import { requestMemorySegments } from "@/runtime/memorySegments";

function installRawMemory(): jest.Mock {
  const setActiveSegments = jest.fn();
  (global as typeof global & { RawMemory: typeof RawMemory }).RawMemory =
    { segments: {}, setActiveSegments } as unknown as typeof RawMemory;
  return setActiveSegments;
}

describe("Memory segment 激活协调", () => {
  it("合并不同使用者的请求、去重，并在下一 tick 清除旧申请", () => {
    const activate = installRawMemory();
    requestMemorySegments([3, 3]);
    requestMemorySegments([90]);
    requestMemorySegments([3]);
    expect(activate.mock.calls).toEqual([[[3]], [[3, 90]]]);
    Game.time++;
    requestMemorySegments([42]);
    expect(activate).toHaveBeenLastCalledWith([42]);
  });

  it("非法及超限申请整批拒绝，保留已有使用者的激活集合", () => {
    const activate = installRawMemory();
    requestMemorySegments([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => requestMemorySegments([9, 10])).toThrow(RangeError);
    for (const invalid of [-1, 100, 1.2, NaN, Infinity]) {
      expect(() => requestMemorySegments([9, invalid])).toThrow(RangeError);
    }
    expect(activate).toHaveBeenCalledTimes(1);
    requestMemorySegments([9]);
    expect(activate).toHaveBeenLastCalledWith([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("原生调用失败后可重试，RawMemory 更换或 tick 回退时重新申请", () => {
    const activate = installRawMemory();
    activate.mockImplementationOnce(() => { throw new Error("native failure"); });
    expect(() => requestMemorySegments([90])).toThrow("native failure");
    requestMemorySegments([90]);
    expect(activate).toHaveBeenCalledTimes(2);
    const replacement = installRawMemory();
    requestMemorySegments([90]);
    expect(replacement).toHaveBeenCalledWith([90]);
    Game.time--;
    requestMemorySegments([5]);
    expect(replacement).toHaveBeenLastCalledWith([5]);
  });
});

import {
  getTargetPos,
  parseEncodedRouteRooms,
} from "@/movement/common";
import { MockRoomPosition, setupRoomPositionGlobal } from "@mock/movement";

describe("getTargetPos", () => {
  beforeEach(() => {
    setupRoomPositionGlobal();
  });

  it("returns the position directly when target is a RoomPosition", () => {
    const pos = new MockRoomPosition(10, 20, "W1N1") as unknown as RoomPosition;
    expect(getTargetPos(pos)).toBe(pos);
  });
});

describe("parseEncodedRouteRooms", () => {

  it("parses pipe-delimited room names", () => {
    expect(parseEncodedRouteRooms("W1N1|W1N2|W1N3")).toEqual(["W1N1", "W1N2", "W1N3"]);
  });

  it("跨 tick 复用纯解析，调用方改写数组不改变后来路线", () => {
    const encoded = " W11N1 | | W11N2 | W11N1 ";
    const split = jest.spyOn(String.prototype, "split");
    try {
      const first = parseEncodedRouteRooms(encoded);
      expect(first).toEqual(["W11N1", "W11N2", "W11N1"]);
      first.splice(0, first.length, "caller-only");
      Game.time++;
      expect(parseEncodedRouteRooms(encoded)).toEqual(["W11N1", "W11N2", "W11N1"]);
      expect(split.mock.calls.filter((_, index) => split.mock.contexts[index] === encoded)).toHaveLength(1);
    } finally {
      split.mockRestore();
    }
  });

  it("路线输入改变后立即解析新值，超长输入仍可完整解析", () => {
    expect(parseEncodedRouteRooms("E19S1|E19S2")).toEqual(["E19S1", "E19S2"]);
    expect(parseEncodedRouteRooms("E19S1|E19S3")).toEqual(["E19S1", "E19S3"]);
    const long = "W12N1|".repeat(900);
    expect(parseEncodedRouteRooms(long)).toEqual(Array(900).fill("W12N1"));
    expect(parseEncodedRouteRooms(undefined)).toEqual([]);
    expect(parseEncodedRouteRooms(" | ")).toEqual([]);
  });
});

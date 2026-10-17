import { getSourceAdjacentLinks } from "@/runtime/sourceLink";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

const roomPositionHost = global as typeof global & { RoomPosition?: typeof RoomPosition };
let originalRoomPosition: typeof RoomPosition | undefined;
beforeEach(() => {
  originalRoomPosition = roomPositionHost.RoomPosition;
  Object.assign(global, { RoomPosition: class {
    constructor(public x: number, public y: number, public roomName: string) {}
  } });
});
afterEach(() => {
  if (originalRoomPosition) roomPositionHost.RoomPosition = originalRoomPosition;
  else delete roomPositionHost.RoomPosition;
});

it("只接管采集工作位相邻且激活的 link", () => {
  registerRuntimeServices(undefined); Game.time++;
  const pos = (x: number, y: number) => ({ x, y, roomName: "W1N1", getRangeTo(other: { x: number; y: number }) {
    return Math.max(Math.abs(x - other.x), Math.abs(y - other.y));
  } }) as RoomPosition;
  const links = [
    { id: "adjacent", pos: pos(11, 11), structureType: STRUCTURE_LINK, isActive: () => true },
    { id: "wrong-work-tile", pos: pos(9, 9), structureType: STRUCTURE_LINK, isActive: () => true },
    { id: "inactive", pos: pos(11, 9), structureType: STRUCTURE_LINK, isActive: () => false },
  ] as unknown as StructureLink[];
  const room = { name: "W1N1", find: () => links } as unknown as Room;
  Game.rooms = { W1N1: room };
  Memory.data = { roomPlanner: { W1N1: { layout: { work_pos: [{ x: 11, y: 10 }] } } } } as unknown as Memory["data"];
  const source = { id: "source", room, pos: pos(10, 10) } as unknown as Source;
  expect(getSourceAdjacentLinks(source).map(link => link.id)).toEqual(["adjacent"]);
});

it("没有布局时仍按实际 Container 工作位排除隔着矿点的 link", () => {
  registerRuntimeServices(undefined); Game.time++;
  const pos = (x: number) => ({ x, y: 10, roomName: "W2N2", getRangeTo(other: { x: number; y: number }) {
    return Math.max(Math.abs(x - other.x), Math.abs(10 - other.y));
  } }) as RoomPosition;
  const container = { structureType: STRUCTURE_CONTAINER, pos: pos(11) };
  const link = { id: "opposite", structureType: STRUCTURE_LINK, pos: pos(9), isActive: () => true };
  const room = { name: "W2N2", find: () => [container, link] } as unknown as Room;
  Game.rooms = { W2N2: room }; Memory.data = {};
  const source = { id: "unplanned-source", room, pos: pos(10) } as unknown as Source;
  expect(getSourceAdjacentLinks(source)).toHaveLength(0);
});

import { getPlannedSourceContainerPos } from "@/runtime/sourceWorkPosition";
import { getTickContextService } from "@/runtime/runtimeServices";

const SOURCE_LINK_RANGE = 2;

let sourceLinkCacheTick = -1;
const sourceAdjacentLinksBySourceId = new Map<Id<Source>, { source: Source; links: StructureLink[] }>();

function resetSourceLinkCacheForTick(): void {
  if (sourceLinkCacheTick === Game.time) {
    return;
  }

  sourceAdjacentLinksBySourceId.clear();
  sourceLinkCacheTick = Game.time;
}

export function getSourceAdjacentLinks(source: Source): StructureLink[] {
  resetSourceLinkCacheForTick();

  const cached = sourceAdjacentLinksBySourceId.get(source.id);
  if (cached?.source === source) {
    return cached.links;
  }

  const tickContext = getTickContextService();
  const canUseRoomContext = typeof source.room.find === "function";
  const roomContext = canUseRoomContext ? tickContext.getRoomContext?.(source.room) : null;
  const links = roomContext
    ? roomContext.getLinks().filter((link) => link.pos.getRangeTo(source.pos) <= SOURCE_LINK_RANGE)
    : (source.pos.findInRange(FIND_MY_STRUCTURES, SOURCE_LINK_RANGE, {
        filter: (structure) => structure.structureType === STRUCTURE_LINK,
      }) as StructureLink[]);

  const fallbackContainer = roomContext?.getContainers().find(container => container.pos.getRangeTo(source.pos) <= 1);
  const workPos = getPlannedSourceContainerPos(source) ?? fallbackContainer?.pos;
  const usable = links.filter(link => (typeof link.isActive !== "function" || link.isActive()) &&
    link.pos.getRangeTo(workPos ?? source.pos) <= 1);
  sourceAdjacentLinksBySourceId.set(source.id, { source, links: usable });
  return usable;
}

export function getSourceAdjacentLink(source: Source): StructureLink | null {
  const links = getSourceAdjacentLinks(source);
  if (links.length === 0) {
    return null;
  }

  return source.pos.findClosestByRange(links) as StructureLink | null;
}

export function hasSourceAdjacentLink(source: Source): boolean {
  return getSourceAdjacentLinks(source).length > 0;
}

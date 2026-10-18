import { runIsolatedRoomOperation } from "@/runtime/runtimeIsolation";
import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  peekLinkRoomRuntime,
  writeLinkRoomRuntime,
  type LinkRoomRuntimeSnapshot,
  type LinkRoomRuntimeView,
} from "@/runtime/linkNetworkMemory";
import { getTickContextService } from "@/runtime/runtimeServices";
import { isRemoteEntranceLink } from "@/runtime/remoteEntranceLink";

const CLASSIFY_INTERVAL = 11;
const LINKED_SOURCE_CONTAINER_CLEANUP_INTERVAL = 101;
const SOURCE_SENDER_RANGE = 2;
const STORAGE_RECEIVER_RANGE = 2;
const CONTROLLER_RECEIVER_RANGE = 3;
const RECEIVER_FILL_THRESHOLD = 0.5;

const linkedSourceContainerCleanupTicks = new Map<string, number>();

function classifyRoomLinks(room: Room): LinkRoomRuntimeSnapshot {
  const roomContext = getTickContextService().getRoomContext(room);
  const links = roomContext?.getLinks() || [];
  const sources = roomContext?.getSources() || [];
  const storagePos = room.storage?.pos;
  const controllerPos = room.controller?.pos;

  const senderIds: string[] = [];
  const receiverIds: string[] = [];

  for (const link of links) {
    const nearReceiver =
      (!!storagePos && link.pos.getRangeTo(storagePos) <= STORAGE_RECEIVER_RANGE) ||
      (!!controllerPos && link.pos.getRangeTo(controllerPos) <= CONTROLLER_RECEIVER_RANGE);

    if (nearReceiver) {
      receiverIds.push(link.id);
      continue;
    }

    const nearSource = sources.some((source) => link.pos.getRangeTo(source.pos) <= SOURCE_SENDER_RANGE);
    if (nearSource || isRemoteEntranceLink(link)) {
      senderIds.push(link.id);
    }
  }

  return {
    updatedAt: Game.time,
    senderIds,
    receiverIds,
  };
}

function getRoomLinkRuntime(room: Room): LinkRoomRuntimeView {
  const existing = peekLinkRoomRuntime(room.name);
  if (!existing || Game.time - existing.updatedAt >= CLASSIFY_INTERVAL) {
    const refreshed = classifyRoomLinks(room);
    writeLinkRoomRuntime(room.name, refreshed);
    return refreshed;
  }

  return existing;
}

function isReceiverByPosition(link: StructureLink): boolean {
  const storagePos = link.room.storage?.pos;
  const controllerPos = link.room.controller?.pos;
  return (
    (!!storagePos && link.pos.getRangeTo(storagePos) <= STORAGE_RECEIVER_RANGE) ||
    (!!controllerPos && link.pos.getRangeTo(controllerPos) <= CONTROLLER_RECEIVER_RANGE)
  );
}

function isStorageReceiverByPosition(link: StructureLink): boolean {
  const storagePos = link.room.storage?.pos;
  if (!storagePos) {
    return false;
  }

  if (link.pos.getRangeTo(storagePos) <= STORAGE_RECEIVER_RANGE) {
    return true;
  }

  const controllerPos = link.room.controller?.pos;
  return (
    hasSharedStorageControllerLinkCluster(link.room) &&
    !!controllerPos &&
    link.pos.getRangeTo(controllerPos) <= CONTROLLER_RECEIVER_RANGE
  );
}

function isLinkUnderfilled(link: StructureLink): boolean {
  const capacity = link.store.getCapacity(RESOURCE_ENERGY);
  if (!capacity || capacity <= 0) {
    return false;
  }

  const used = link.store.getUsedCapacity(RESOURCE_ENERGY);
  return used / capacity < RECEIVER_FILL_THRESHOLD;
}

function isControllerReceiver(link: StructureLink): boolean {
  if (hasSharedStorageControllerLinkCluster(link.room)) {
    return false;
  }

  const controllerPos = link.room.controller?.pos;
  return !!controllerPos && link.pos.getRangeTo(controllerPos) <= CONTROLLER_RECEIVER_RANGE;
}

export function hasSharedStorageControllerLinkCluster(room: Room): boolean {
  const storagePos = room.storage?.pos;
  const controllerPos = room.controller?.pos;
  return (
    !!storagePos &&
    !!controllerPos &&
    storagePos.getRangeTo(controllerPos) <= STORAGE_RECEIVER_RANGE + CONTROLLER_RECEIVER_RANGE
  );
}

function chooseReceiverTarget(sender: StructureLink, receiverLinks: StructureLink[], incoming: ReadonlyMap<string, number>): StructureLink | null {
  const validReceivers = receiverLinks
    .filter((receiver) => receiver.id !== sender.id && isLinkUnderfilled(receiver) && receiver.store.getFreeCapacity(RESOURCE_ENERGY) > (incoming.get(receiver.id) ?? 0))
    .sort((a, b) => {
      const entrySender = isRemoteEntranceLink(sender);
      const aControllerPriority = (entrySender ? isStorageReceiverByPosition(a) : isControllerReceiver(a)) ? 0 : 1;
      const bControllerPriority = (entrySender ? isStorageReceiverByPosition(b) : isControllerReceiver(b)) ? 0 : 1;
      if (aControllerPriority !== bControllerPriority) {
        return aControllerPriority - bControllerPriority;
      }

      const aCapacity = a.store.getCapacity(RESOURCE_ENERGY) || 1;
      const bCapacity = b.store.getCapacity(RESOURCE_ENERGY) || 1;
      const aFill = a.store.getUsedCapacity(RESOURCE_ENERGY) / aCapacity;
      const bFill = b.store.getUsedCapacity(RESOURCE_ENERGY) / bCapacity;
      if (aFill !== bFill) {
        return aFill - bFill;
      }

      return sender.pos.getRangeTo(a.pos) - sender.pos.getRangeTo(b.pos);
    });

  return validReceivers[0] || null;
}

function cleanupLinkedSourceContainers(room: Room): void {
  const lastCleanupTick = linkedSourceContainerCleanupTicks.get(room.name);
  if (lastCleanupTick !== undefined && Game.time - lastCleanupTick < LINKED_SOURCE_CONTAINER_CLEANUP_INTERVAL) {
    return;
  }

  linkedSourceContainerCleanupTicks.set(room.name, Game.time);

  const roomContext = getTickContextService().getRoomContext(room);
  const sources = roomContext?.getSources() || [];
  const containers = roomContext?.getContainers() || [];
  const sites = roomContext?.getConstructionSites() || [];

  for (const source of sources) {
    if (!hasSourceAdjacentLink(source)) {
      continue;
    }

    for (const container of containers) {
      if (container.pos.getRangeTo(source.pos) > 1) {
        continue;
      }
      container.destroy();
    }

    for (const site of sites) {
      if (site.structureType !== STRUCTURE_CONTAINER || site.pos.getRangeTo(source.pos) > 1) {
        continue;
      }
      site.remove();
    }
  }
}

export function isReceiverLink(link: StructureLink): boolean {
  const roomData = peekLinkRoomRuntime(link.room.name);
  if (!roomData) {
    return isReceiverByPosition(link);
  }

  return roomData.receiverIds.includes(link.id) || isReceiverByPosition(link);
}

export function isStorageReceiverLink(link: StructureLink): boolean {
  const roomData = peekLinkRoomRuntime(link.room.name);
  if (!roomData) {
    return isStorageReceiverByPosition(link);
  }

  return roomData.receiverIds.includes(link.id) && isStorageReceiverByPosition(link);
}

export function runLinkControl(): void {
  const myRooms = getTickContextService().getMyRooms();

  for (const room of myRooms) {
    runIsolatedRoomOperation("runLinkControl", room.name, () => {
    cleanupLinkedSourceContainers(room);

    const roomData = getRoomLinkRuntime(room);
    if (roomData.senderIds.length === 0 || roomData.receiverIds.length === 0) {
      return 0 as const;
    }

    const senderLinks = roomData.senderIds
      .map((id) => Game.getObjectById(id as Id<StructureLink>))
      .filter((link): link is StructureLink => !!link);
    const receiverLinks = roomData.receiverIds
      .map((id) => Game.getObjectById(id as Id<StructureLink>))
      .filter((link): link is StructureLink => !!link);

    if (senderLinks.length === 0 || receiverLinks.length === 0) {
      return 0 as const;
    }

    const incoming = new Map<string, number>();
    for (const sender of senderLinks) {
      if (sender.cooldown > 0 || sender.store.getUsedCapacity(RESOURCE_ENERGY) < 400) {
        continue;
      }

      const target = chooseReceiverTarget(sender, receiverLinks, incoming);
      if (!target) {
        continue;
      }

      const free = target.store.getFreeCapacity(RESOURCE_ENERGY) - (incoming.get(target.id) ?? 0);
      const amount = Math.min(sender.store.getUsedCapacity(RESOURCE_ENERGY), free);
      if (amount <= 0) continue;
      const code = sender.transferEnergy(target, amount);
      if (code === OK) {
        incoming.set(target.id, (incoming.get(target.id) ?? 0) + amount - Math.ceil(amount * LINK_LOSS_RATIO));
        recordFixedCpuAction("linkControl");
      }
    }
  
      return 0 as const;
    });
  }
}

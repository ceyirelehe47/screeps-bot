import { registerOutboundMissionOwner } from "@/runtime/outboundMissionRegistry";
import { warMissionOwner } from "@/runtime/war/outbound";
import { powerBankMissionOwner } from "@/runtime/powerBankMissionPolicy";
import { depositMissionOwner } from "@/runtime/depositMissionPolicy";
import { colonizationMissionOwner } from "@/runtime/colonizationMissionPolicy";

export function registerOutboundMissionOwners(): void {
  for (const owner of [warMissionOwner, powerBankMissionOwner, depositMissionOwner, colonizationMissionOwner]) {
    registerOutboundMissionOwner(owner);
  }
}

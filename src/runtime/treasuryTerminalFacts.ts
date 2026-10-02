import { decodeTreasuryT1DurableFacts, encodeTreasuryT1DurableFacts } from "@/runtime/treasuryT1Facts";
import { decodeTreasuryT2DurableFacts, encodeTreasuryT2DurableFacts, type DurableT2Facts, type TreasuryT2EndpointFacts } from "@/runtime/treasuryT2Facts";
import { decodeTreasuryT3DurableFacts, encodeTreasuryT3DurableFacts } from "@/runtime/treasuryT3Facts";
import { decodeTreasuryT4DurableFacts, encodeTreasuryT4DurableFacts } from "@/runtime/treasuryT4Facts";
import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
export type TreasuryTerminalFacts = DurableT2Facts & { readonly sequence?: number };
export type TreasuryTerminalEndpoint = TreasuryT2EndpointFacts;
export function encodeTreasuryTerminalFacts(lane: TreasuryTerminalLane, facts: TreasuryTerminalFacts): string | null {
  if (lane.continuous) return facts.sequence === undefined ? null : encodeTreasuryT4DurableFacts({...facts,sequence:facts.sequence});
  if (lane.name === "T3") return encodeTreasuryT3DurableFacts(facts);
  if (lane.name === "T2") return encodeTreasuryT2DurableFacts(facts);
  const endpoint = (v: TreasuryTerminalEndpoint) => { const {resourceAmount,...rest} = v; return {...rest,hydrogen:resourceAmount}; };
  return encodeTreasuryT1DurableFacts({...facts,source:endpoint(facts.source),target:endpoint(facts.target)});
}
export function decodeTreasuryTerminalFacts(lane: TreasuryTerminalLane, raw: unknown): TreasuryTerminalFacts | null {
  if (lane.continuous) return decodeTreasuryT4DurableFacts(raw);
  if (lane.name === "T3") return decodeTreasuryT3DurableFacts(raw);
  if (lane.name === "T2") return decodeTreasuryT2DurableFacts(raw);
  const f = decodeTreasuryT1DurableFacts(raw); if (!f) return null;
  const endpoint = (v: typeof f.source) => { const {hydrogen,...rest} = v; return {...rest,resourceAmount:hydrogen}; };
  return {...f,source:endpoint(f.source),target:endpoint(f.target)};
}

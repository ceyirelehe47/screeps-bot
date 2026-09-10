/** New experiment entry; does NOT replace the accepted raw-API runIMain.ts.
 * One bundled main contains actual Treasury + one real adapter + raw observer.
 * The old singleShot module must NOT be installed alongside this entry. */
import { LAB_EXAMPLE_EXPERIMENT } from "../terminal-transfer/labConfig";
import { loop as observe } from "../terminal-transfer/observer";
import { TREASURY_INTEGRATION_ENABLED } from "./enabled";
import { assembleTreasuryIntegration } from "./assembly";
let runtime: ReturnType<typeof assembleTreasuryIntegration> | undefined;
export function loop(): void {
  if (!TREASURY_INTEGRATION_ENABLED) return;
  const c = LAB_EXAMPLE_EXPERIMENT;
  if (!Number.isSafeInteger(Game.time) || Game.time < c.targetTick - 2 || Game.time > c.targetTick + 20) return;
  try {
    observe(); // Any escaping observation error prevents dispatch this tick.
    runtime ??= assembleTreasuryIntegration(c);
    runtime.tick();
  } catch (error) {
    console.log(JSON.stringify({ kind: "lab-treasury-error", experimentId: c.experimentId, tick: Game.time, error: String(error).slice(0, 240) }));
  }
}

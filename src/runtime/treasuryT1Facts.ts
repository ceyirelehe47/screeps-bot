import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

export const TREASURY_T1_RUN_ID = "treasury-production-T1-2026-09-24";
export const TREASURY_T1_ACTION_KIND = "production.terminal-transfer.slice0";
export const TREASURY_T1_SOURCE_ROOM = "E3N59";
export const TREASURY_T1_TARGET_ROOM = "E4N58";
export const TREASURY_T1_WORK_KEY_PREFIX = `biz:${TREASURY_T1_RUN_ID}:`;
export const treasuryT1WorkKey = (taskId: string): string =>
  `${TREASURY_T1_WORK_KEY_PREFIX}${hashTreasuryCanonicalString(taskId)}`;

export interface TreasuryT1EndpointFacts {
  readonly id: string;
  readonly hydrogen: number;
  readonly energy: number;
  readonly used: number;
  readonly free: number;
  readonly capacity: number;
  readonly cooldown: number;
}

export interface DurableT1Facts {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly taskCreatedAt: number;
  readonly amount: number;
  readonly tick: number;
  readonly quote: number;
  readonly username: string;
  readonly source: TreasuryT1EndpointFacts;
  readonly target: TreasuryT1EndpointFacts;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const TASK_ID = /^[A-Za-z0-9:_.>\-]+$/;
const SIMPLE_ID = /^[A-Za-z0-9_.\-]+$/;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validEndpoint(value: TreasuryT1EndpointFacts): boolean {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100 &&
    SIMPLE_ID.test(value.id) &&
    [value.hydrogen, value.energy, value.used, value.free, value.capacity, value.cooldown]
      .every(nonNegativeInteger) && value.used + value.free === value.capacity;
}

/** Kernel durable payload disallows JSON quotes/backslashes. This fixed-order
 * printable encoding is shared by admission, recovery, and task commitments. */
export function encodeTreasuryT1DurableFacts(facts: DurableT1Facts): string | null {
  if (facts.schemaVersion !== 1 || facts.runId !== TREASURY_T1_RUN_ID ||
      typeof facts.taskId !== "string" || facts.taskId.length === 0 || facts.taskId.length > 80 ||
      !TASK_ID.test(facts.taskId) ||
      typeof facts.username !== "string" || facts.username.length === 0 || facts.username.length > 32 ||
      !SIMPLE_ID.test(facts.username) ||
      !nonNegativeInteger(facts.taskCreatedAt) || !nonNegativeInteger(facts.tick) ||
      !nonNegativeInteger(facts.amount) || facts.amount < 1 || facts.amount > 100 ||
      !nonNegativeInteger(facts.quote) || facts.quote > 100 ||
      !validEndpoint(facts.source) || !validEndpoint(facts.target) ||
      facts.source.id === facts.target.id) return null;
  const endpoint = (value: TreasuryT1EndpointFacts): (string | number)[] => [
    value.id, value.hydrogen, value.energy, value.used, value.free, value.capacity, value.cooldown,
  ];
  const encoded = ["t1", facts.runId, facts.taskId, facts.taskCreatedAt, facts.amount,
    facts.tick, facts.quote, facts.username, ...endpoint(facts.source), ...endpoint(facts.target)].join("|");
  return encoded.length <= 512 ? encoded : null;
}

export function decodeTreasuryT1DurableFacts(raw: unknown): DurableT1Facts | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  const parts = raw.split("|");
  if (parts.length !== 22 || parts[0] !== "t1" || parts[1] !== TREASURY_T1_RUN_ID) return null;
  const number = (index: number): number => DECIMAL.test(parts[index]) ? Number(parts[index]) : NaN;
  const endpoint = (index: number): TreasuryT1EndpointFacts => ({
    id: parts[index], hydrogen: number(index + 1), energy: number(index + 2),
    used: number(index + 3), free: number(index + 4),
    capacity: number(index + 5), cooldown: number(index + 6),
  });
  const facts: DurableT1Facts = {
    schemaVersion: 1, runId: parts[1], taskId: parts[2], taskCreatedAt: number(3),
    amount: number(4), tick: number(5), quote: number(6), username: parts[7],
    source: endpoint(8), target: endpoint(15),
  };
  return encodeTreasuryT1DurableFacts(facts) === raw ? facts : null;
}

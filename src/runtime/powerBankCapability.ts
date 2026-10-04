/** 每次读取当前存活部件与强化；能力、反伤和恢复预测不跨tick缓存。 */
export function effectivePower(body: BodyPartDefinition[], type: typeof ATTACK | typeof HEAL): number {
  const key = type === ATTACK ? "attack" : "heal";
  const base = type === ATTACK ? ATTACK_POWER : HEAL_POWER;
  const boosts = BOOSTS[type] as Record<string, { attack?: number; heal?: number } | undefined>;
  return body.reduce((sum, part) => sum + (part.type === type && part.hits > 0 ? base * (part.boost ? boosts[part.boost]?.[key] ?? 1 : 1) : 0), 0);
}

/** 与Engine tick的TOUGH容量和取整一致，失去的前部装甲不提供减伤。 */
export function damageAfterTough(body: BodyPartDefinition[], raw: number): number {
  let remaining = raw; let reduction = 0;
  for (const part of body) {
    if (remaining <= 0) break;
    const boost = part.boost ? (BOOSTS[part.type] as Record<string, { damage?: number }>)[part.boost] : undefined;
    const ratio = boost?.damage ?? 1;
    const absorbed = Math.min(Math.max(0, part.hits) / ratio, remaining);
    reduction += absorbed * (1 - ratio); remaining -= absorbed;
  }
  return raw - Math.round(reduction);
}

export function powerBankAttackSustainable(attacker: Creep, healer: Creep): boolean {
  const attack = effectivePower(attacker.body, ATTACK);
  return attack > 0 && effectivePower(healer.body, HEAL) >= damageAfterTough(attacker.body, attack * POWER_BANK_HIT_BACK);
}

interface RecoveryBody { body: BodyPartDefinition[]; hits: number; hitsMax: number }
function healBody(actor: RecoveryBody, amount: number): void {
  actor.hits = Math.min(actor.hitsMax, actor.hits + amount);
  let remaining = actor.hits;
  for (let i = actor.body.length - 1; i >= 0; i--) {
    actor.body[i].hits = Math.max(0, Math.min(100, remaining)); remaining -= actor.body[i].hits;
  }
}

/** 暂停反伤，先补攻击者缺血，再恢复治疗者；恢复期间的攻击时间不能计入DPS。 */
export function predictPowerBankRecovery(attacker: Creep, healer: Creep): { ticks: number; attack: number } {
  const attack = effectivePower(attacker.body, ATTACK);
  if (attack > 0 && attacker.body.some(part => part.type === TOUGH && part.hits > 0) && effectivePower(healer.body, HEAL) >= damageAfterTough(attacker.body, attack * POWER_BANK_HIT_BACK)) return { ticks: 0, attack };
  const red = { body: attacker.body.map((part) => ({ ...part })), hits: attacker.hits, hitsMax: attacker.hitsMax };
  const green = { body: healer.body.map((part) => ({ ...part })), hits: healer.hits, hitsMax: healer.hitsMax };
  for (let ticks = 0; ticks <= CREEP_LIFE_TIME; ticks++) {
    const attack = effectivePower(red.body, ATTACK), heal = effectivePower(green.body, HEAL);
    if (attack > 0 && red.body.some(part => part.type === TOUGH && part.hits > 0) && heal >= damageAfterTough(red.body, attack * POWER_BANK_HIT_BACK)) return { ticks, attack };
    if (heal <= 0) break;
    if (red.hits < red.hitsMax) healBody(red, heal);
    else if (green.hits < green.hitsMax) healBody(green, heal);
    else break;
  }
  return { ticks: Infinity, attack: 0 };
}

export function predictPowerBankFinishTicks(hits: number, attacker: Creep, healer?: Creep): number {
  if (!healer) { const attack = effectivePower(attacker.body, ATTACK); return attack > 0 ? Math.ceil(hits / attack) : Infinity; }
  const recovery = predictPowerBankRecovery(attacker, healer);
  return recovery.attack > 0 ? recovery.ticks + Math.ceil(hits / recovery.attack) : Infinity;
}

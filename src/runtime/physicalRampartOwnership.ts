/**
 * 【Round 22 Remediation VIII 工作流 F】房间级物理 Rampart ownership
 * snapshot——planner 与 fallback revision 共享的占用判定单一入口。
 *
 * Remediation VII 保留了"分配前已是 attack / ranged_attack / hold"的
 * actor，但晚绑定冲突仍存在：pending boundary Defender 在 allocator 候选
 * 不足后才变 hold（此刻它脚下的 Rampart 可能已被 allocator 分给另一名
 * Defender）；fallback replacement 同理。结果是两名 Defender 同 tick 拥有
 * 同一 Rampart。
 *
 * 本模块建立保守的一 tick ownership 语义（F2）：
 *  - 当前物理上被任何参与计划的 Defender 占据的合法 candidate Rampart，
 *    本 tick 不再转让给其他 Defender（occupant 自己可保留当前位置）；
 *  - 覆盖 pending boundary / replacement / 已有 entry 的全部参与 actor；
 *  - planner 与 fallback revision 共用同一入口（架构测试守护——两处不得
 *    各自维护不同 occupied 语义）；
 *  - 输入顺序无关（slot 字典序决胜——确定性）。
 */

/** 房间级候选坐标键（x,y 唯一）。 */
export function candidateKeyOf(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * 物理 ownership snapshot：defender 坐标命中候选集合时记录 footprint
 * （key → slot；同一 tile 多 defender 时 slot 字典序最小者胜——确定性，
 * 输入顺序无关）。
 */
export function collectPhysicalCandidateFootprints(
  defenders: ReadonlyArray<{ readonly slot: string; readonly x: number; readonly y: number }>,
  candidateKeys: ReadonlySet<string>,
): Map<string, string> {
  const footprints = new Map<string, string>();
  for (const defender of defenders) {
    const key = candidateKeyOf(defender.x, defender.y);
    if (!candidateKeys.has(key)) continue;
    const existing = footprints.get(key);
    if (existing === undefined || defender.slot.localeCompare(existing) < 0) {
      footprints.set(key, defender.slot);
    }
  }
  return footprints;
}

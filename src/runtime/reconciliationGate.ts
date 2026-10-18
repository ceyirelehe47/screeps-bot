/** 调和只缓存成功结果；按 owner 隔离，revision/外部事实改变即重跑，失败保留重试。 */
interface Reconciled { inputs: string; at: number }
const owners = new WeakMap<object, Map<string, Reconciled>>();
const MAX_SCOPES = 100;
const REFRESH_INTERVAL = 100;

export function shouldReconcile(owner: object, scope: string, inputs: string): boolean {
  const previous = owners.get(owner)?.get(scope);
  return !previous || previous.inputs !== inputs || Game.time < previous.at ||
    Game.time - previous.at >= REFRESH_INTERVAL;
}

export function recordReconciled(owner: object, scope: string, inputs: string): void {
  let entries = owners.get(owner);
  if (!entries) { entries = new Map(); owners.set(owner, entries); }
  entries.delete(scope);
  if (entries.size >= MAX_SCOPES) entries.delete(entries.keys().next().value!);
  entries.set(scope, { inputs, at: Game.time });
}

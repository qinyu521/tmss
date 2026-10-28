/** 对运行中的 API 做端到端冒烟：健康、种子、地图、人物、开局、命令、回合、存档、读档。 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const health = await call('/api/health');
check('健康检查', health.ok === true);
check('种子人物 336', health.seedCounts?.characters === 336, String(health.seedCounts?.characters));
check('地图节点 72', health.seedCounts?.map_nodes === 72);
check('特殊兵种 22', health.seedCounts?.military_units === 22);

const map = await call('/api/map');
check('31 条原始边', map.edges.length === 31, String(map.edges.length));

const chars = await call('/api/characters?faction=CHU&pageSize=5');
check('人物查询', chars.total === 112 && chars.items.length === 5);

const units = await call('/api/units');
check('22 兵种含派生档案', units.length === 22 && units.every((u: any) => u.profile));

const created = await call('/api/games', {
  method: 'POST',
  body: JSON.stringify({ factionKey: 'YONG', playerRole: 'ruler', seed: 20261028 }),
});
const gameId = created.gameId;
check('开局兵力 80 万', created.view.own.fieldTroops === 800000, String(created.view.own.fieldTroops));

const army = created.view.armies.find((a: any) => a.own);
const target = created.view.regions.find((r: any) => r.owned && r.regionId !== army.nodeId);
const orderRes = await call(`/api/games/${gameId}/orders`, {
  method: 'POST',
  body: JSON.stringify({
    orders: [{ orderId: 'smoke-1', kind: 'move_army', armyId: army.armyId, targetRegionId: target.regionId }],
  }),
});
check('行军命令被接受', orderRes.accepted.length === 1, orderRes.rejected?.[0]?.issues?.[0]?.message ?? '');

const turn = await call(`/api/games/${gameId}/turn`, { method: 'POST', body: '{}' });
check('回合推进到第 2 回合', turn.view.date.turn === 2, turn.view.date.label);
check('产生可见事件', turn.report.events.length > 0, String(turn.report.events.length));
check('产生史官条目', turn.report.chronicle.length > 0, String(turn.report.chronicle.length));

const saved = await call(`/api/games/${gameId}/save`, { method: 'POST', body: JSON.stringify({ label: '冒烟存档' }) });
check('手动存档', Boolean(saved.save?.saveId));
const loaded = await call(`/api/games/${gameId}/load/${saved.save.saveId}`, { method: 'POST', body: '{}' });
check('读档恢复日期', loaded.view.date.label === turn.view.date.label, loaded.view.date.label);

const detail = await call(`/api/characters/${created.persona.person_id}`);
check('人物详情含原型与关系', Boolean(detail.archetype) && Array.isArray(detail.relationships));

console.log(failures === 0 ? '\n冒烟全部通过' : `\n冒烟失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

import { useEffect, useMemo, useState } from 'react';
import {
  BALANCE,
  FACTION_VISUALS,
  ORDER_LABELS,
  ROLE_ALLOWED_ORDERS,
  ROLE_LABEL,
  SCHEME_LABELS,
  fmt,
  type Order,
  type SchemeKind,
  type CourtAgenda,
  type CourtDecision,
} from '@tianming/shared';
import { api, type CharacterSummary } from '../api/client';
import { useApp } from '../state/store';
import { Modal, Portrait, UnitIcon } from './ui';

const GROUPS = {
  military: ['move_army', 'dispatch_garrison', 'rest_army', 'scout'],
  civil: ['recruit', 'levy_grain', 'levy_tax', 'trade'],
  politics: ['hold_court', 'appease_tribe', 'balance_princes', 'negotiate_house', 'appoint'],
  scheme: ['scheme'],
} as const;

const SCHEME_COST: Record<SchemeKind, number> = {
  fire: 8_000,
  cut_supply: 6_000,
  sow_discord: 7_000,
  ambush: 4_000,
  feint: 5_000,
};

const SCHEME_DESC: Record<SchemeKind, string> = {
  fire: '焚其粮草营寨：损伤敌军兵力与补给，森林地形更易成功。需选择敌军或敌州。',
  cut_supply: '断其粮道：大幅削减敌军补给与士气，需指定一支已知敌军部队。',
  sow_discord: '离间敌国君臣：削弱敌国部落忠诚/朝局稳定/世家支持，并可打击敌军士气。',
  ambush: '在本国州府预设伏兵：下一场本州防御战获得显著加成。',
  feint: '声东击西：佯攻敌州，使其州兵分散；本回合我军进攻该州时获得加成。',
};

type TabKey = keyof typeof GROUPS;

export default function OrdersSheet() {
  const view = useApp((s) => s.view);
  const mapData = useApp((s) => s.mapData);
  const preset = useApp((s) => s.orderPreset);
  const setOrdersOpen = useApp((s) => s.setOrdersOpen);
  const submitOrders = useApp((s) => s.submitOrders);
  const cancelOrder = useApp((s) => s.cancelOrder);
  const busy = useApp((s) => s.busy);

  const role = view?.playerRole ?? 'ruler';
  const allowed = ROLE_ALLOWED_ORDERS[role];
  const [tab, setTab] = useState<TabKey>('military');
  const [action, setAction] = useState<string>('move_army');
  const [armyId, setArmyId] = useState('');
  const [target, setTarget] = useState('');
  const [moveAmount, setMoveAmount] = useState(0);
  const [unitPlan, setUnitPlan] = useState<Record<string, number>>({});
  const [commanderId, setCommanderId] = useState('');
  const [garrisonRegionId, setGarrisonRegionId] = useState('');
  const [garrisonTarget, setGarrisonTarget] = useState('');
  const [garrisonAmount, setGarrisonAmount] = useState(5000);
  const [recruitAmount, setRecruitAmount] = useState(8000);
  const [recruitRegionId, setRecruitRegionId] = useState('');
  const [recruitNew, setRecruitNew] = useState(false);
  const [regionId, setRegionId] = useState('');
  const [amount, setAmount] = useState(8000);
  const [tradeAmount, setTradeAmount] = useState(80);
  const [resource, setResource] = useState<'salt' | 'iron' | 'horses' | 'grain'>('salt');
  const [tribeId, setTribeId] = useState('');
  const [houseId, setHouseId] = useState('');
  const [appointRegion, setAppointRegion] = useState('');
  const [personId, setPersonId] = useState('');
  const [personName, setPersonName] = useState('');
  const [query, setQuery] = useState('');
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [commanders, setCommanders] = useState<CharacterSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [courtAgenda, setCourtAgenda] = useState<CourtAgenda>('war_council');
  const [courtDecision, setCourtDecision] = useState<CourtDecision>('balanced');
  const [scheme, setScheme] = useState<SchemeKind>('fire');
  const [schemeTarget, setSchemeTarget] = useState('');
  const [strategistId, setStrategistId] = useState('');
  const [result, setResult] = useState<{ previews: string[]; issues: string[] } | null>(null);

  const ownArmies = useMemo(() => view?.armies.filter((a) => a.own && a.status !== 'marching') ?? [], [view]);
  const ownRegions = useMemo(() => view?.regions.filter((r) => r.owned) ?? [], [view]);
  const garrisonRegions = useMemo(
    () => ownRegions.filter((r) => (r.garrison ?? 0) > 0),
    [ownRegions],
  );
  const enemyRegions = useMemo(() => view?.regions.filter((r) => !r.owned) ?? [], [view]);
  const enemyArmies = useMemo(() => view?.armies.filter((a) => !a.own) ?? [], [view]);

  const selectedArmy = ownArmies.find((a) => a.armyId === armyId) ?? ownArmies[0];
  const selectedGarrisonRegion = ownRegions.find((r) => r.regionId === garrisonRegionId) ?? garrisonRegions[0];

  useEffect(() => {
    if (!view) return;
    const firstArmy = view.armies.find((a) => a.own && a.status !== 'marching') ?? view.armies.find((a) => a.own);
    setArmyId((prev) => prev || (preset?.armyId as string) || firstArmy?.armyId || '');
    setGarrisonRegionId((prev) => prev || (preset?.regionId as string) || '');
    setRecruitRegionId((prev) => prev || (preset?.regionId as string) || ownRegions[0]?.regionId || '');
    setRegionId((prev) => prev || (preset?.regionId as string) || '');
    setTarget((prev) => prev || (preset?.targetRegionId as string) || '');
    setGarrisonTarget((prev) => prev || (preset?.targetRegionId as string) || '');
    setAppointRegion((prev) => prev || (preset?.regionId as string) || ownRegions[0]?.regionId || '');
    setTribeId((prev) => prev || view.special.tribes?.[0]?.tribeId || '');
    setHouseId((prev) => prev || view.special.houses?.[0]?.houseId || '');
    setStrategistId((prev) => prev || view.playerPersonId);
    if (preset?.scheme) setScheme(preset.scheme as SchemeKind);
    if (preset?.targetArmyId) setSchemeTarget(`army:${preset.targetArmyId}`);
    if (preset?.targetRegionId) setSchemeTarget(`region:${preset.targetRegionId}`);
    if (preset?.kind) {
      setAction(preset.kind);
      setTab(
        (preset.kind === 'scheme' ? 'scheme' : (GROUPS.politics as readonly string[]).includes(preset.kind) ? 'politics' : (GROUPS.civil as readonly string[]).includes(preset.kind) ? 'civil' : 'military') as TabKey,
      );
    }
  }, [view, preset, ownRegions, garrisonRegions]);

  useEffect(() => {
    if (!view) return;
    api
      .characters({ faction: view.factionKey, pageSize: '80' })
      .then((res) => setCommanders(res.items))
      .catch(() => setCommanders([]));
  }, [view?.factionKey, view?.gameId]);

  useEffect(() => {
    if (!selectedArmy) return;
    setMoveAmount((prev) => {
      const total = selectedArmy.troops ?? 0;
      return prev > 0 && prev <= total ? prev : total;
    });
    setUnitPlan({});
    setCommanderId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArmy?.armyId]);

  useEffect(() => {
    setResult(null);
  }, [action, tab]);

  useEffect(() => {
    if (selectedGarrisonRegion) setGarrisonAmount(Math.min(5000, selectedGarrisonRegion.garrison ?? 0));
  }, [selectedGarrisonRegion?.regionId]);

  if (!view) return null;

  const tabActions = (GROUPS[tab] as readonly string[]).filter(
    (kind) =>
      allowed.includes(kind) &&
      !(kind === 'appease_tribe' && view.factionKey !== 'HUN') &&
      !(kind === 'balance_princes' && view.factionKey !== 'YONG') &&
      !(kind === 'negotiate_house' && view.factionKey !== 'CHU'),
  );

  const unitSum = Object.values(unitPlan).reduce((s, n) => s + n, 0);
  const partial = Boolean(selectedArmy && (moveAmount < (selectedArmy.troops ?? 0) || unitSum > 0));
  const freeCommanders = commanders.filter(
    (c) => !view.armies.some((a) => a.commanderId === c.person_id) && c.person_id !== selectedArmy?.commanderId,
  );
  const strategists = [...commanders].sort((a, b) => b.strategy - a.strategy);
  const courtAgendas: { key: CourtAgenda; label: string; desc: string }[] = [
    { key: 'war_council', label: '军务与边防', desc: '军令、训练、士气与军需之间的权衡。' },
    ...(view.factionKey === 'YONG' ? [{ key: 'succession' as const, label: '皇嗣与储位', desc: '明确储位可强化名分，但可能激化其他皇子；折中可稳定朝局。' }] : []),
    ...(view.factionKey === 'HUN' ? [{ key: 'tribal_alliance' as const, label: '部落盟约', desc: '统一号令能提升联盟协调，但强压会损伤各部忠诚；兑现盟约能安抚部落。' }] : []),
    ...(view.factionKey === 'CHU' ? [{ key: 'clan_relations' as const, label: '世家与中枢', desc: '收权可增强中央权威但会激怒世家；让利则反之。' }] : []),
  ];
  useEffect(() => {
    const allowedAgendas = courtAgendas.map((item) => item.key);
    if (!allowedAgendas.includes(courtAgenda)) setCourtAgenda(allowedAgendas[0] ?? 'war_council');
  }, [view.factionKey, courtAgenda]);

  const courtDecisionCopy: Record<CourtDecision, { label: string; desc: string }> = {
    assertive: { label: '强硬推进', desc: '更快强化军事或中央权威，但会积累疲劳、派系反弹或忠诚损失。' },
    balanced: { label: '折中调和', desc: '以适度成本改善战备或稳定政治关系，避免单方面倾斜。' },
    conciliatory: { label: '怀柔让步', desc: '优先恢复疲劳、信任或支持度；通常牺牲部分短期控制力。' },
  };

  const tradeCost = Math.round((BALANCE.prices[resource] ?? 0) * tradeAmount * BALANCE.tradePremium);
  const recruitCost = Math.round(recruitAmount * BALANCE.recruit.cashPerMan);

  const buildOrder = (): Order | null => {
    const orderId = `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    switch (action) {
      case 'move_army':
        if (!selectedArmy || !target) return null;
        return {
          orderId,
          kind: 'move_army',
          armyId: selectedArmy.armyId,
          targetRegionId: target,
          amount: moveAmount,
          units: Object.entries(unitPlan)
            .filter(([, count]) => count > 0)
            .map(([unitId, count]) => ({ unitId, count })),
          commanderId: partial ? commanderId || undefined : undefined,
        };
      case 'dispatch_garrison':
        if (!selectedGarrisonRegion || !garrisonTarget) return null;
        return {
          orderId,
          kind: 'dispatch_garrison',
          regionId: selectedGarrisonRegion.regionId,
          targetRegionId: garrisonTarget,
          amount: garrisonAmount,
          commanderId: commanderId || undefined,
        };
      case 'rest_army':
        return selectedArmy ? { orderId, kind: 'rest_army', armyId: selectedArmy.armyId } : null;
      case 'scout':
        return regionId ? { orderId, kind: 'scout', regionId } : null;
      case 'recruit':
        return recruitRegionId
          ? {
              orderId,
              kind: 'recruit',
              amount: recruitAmount,
              regionId: recruitRegionId,
              formNewArmy: recruitNew,
              commanderId: recruitNew ? commanderId || undefined : undefined,
            }
          : null;
      case 'levy_grain':
        return { orderId, kind: 'levy_grain', amount };
      case 'levy_tax':
        return { orderId, kind: 'levy_tax', amount };
      case 'trade':
        return { orderId, kind: 'trade', resource, amount: tradeAmount };
      case 'appease_tribe':
        return tribeId ? { orderId, kind: 'appease_tribe', tribeId, amount } : null;
      case 'balance_princes':
        return { orderId, kind: 'balance_princes', amount: 1 };
      case 'hold_court':
        return { orderId, kind: 'hold_court', agenda: courtAgenda, decision: courtDecision };
      case 'negotiate_house':
        return houseId ? { orderId, kind: 'negotiate_house', houseId, amount: 1 } : null;
      case 'appoint':
        return personId && appointRegion ? { orderId, kind: 'appoint', personId, regionId: appointRegion } : null;
      case 'scheme': {
        if (!schemeTarget) return null;
        const [type, id] = schemeTarget.split(':');
        return {
          orderId,
          kind: 'scheme',
          scheme,
          targetArmyId: type === 'army' ? id : undefined,
          targetRegionId: type === 'region' ? id : undefined,
          strategistId: strategistId || undefined,
        };
      }
      default:
        return null;
    }
  };

  const order = buildOrder();

  const submit = async () => {
    if (!order) return;
    const res = await submitOrders([order]);
    setResult({ previews: res.previews, issues: res.issues });
    if (res.accepted > 0) {
      setPersonId('');
      setPersonName('');
      setQuery('');
      setCharacters([]);
      setSchemeTarget('');
    }
  };

  const searchCharacters = async () => {
    setSearching(true);
    try {
      const res = await api.characters({ q: query, faction: view.factionKey, pageSize: '24' });
      setCharacters(res.items);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Modal
      title="下达命令"
      subtitle={`${ROLE_LABEL[role]}权限 · ${view.own.shortName} · 一旬七日`}
      onClose={() => setOrdersOpen(false)}
      tabs={[
        { key: 'military', label: '军事/州兵' },
        { key: 'civil', label: '民政财政' },
        { key: 'politics', label: '政治交涉' },
        { key: 'scheme', label: '计谋' },
      ]}
      activeTab={tab}
      onTab={(k) => {
        setTab(k as TabKey);
        const first = (GROUPS[k as TabKey] as readonly string[]).find((x) => allowed.includes(x));
        if (first) setAction(first);
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
        <div>
          <div className="subhead">可用命令</div>
          <div className="action-grid">
            {tabActions.length === 0 && <div className="empty">你的身份在本类下没有可用命令。</div>}
            {tabActions.map((kind) => (
              <button key={kind} className={`action-chip ${action === kind ? 'active' : ''}`} onClick={() => setAction(kind)}>
                {ORDER_LABELS[kind] ?? kind}
              </button>
            ))}
          </div>

          <div className="subhead">命令参数</div>
          <div className="card">
            {action === 'move_army' && selectedArmy && (
              <>
                <div className="form-row">
                  <label>部队</label>
                  <select value={selectedArmy.armyId} onChange={(e) => { setArmyId(e.target.value); setTarget(''); }}>
                    {ownArmies.map((a) => (
                      <option key={a.armyId} value={a.armyId}>
                        {a.name} · {a.regionName} · {a.troopsLabel}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>调动兵力</label>
                  <input
                    type="range"
                    min={1000}
                    max={Math.max(1000, selectedArmy.troops ?? 1000)}
                    step={1000}
                    value={moveAmount}
                    onChange={(e) => setMoveAmount(Number(e.target.value))}
                  />
                  <span className="gold mono" style={{ width: 84, textAlign: 'right' }}>{moveAmount.toLocaleString()}</span>
                </div>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  该部共 {fmt(selectedArmy.troops ?? 0)} 人，其中征集兵 {fmt(selectedArmy.levies ?? 0)}；本次调走 {fmt(moveAmount)} 人，留驻 {fmt(Math.max(0, (selectedArmy.troops ?? 0) - moveAmount))} 人。
                </div>
                <div className="subhead" style={{ marginTop: 4 }}>随军特殊兵种（可选）</div>
                {(selectedArmy.units ?? []).map((u) => (
                  <div className="unit-row" key={u.unitId}>
                    <UnitIcon unitId={u.unitId} name={u.name} />
                    <div>
                      <div className="u-name">{u.name}</div>
                      <div className="u-cat">现有 {u.count.toLocaleString()}</div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={u.count}
                      value={unitPlan[u.unitId] ?? 0}
                      onChange={(e) => setUnitPlan({ ...unitPlan, [u.unitId]: Math.max(0, Math.min(u.count, Number(e.target.value))) })}
                      style={{ width: 86, marginLeft: 'auto', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line-soft)', borderRadius: 5, padding: '4px 6px' }}
                    />
                  </div>
                ))}
                {(selectedArmy.units ?? []).length === 0 && <div className="small muted">该部无特殊兵种。</div>}
                <div className="form-row">
                  <label>统兵官</label>
                  <select value={commanderId} onChange={(e) => setCommanderId(e.target.value)}>
                    <option value="">{partial ? '分兵必须选择统兵官' : '（全军出动，沿用原统兵官）'}</option>
                    {freeCommanders.map((c) => (
                      <option key={c.person_id} value={c.person_id}>
                        {c.name} · 统率 {c.command} / 谋略 {c.strategy} · {c.current_position_standard}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>目标州府</label>
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">选择目标</option>
                    {(mapData?.territories ?? []).map((t) => {
                      const rv = view.regions.find((r) => r.regionId === t.region_id);
                      return (
                        <option key={t.region_id} value={t.region_id}>
                          {t.region} · {rv?.ownerShort ?? ''}{rv?.owned ? '（本国）' : '（敌/外）'}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="form-note">
                  不调整滑条即全军移动；调低兵力或指定特殊兵种会自动分遣，由所选统兵官统带。统率与谋略直接影响战斗，分兵可同时经营多条战线。
                  特殊兵种计入总兵力，不会被复制。路径由地图边权与机动计算，跨境进入交战国会触发战斗。
                </div>
              </>
            )}

            {action === 'dispatch_garrison' && (
              <>
                <div className="form-row">
                  <label>州府（州兵）</label>
                  <select value={selectedGarrisonRegion?.regionId ?? ''} onChange={(e) => setGarrisonRegionId(e.target.value)}>
                    {garrisonRegions.length === 0 && <option value="">无州兵可调</option>}
                    {garrisonRegions.map((r) => (
                      <option key={r.regionId} value={r.regionId}>{r.name} · 州兵 {fmt(r.garrison ?? 0)} · 统带 {r.garrisonCommanderName ?? '—'}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>调出兵力</label>
                  <input type="range" min={1000} max={Math.max(1000, selectedGarrisonRegion?.garrison ?? 1000)} step={1000} value={garrisonAmount} onChange={(e) => setGarrisonAmount(Number(e.target.value))} />
                  <span className="gold mono" style={{ width: 84, textAlign: 'right' }}>{garrisonAmount.toLocaleString()}</span>
                </div>
                <div className="form-row">
                  <label>目标州府</label>
                  <select value={garrisonTarget} onChange={(e) => setGarrisonTarget(e.target.value)}>
                    <option value="">选择目标</option>
                    {(mapData?.territories ?? []).map((t) => (
                      <option key={t.region_id} value={t.region_id}>{t.region} · {view.regions.find((r) => r.regionId === t.region_id)?.ownerShort}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>统兵官</label>
                  <select value={commanderId} onChange={(e) => setCommanderId(e.target.value)}>
                    <option value="">默认由本州守将统带</option>
                    {freeCommanders.map((c) => <option key={c.person_id} value={c.person_id}>{c.name} · 统率 {c.command} / 谋略 {c.strategy}</option>)}
                  </select>
                </div>
                <div className="form-note">州兵是每州常设守备，调出后该州剩余守军减少、防御变弱。适合偷袭、增援、护送粮道，也能以少量精锐州兵配合名将打以少胜多。</div>
              </>
            )}

            {action === 'rest_army' && selectedArmy && (
              <>
                <div className="form-row">
                  <label>部队</label>
                  <select value={selectedArmy.armyId} onChange={(e) => setArmyId(e.target.value)}>
                    {ownArmies.map((a) => <option key={a.armyId} value={a.armyId}>{a.name} · 补给 {a.supply ?? 0} / 疲劳 {a.fatigue ?? 0}</option>)}
                  </select>
                </div>
                <div className="form-note">整军提升补给、恢复士气、降低疲劳。若在敌境附近休整，需防范突袭。</div>
              </>
            )}

            {action === 'scout' && (
              <>
                <div className="form-row">
                  <label>侦察州府</label>
                  <select value={regionId} onChange={(e) => setRegionId(e.target.value)}>
                    <option value="">选择目标州府</option>
                    {enemyRegions.map((r) => <option key={r.regionId} value={r.regionId}>{r.name} · {r.ownerShort}</option>)}
                  </select>
                </div>
                <div className="form-note">斥候只能给出估算值与可靠度，无法看到真实内政和全部兵力。</div>
              </>
            )}

            {action === 'recruit' && (
              <>
                <div className="form-row">
                  <label>征兵州府</label>
                  <select value={recruitRegionId} onChange={(e) => setRecruitRegionId(e.target.value)}>
                    {ownRegions.map((r) => <option key={r.regionId} value={r.regionId}>{r.name}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <label>征募人数</label>
                  <input type="range" min={1000} max={30000} step={1000} value={recruitAmount} onChange={(e) => setRecruitAmount(Number(e.target.value))} />
                  <span className="gold mono" style={{ width: 84, textAlign: 'right' }}>{recruitAmount.toLocaleString()}</span>
                </div>
                <div className="form-row">
                  <label>编成方式</label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--ink)' }}>
                    <input type="checkbox" checked={recruitNew} onChange={(e) => setRecruitNew(e.target.checked)} />
                    新建军团（否则补入该州驻军）
                  </label>
                </div>
                {recruitNew && (
                  <div className="form-row">
                    <label>统兵官</label>
                    <select value={commanderId} onChange={(e) => setCommanderId(e.target.value)}>
                      <option value="">自动委派</option>
                      {freeCommanders.map((c) => <option key={c.person_id} value={c.person_id}>{c.name} · 统率 {c.command} / 谋略 {c.strategy}</option>)}
                    </select>
                  </div>
                )}
                <div className="form-note">
                  预计耗银 {fmt(recruitCost, '两')}、粮 {fmt(recruitAmount * BALANCE.recruit.grainPerMan, '石')}。新兵可直接补入现有军团、编入州兵，或新建一支军团由你选将统带。
                  {view.factionKey === 'CHU' && view.flags.houseBoycott ? ' 世家抵制期间无法征兵。' : ''}
                </div>
              </>
            )}

            {(action === 'levy_grain' || action === 'levy_tax') && (
              <>
                <div className="form-row">
                  <label>州府数量</label>
                  <select value={amount} onChange={(e) => setAmount(Number(e.target.value))}>
                    {[1, 2, 3].map((n) => <option key={n} value={n}>{n} 个</option>)}
                  </select>
                </div>
                <div className="form-note">
                  {action === 'levy_grain'
                    ? `每州约征 ${fmt(BALANCE.levyGrain.grainPerRegion, '石')}，治安、民心下降。`
                    : `每州加征 ${fmt(BALANCE.levyTax.cashPerRegion, '两')}，治安与世家支持下降。`}
                </div>
              </>
            )}

            {action === 'trade' && (
              <>
                <div className="form-row">
                  <label>资源</label>
                  <select value={resource} onChange={(e) => setResource(e.target.value as any)}>
                    <option value="salt">盐</option><option value="iron">铁</option><option value="horses">战马</option><option value="grain">粮</option>
                  </select>
                </div>
                <div className="form-row">
                  <label>数量</label>
                  <input type="number" min={1} value={tradeAmount} onChange={(e) => setTradeAmount(Math.max(1, Number(e.target.value)))} />
                </div>
                <div className="form-note">边市含 15% 溢价，预计耗银 {fmt(tradeCost, '两')}（现有 {fmt(view.own.resources.cash, '两')}）。</div>
              </>
            )}

            {action === 'appease_tribe' && (
              <>
                <div className="form-row">
                  <label>部落</label>
                  <select value={tribeId} onChange={(e) => setTribeId(e.target.value)}>
                    {(view.special.tribes ?? []).map((t) => <option key={t.tribeId} value={t.tribeId}>{t.name} · 忠诚 {Math.round(t.loyalty)} · {t.stance}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <label>赏赐银两</label>
                  <input type="number" min={900} step={900} value={amount} onChange={(e) => setAmount(Math.max(900, Number(e.target.value)))} />
                </div>
                <div className="form-note">赏赐提升部落忠诚，降低拒命概率。协调度决定名义兵力能有多少被统一调动。</div>
              </>
            )}

            {action === 'hold_court' && (
              <>
                <div className="form-row">
                  <label>廷议议题</label>
                  <select value={courtAgenda} onChange={(e) => setCourtAgenda(e.target.value as CourtAgenda)}>
                    {courtAgendas.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                </div>
                <div className="form-note">
                  {courtAgendas.find((item) => item.key === courtAgenda)?.desc}
                </div>
                <div className="subhead" style={{ marginTop: 10 }}>拟定裁决</div>
                <div className="action-grid">
                  {(Object.keys(courtDecisionCopy) as CourtDecision[]).map((key) => (
                    <button key={key} className={`action-chip ${courtDecision === key ? 'active' : ''}`} onClick={() => setCourtDecision(key)}>
                      {courtDecisionCopy[key].label}
                    </button>
                  ))}
                </div>
                <div className="form-note">{courtDecisionCopy[courtDecision].desc}</div>
                <div className="card" style={{ marginTop: 10, background: 'rgba(0,0,0,0.16)' }}>
                  <div className="subhead">廷臣意见</div>
                  <div className="small" style={{ lineHeight: 1.8 }}>
                    {courtAgenda === 'war_council' && '兵部：应整军备边，避免战机稍纵即逝。仓曹：军饷、粮秣与马匹储备必须支撑长期作战。'}
                    {courtAgenda === 'succession' && '中书：储位必须有明确名分。诸王宾客：过度偏向一方会使朝局失衡。御史：应将朝廷稳定置于私党之上。'}
                    {courtAgenda === 'tribal_alliance' && '主战诸将：联盟需要统一号令。部落首领：盟约与赏赐若长期落空，各部将各行其是。'}
                    {courtAgenda === 'clan_relations' && '台谏：财赋与任官不可尽受世家把持。世家代表：若中央一味收权，地方税赋与征兵都可能受阻。'}
                  </div>
                  <div className="divider" />
                  <div className="small muted" style={{ lineHeight: 1.7 }}>
                    {view.factionKey === 'YONG' && `当前朝局稳定 ${Math.round(view.special.courtStability ?? 60)}；皇子：${(view.special.princes ?? []).map((p) => `${p.name}（影响 ${Math.round(p.influence)}）`).join('、') || '无可用派系记录'}。`}
                    {view.factionKey === 'HUN' && `当前联盟协调度 ${Math.round(view.special.cohesion ?? 58)}；部落：${(view.special.tribes ?? []).map((t) => `${t.name}（忠诚 ${Math.round(t.loyalty)}）`).join('、') || '无可用部落记录'}。`}
                    {view.factionKey === 'CHU' && `当前中枢权威 ${Math.round(view.special.centralAuthority ?? 55)}；世家支持均值 ${Math.round((view.special.houses ?? []).reduce((sum, h) => sum + h.support, 0) / Math.max(1, view.special.houses?.length ?? 0))}。`}
                    {view.factionKey === 'HUN' && courtAgenda === 'war_council' && ` 目前军团 ${view.armies.filter((a) => a.own).length} 支。`}
                  </div>
                </div>
                <div className="form-note">廷议每旬限一次。命令提交后会在回合结算时形成政治事件，裁决将直接影响运行时状态；并非只记录一段对话。</div>
              </>
            )}

            {action === 'balance_princes' && (
              <div className="form-note">
                耗银 {fmt(BALANCE.balancePrinces.cashCost)}，朝局稳定 +{BALANCE.balancePrinces.stabilityGain}，最高影响力皇子 -{BALANCE.balancePrinces.topInfluenceDrop}。
                当前：{(view.special.princes ?? []).map((p) => `${p.name} ${Math.round(p.influence)}`).join(' · ')}
              </div>
            )}

            {action === 'negotiate_house' && (
              <>
                <div className="form-row">
                  <label>世家</label>
                  <select value={houseId} onChange={(e) => setHouseId(e.target.value)}>
                    {(view.special.houses ?? []).map((h) => <option key={h.houseId} value={h.houseId}>{h.name} · 支持 {Math.round(h.support)} · 税赋 {(h.taxCompliance * 100).toFixed(0)}%</option>)}
                  </select>
                </div>
                <div className="form-note">协商耗银 {fmt(BALANCE.negotiateHouse.cashCost)}，支持 +{BALANCE.negotiateHouse.supportGain}。世家支持影响税赋、征兵与地方私兵。</div>
              </>
            )}

            {action === 'appoint' && (
              <>
                <div className="form-row">
                  <label>人选</label>
                  <input value={query} placeholder="姓名/职位后搜索" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void searchCharacters()} />
                  <button className="btn small" onClick={() => void searchCharacters()} disabled={searching}>{searching ? '搜索…' : '搜索'}</button>
                </div>
                {characters.length > 0 && (
                  <div className="char-grid" style={{ maxHeight: 210, overflowY: 'auto', marginBottom: 8 }}>
                    {characters.map((c) => (
                      <button key={c.person_id} className="char-card" style={{ borderColor: personId === c.person_id ? 'var(--gold)' : undefined }} onClick={() => { setPersonId(c.person_id); setPersonName(c.name); }}>
                        <Portrait personId={c.person_id} size="sm" />
                        <div>
                          <div className="cc-name">{c.name}</div>
                          <div className="cc-pos">{c.current_position_standard}</div>
                          <div className="cc-meta">治理 {c.governance} · 统率 {c.command} · 谋略 {c.strategy}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div className="form-row">
                  <label>任职州府</label>
                  <select value={appointRegion} onChange={(e) => setAppointRegion(e.target.value)}>
                    {ownRegions.map((r) => <option key={r.regionId} value={r.regionId}>{r.name} · 现主官 {r.governorName}</option>)}
                  </select>
                </div>
                <div className="form-note">任命耗银 8000 两。{personName ? `已选：${personName}。` : '尚未选择人选。'} 任命会改变州府治理，但不改变人物能力。</div>
              </>
            )}

            {action === 'scheme' && (
              <>
                <div className="subhead">选择计谋</div>
                <div className="action-grid">
                  {(Object.keys(SCHEME_LABELS) as SchemeKind[]).map((key) => (
                    <button key={key} className={`action-chip ${scheme === key ? 'active' : ''}`} onClick={() => setScheme(key)}>
                      {SCHEME_LABELS[key]} · {fmt(SCHEME_COST[key], '两')}
                    </button>
                  ))}
                </div>
                <div className="form-note">{SCHEME_DESC[scheme]}</div>
                <div className="form-row">
                  <label>施计者</label>
                  <select value={strategistId} onChange={(e) => setStrategistId(e.target.value)}>
                    {!strategists.some((c) => c.person_id === view.playerPersonId) && (
                      <option value={view.playerPersonId}>{view.playerPersonName} · 本方人物</option>
                    )}
                    {strategists.map((c) => <option key={c.person_id} value={c.person_id}>{c.name} · 谋略 {c.strategy} / 统率 {c.command} · {c.current_position_standard}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <label>{scheme === 'ambush' ? '本国州府' : '目标'}</label>
                  <select value={schemeTarget} onChange={(e) => setSchemeTarget(e.target.value)}>
                    <option value="">选择目标</option>
                    {scheme === 'ambush'
                      ? ownRegions.map((r) => <option key={r.regionId} value={`region:${r.regionId}`}>{r.name}（设伏）</option>)
                      : (
                        <>
                          <optgroup label="敌军部队">
                            {enemyArmies.map((a) => <option key={a.armyId} value={`army:${a.armyId}`}>{a.name} · {a.regionName} · {a.troopsLabel}</option>)}
                          </optgroup>
                          {scheme !== 'cut_supply' && (
                            <optgroup label="敌国州府">
                              {enemyRegions.map((r) => <option key={r.regionId} value={`region:${r.regionId}`}>{r.name} · {r.ownerShort}</option>)}
                            </optgroup>
                          )}
                        </>
                      )}
                  </select>
                </div>
                <div className="form-note">
                  成功率由谋略、敌将权谋、地形与情报决定，并非必成；失败也会消耗银钱。断粮必须指定敌军部队。
                  当前银钱：{fmt(view.own.resources.cash, '两')}。成功可改变战场比重，配合精锐与名将可以少胜多。
                </div>
              </>
            )}
          </div>

          {result && (
            <div className="card" style={{ marginTop: 10 }}>
              {result.previews.map((p, i) => <div key={i} className="small ok-text">✓ {p}</div>)}
              {result.issues.map((p, i) => <div key={i} className="small danger-text">✕ {p}</div>)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn primary" disabled={!order || busy} onClick={() => void submit()}>下达此命令</button>
            <button className="btn ghost" onClick={() => setOrdersOpen(false)}>稍后再下</button>
            {view.pendingOrders.length > 0 && <span className="muted small" style={{ alignSelf: 'center' }}>已有 {view.pendingOrders.length} 条待结算命令（上限 6）</span>}
          </div>
        </div>

        <div>
          <div className="subhead">本旬待结算</div>
          {view.pendingOrders.length === 0 && <div className="empty">尚无命令。命令将在「结束本旬」时统一校验并结算。</div>}
          {view.pendingOrders.map((o) => (
            <div className="card" key={o.orderId} style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="gold small" style={{ flex: '0 0 auto' }}>{ORDER_LABELS[o.kind]}</span>
              <span className="small muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describeOrder(o)}</span>
              <button className="btn small danger" onClick={() => void cancelOrder(o.orderId)}>撤销</button>
            </div>
          ))}

          <div className="subhead">指挥提示</div>
          <div className="card small" style={{ lineHeight: 1.75 }}>
            <div style={{ color: FACTION_VISUALS[view.factionKey].mapBorder }}>{view.own.name}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              身份：{ROLE_LABEL[role]}。{role === 'strategist'
                ? '军师可直接施计与侦察，以计谋、伏兵、断粮改变战局；不能直接调动军队或改动国政。'
                : role === 'general'
                  ? '将军可调动自己统率的部队、分兵、调州兵、施计，但民政与任命受限。'
                  : role === 'governor'
                    ? '州牧可经营本州、征兵扩军、调遣本州州兵与施计，但不能任免全国官员。'
                    : '君主可处理全局政务、军令、分兵扩军与计谋。'}
            </div>
            <div className="divider" />
            <div className="muted">
              分兵会新建一支军团，必须另选统兵官；特殊兵种按你填写的数量随军。统率/谋略高的将领能显著提高战力。
              计谋成功可造成减员、断粮、离间、伏击或佯攻加成；失败会损失银钱并暴露意图。
            </div>
          </div>

          <div className="subhead">建议</div>
          <div className="small muted" style={{ lineHeight: 1.7 }}>
            {view.factionKey === 'HUN' && '匈奴粮盐紧缺：优先保障军粮与盐，用赏赐维持部落协调。精骑宜快速迂回、断粮，不宜长期围城。'}
            {view.factionKey === 'YONG' && '大雍粮足但缺盐缺马：用重步兵与强弩结阵，配合断粮和伏兵消耗敌军；留意皇子派系。'}
            {view.factionKey === 'CHU' && '大楚钱粮盐足、缺马铁：弓弩与江河运输是优势，善用火攻、伏兵与佯攻，避免被重骑近身。'}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function describeOrder(o: Order): string {
  if (o.kind === 'move_army') return `${o.armyId} → ${o.targetRegionId}${o.amount ? ` · ${o.amount} 人` : ' · 全军'}`;
  if (o.kind === 'dispatch_garrison') return `${o.regionId} 州兵 ${o.amount} → ${o.targetRegionId}`;
  if (o.kind === 'recruit') return `征募 ${o.amount} 人${o.formNewArmy ? ' · 新建军团' : ''}`;
  if (o.kind === 'levy_grain') return `征粮 ${o.amount} 州`;
  if (o.kind === 'levy_tax') return `加征 ${o.amount} 州`;
  if (o.kind === 'trade') return `${o.resource} × ${o.amount}`;
  if (o.kind === 'appease_tribe') return `${o.tribeId} · ${o.amount} 两`;
  if (o.kind === 'balance_princes') return '平衡皇子派系';
  if (o.kind === 'hold_court') return `廷议：${o.agenda} · ${o.decision}`;
  if (o.kind === 'negotiate_house') return o.houseId;
  if (o.kind === 'appoint') return `${o.personId} → ${o.regionId}`;
  if (o.kind === 'rest_army') return o.armyId;
  if (o.kind === 'scout') return o.regionId;
  if (o.kind === 'scheme') return `${SCHEME_LABELS[o.scheme]} → ${o.targetArmyId ?? o.targetRegionId ?? ''}`;
  return '';
}

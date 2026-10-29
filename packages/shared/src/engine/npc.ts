import type { FactionKey, GameState, Order } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { diplomacyKey, isAtWar } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE, grainDemandForTroops, perThousandDemand } from '../balance.js';
import { buildAdjacency, buildMapAdjacency, capitalMapNodeId, estimatePathDays, findMapPath, findPath } from './movement.js';
import type { Army, RegionState } from '../types.js';
import { factionTroops } from './economy.js';
import { clamp } from './state.js';
import { seasonOf } from './season.js';

/**
 * NPC 决策：基于自身利益、资源、已知边境与性格的启发式。
 * 只生成合法意图；真正状态改由 applyOrder 与规则引擎执行。
 */
export function generateNpcOrders(state: GameState, ctx: DerivedContext): Order[] {
  const orders: Order[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const rng = mulberry32(hashString(`${state.seed}-${state.date.turn}-${key}`));
    const faction = state.factions[key];
    // 若有效盟约使本方被卷入盟友的战争，记录需要优先回应的共同敌人。
    const defensiveWarTargets = defensiveAllianceWarTargets(state, key);
    const troops = Math.max(1, factionTroops(state, key));
    const res = faction.resources;
    let seq = 0;
    const oid = () => `npc-${key}-T${state.date.turn}-${++seq}`;

    // 1) 粮食与财政自保
    if (res.grain < grainDemandForTroops(troops, 2.5)) {
      const stores = Object.values(state.regions)
        .filter((r) => r.faction === key)
        .reduce((s, r) => s + r.foodStore, 0);
      if (stores > BALANCE.levyGrain.grainPerRegion * 0.5) {
        orders.push({ orderId: oid(), kind: 'levy_grain', amount: rng() > 0.4 ? 2 : 1 });
      }
    }
    if (res.cash < troops * BALANCE.cashPerSoldierPerWeek * 2 && rng() > 0.3) {
      orders.push({ orderId: oid(), kind: 'levy_tax', amount: 1 });
    }
    // 2) 资源短板通过贸易缓解
    if (res.salt < perThousandDemand(troops, BALANCE.saltPerThousandPerWeek, 3) && res.cash > 30_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'salt', amount: 120 });
    } else if (res.iron < perThousandDemand(troops, BALANCE.ironPerThousandPerWeek, 3) && res.cash > 40_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'iron', amount: 120 });
    }

    // 3) 军队补员
    if (troops < faction.nominalTroops * 0.82 && res.cash > 45_000 && res.manpower > 12_000) {
      orders.push({ orderId: oid(), kind: 'recruit', amount: 8_000 });
    }

    // 4) 军事行动：先评估敌方前线威胁，再决定反击、增援与休整；不让 AI 只会一味进攻。
    const idleArmies = state.armies
      .filter((army) => army.faction === key && army.status === 'idle' && army.stance !== 'siege' && army.troops > 4_000 && army.supply > 35)
      .sort((a, b) => armyReadiness(b, ctx) - armyReadiness(a, ctx));
    const frontierGoalArmies = idleArmies.filter((army) => state.characters[army.commanderId]?.goal === 'press_frontier');
    const attack = (frontierGoalArmies.length ? pickEnemyAttack(state, ctx, key, frontierGoalArmies, defensiveWarTargets) : null) ?? pickEnemyAttack(state, ctx, key, idleArmies, defensiveWarTargets);
    const commander = attack ? ctx.charactersById[attack.army.commanderId] : undefined;
    const command = commander?.command ?? 50;
    const strategy = commander?.strategy ?? 50;
    let attackChance = 0.38 + (command - 50) / 220 + (strategy - 50) / 300;
    if (key === 'HUN' && (state.special.HUN.cohesion ?? 55) < 42) attackChance -= 0.12;
    if (key === 'YONG' && state.flags.successionCrisis) attackChance -= 0.14;
    if (key === 'CHU' && state.flags.houseBoycott) attackChance -= 0.12;
    if (res.grain < grainDemandForTroops(troops, 1.5)) attackChance -= 0.12;
    if (attack && state.characters[attack.army.commanderId]?.goal === 'press_frontier') attackChance += 0.18;
    if (attack && state.characters[attack.army.commanderId]?.goal === 'restore_readiness') attackChance -= 0.22;
    attackChance = clamp(attackChance, 0.12, 0.92);

    // 防御盟约召援优先级高于普通进攻意愿：有可行目标便下达军令，而非只等待概率判定。
    const mustAnswerAllianceWar = Boolean(attack && defensiveWarTargets.has(attack.targetFaction));
    const attackAccepted = Boolean(attack && (mustAnswerAllianceWar || rng() < attackChance));
    const defenseArmies = attackAccepted && attack
      ? idleArmies.filter((army) => army.armyId !== attack.army.armyId)
      : idleArmies;
    const defense = pickDefensiveReinforcement(state, ctx, key, defenseArmies);

    if (defense) {
      orders.push({
        orderId: oid(),
        kind: 'move_army',
        armyId: defense.army.armyId,
        targetRegionId: defense.targetRegionId,
        targetMapNodeId: defense.targetNodeId,
      });
    }
    if (attackAccepted && attack) {
      orders.push({
        orderId: oid(),
        kind: 'move_army',
        armyId: attack.army.armyId,
        targetRegionId: attack.region.regionId,
        ...(attack.targetMapNodeId ? { targetMapNodeId: attack.targetMapNodeId } : {}),
      });
    } else if (!defense) {
      const tired = state.armies
        .filter((army) => army.faction === key && army.status === 'idle' && army.stance !== 'siege')
        .sort((a, b) =>
          Number(state.characters[b.commanderId]?.goal === 'restore_readiness') - Number(state.characters[a.commanderId]?.goal === 'restore_readiness') ||
          restPriority(a) - restPriority(b),
        )[0];
      if (tired && (tired.supply < 75 || tired.fatigue > 30 || tired.morale < 45)) {
        orders.push({ orderId: oid(), kind: 'rest_army', armyId: tired.armyId });
      }
    }

    // 5) 国情政治：优先处置真正触发危机的集团，而非只看全局均值。
    if (key === 'HUN' && state.special.HUN.tribes) {
      const tribes = state.special.HUN.tribes;
      const dissatisfied = tribes.filter((tribe) => tribe.stance === 'refusing' || tribe.loyalty < 40);
      const target = tribes.find((tribe) => state.characters[tribe.chiefId]?.goal === 'demand_patronage') ??
        dissatisfied.sort(
          (a, b) => Number(b.stance === 'refusing') - Number(a.stance === 'refusing') || a.loyalty - b.loyalty,
        )[0] ?? [...tribes].sort((a, b) => a.loyalty - b.loyalty)[0];
      if ((state.special.HUN.cohesion ?? 55) < 60 && target && target.loyalty < 60 && res.cash > 20_000) {
        orders.push({ orderId: oid(), kind: 'appease_tribe', tribeId: target.tribeId, amount: 6_000 });
      }
    }
    if (key === 'YONG') {
      const court = state.special.YONG;
      const dominantPrince = [...(court.princes ?? [])].sort((a, b) => b.influence - a.influence)[0];
      const needsBalance =
        state.flags.successionCrisis ||
        (court.courtStability ?? 60) < 52 ||
        (dominantPrince?.influence ?? 0) >= 76 ||
        Boolean(dominantPrince && state.characters[dominantPrince.personId]?.goal === 'consolidate_power');
      if (needsBalance && res.cash > Math.max(45_000, BALANCE.balancePrinces.cashCost * 2.5)) {
        orders.push({ orderId: oid(), kind: 'balance_princes', amount: 1 });
      }
    }
    if (key === 'CHU' && state.special.CHU.houses) {
      const houses = state.special.CHU.houses;
      const lowest = [...houses].sort((a, b) => a.support - b.support)[0];
      const goalHouse = houses.find((house) => state.characters[house.patriarchId]?.goal === 'protect_house');
      const targetHouse = goalHouse ?? lowest;
      const needsNegotiation = state.flags.houseBoycott || (targetHouse?.support ?? 100) < 50 || Boolean(goalHouse);
      if (targetHouse && needsNegotiation && res.cash > Math.max(35_000, BALANCE.negotiateHouse.cashCost * 2.5)) {
        orders.push({ orderId: oid(), kind: 'negotiate_house', houseId: targetHouse.houseId, amount: 1 });
      }
    }

    // 6) 外交 AI：每三回合评估一次，避免高频重复派使团；每个 NPC 势力每次最多一项外交行动。
    if (state.date.turn % 3 === 0) {
      const targets = FACTION_KEYS.filter((other) => other !== key && !isAtWar(state.diplomacy, key, other));
      const wars = FACTION_KEYS.filter((other) => other !== key && isAtWar(state.diplomacy, key, other));
      const activeTreaty = (other: FactionKey) => (state.treaties ?? []).some((treaty) =>
        treaty.kind === 'alliance' &&
        treaty.status === 'active' &&
        state.date.turn <= treaty.endTurn &&
        ((treaty.a === key && treaty.b === other) || (treaty.b === key && treaty.a === other)),
      );
      const relation = (other: FactionKey) => state.diplomacy[diplomacyKey(key, other)] ?? 0;
      const regionCount = (other: FactionKey) => Object.values(state.regions).filter((region) => region.faction === other).length;
      const targetHasShortage = (other: FactionKey) =>
        state.factions[other].resources.cash < 15_000 || state.factions[other].resources.grain < 40_000;
      let diplomaticOrder: Order | undefined;

      // 战线拉长、国库/军粮吃紧时优先议和；否则关系已不再敌对的战事不贸然停战。
      const peaceTarget = wars
        .filter((other) => relation(other) > -75)
        .sort((a, b) =>
          (relation(b) + (8 - regionCount(b)) * 10 + (targetHasShortage(b) ? 12 : 0)) -
          (relation(a) + (8 - regionCount(a)) * 10 + (targetHasShortage(a) ? 12 : 0)) ||
          a.localeCompare(b),
        )[0];
      if (peaceTarget && res.cash >= 5_000 &&
          (relation(peaceTarget) > -40 || regionCount(key) <= 4 || res.grain < grainDemandForTroops(troops, 1.5))) {
        diplomaticOrder = {
          orderId: oid(), kind: 'diplomatic_action', action: 'offer_peace', targetFaction: peaceTarget,
        };
      }

      // 对共同敌人形成牵制：只有无现存盟友、关系过门槛且使团预算充足时才尝试缔盟。
      if (!diplomaticOrder && !FACTION_KEYS.some((other) => other !== key && activeTreaty(other)) && res.cash >= 50_000) {
        const allianceTarget = targets
          .filter((other) =>
            !activeTreaty(other) &&
            relation(other) >= 25 &&
            FACTION_KEYS.some((third) =>
              third !== key && third !== other &&
              isAtWar(state.diplomacy, key, third) &&
              isAtWar(state.diplomacy, other, third),
            ),
          )
          .sort((a, b) => relation(b) - relation(a) || a.localeCompare(b))[0];
        if (allianceTarget) {
          diplomaticOrder = {
            orderId: oid(), kind: 'diplomatic_action', action: 'propose_alliance', targetFaction: allianceTarget,
          };
        }
      }

      // 无战争、无盟友时偶尔改善邦交；仅对较冷淡且有预算的目标行动。
      if (!diplomaticOrder && !wars.length && !FACTION_KEYS.some((other) => other !== key && activeTreaty(other)) && res.cash >= 60_000) {
        const improveTarget = targets
          .filter((other) => !activeTreaty(other) && relation(other) < 65)
          .sort((a, b) => relation(a) - relation(b) || a.localeCompare(b))[0];
        if (improveTarget && relation(improveTarget) < 45) {
          diplomaticOrder = {
            orderId: oid(), kind: 'diplomatic_action', action: 'improve_relations', targetFaction: improveTarget,
          };
        }
      }
      if (diplomaticOrder) orders.push(diplomaticOrder);
    }
  }
  return orders;
}

function defensiveAllianceWarTargets(state: GameState, factionKey: FactionKey): Set<FactionKey> {
  const targets = new Set<FactionKey>();
  for (const treaty of state.treaties ?? []) {
    if (treaty.kind !== 'alliance' || treaty.status !== 'active' ||
        state.date.turn < treaty.startTurn || state.date.turn > treaty.endTurn) continue;
    const partner = treaty.a === factionKey ? treaty.b : treaty.b === factionKey ? treaty.a : undefined;
    if (!partner) continue;
    for (const enemy of FACTION_KEYS) {
      if (enemy === factionKey || enemy === partner) continue;
      // 两方均已与共同敌人交战，且盟约仍有效，视为需回应的防御战线。
      if (isAtWar(state.diplomacy, factionKey, enemy) && isAtWar(state.diplomacy, partner, enemy)) {
        targets.add(enemy);
      }
    }
  }
  return targets;
}

interface AttackCandidate {
  army: Army;
  region: RegionState;
  targetFaction: FactionKey;
  targetMapNodeId?: string;
  score: number;
}

function armyReadiness(army: Army, ctx: DerivedContext): number {
  const commander = ctx.charactersById[army.commanderId];
  const command = commander?.command ?? 50;
  const morale = clamp(army.morale) / 100;
  const training = clamp(army.training) / 100;
  const supply = clamp(army.supply) / 100;
  const fatigue = clamp(army.fatigue) / 100;
  const condition = clamp(0.54 + morale * 0.2 + training * 0.16 + supply * 0.16 - fatigue * 0.14, 0.42, 1.08);
  return army.troops * condition * (0.82 + clamp(command) / 500);
}

function restPriority(army: Army): number {
  return army.supply - army.fatigue * 0.7 - (100 - army.morale) * 0.35;
}

interface DefensiveReinforcementCandidate {
  army: Army;
  targetNodeId: string;
  targetRegionId: string;
  urgency: number;
  estimatedDays: number;
}

/**
 * 有敌军驻于相邻节点且当地守备明显不足时，派一支机动部队增援。
 * 只响应已确认的敌军实体，不使用模糊情报凭空制造威胁，也不生成新兵。
 */
function pickDefensiveReinforcement(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  armies: Army[],
): DefensiveReinforcementCandidate | null {
  if (!state.mapNodes || armies.length === 0) return null;
  const adjacency = buildMapAdjacency(ctx);
  const enemyArmiesByNode = new Map<string, Army[]>();

  for (const army of state.armies) {
    if (army.faction === factionKey || !isAtWar(state.diplomacy, factionKey, army.faction)) continue;
    const nodeId = army.mapNodeId ?? capitalMapNodeId(ctx, army.nodeId);
    const node = nodeId ? state.mapNodes[nodeId] : undefined;
    if (!nodeId || !node || node.faction === factionKey) continue;
    const stationed = enemyArmiesByNode.get(nodeId) ?? [];
    stationed.push(army);
    enemyArmiesByNode.set(nodeId, stationed);
  }

  const candidates: DefensiveReinforcementCandidate[] = [];
  for (const targetNode of Object.values(state.mapNodes)) {
    if (targetNode.faction !== factionKey) continue;
    const threatenedEnemyArmies = new Map<string, Army>();
    for (const link of adjacency[targetNode.nodeId] ?? []) {
      const neighbor = state.mapNodes[link.to];
      if (!neighbor || neighbor.faction === factionKey || !isAtWar(state.diplomacy, factionKey, neighbor.faction)) continue;
      for (const army of enemyArmiesByNode.get(neighbor.nodeId) ?? []) threatenedEnemyArmies.set(army.armyId, army);
    }
    if (threatenedEnemyArmies.size === 0) continue;

    const region = state.regions[targetNode.regionId];
    if (!region) continue;
    const isCapital = targetNode.nodeType === '州府/主城';
    const garrison = isCapital ? region.garrison : targetNode.garrison;
    const fortification = isCapital ? region.fortification : targetNode.fortification;
    const friendlyPower = state.armies
      .filter((army) => army.faction === factionKey && army.troops > 0 &&
        (army.mapNodeId ?? capitalMapNodeId(ctx, army.nodeId)) === targetNode.nodeId)
      .reduce((sum, army) => sum + armyReadiness(army, ctx), 0);
    // 已经在路上、目的地是该节点的增援也计入估算，防止每回合重复派出过量军团。
    const inboundPower = state.armies
      .filter((army) => army.faction === factionKey && army.status === 'marching' &&
        army.targetMapNodeId === targetNode.nodeId && army.troops > 0)
      .reduce((sum, army) => sum + armyReadiness(army, ctx) * 0.7, 0);
    const localPower = friendlyPower + inboundPower + garrison * 0.62 + fortification * 260;
    const enemyPower = [...threatenedEnemyArmies.values()]
      .reduce((sum, army) => sum + armyReadiness(army, ctx), 0);
    if (enemyPower <= Math.max(1_000, localPower) * 1.15) continue;
    const urgency = enemyPower / Math.max(1_000, localPower) + strategicNodePriorityBonus(targetNode.nodeType);

    for (const army of armies) {
      const fromNodeId = army.mapNodeId ?? capitalMapNodeId(ctx, army.nodeId);
      if (!fromNodeId || fromNodeId === targetNode.nodeId) continue;
      const path = findMapPath(state, ctx, factionKey, fromNodeId, targetNode.nodeId, { troops: army.troops });
      const estimatedDays = estimatePathDays(army, path, seasonOf(state.date.month));
      if (!path.ok || estimatedDays > BALANCE.turnDays * 2) continue;
      candidates.push({
        army,
        targetNodeId: targetNode.nodeId,
        targetRegionId: targetNode.regionId,
        urgency,
        estimatedDays,
      });
    }
  }

  candidates.sort((a, b) =>
    b.urgency - a.urgency ||
    a.estimatedDays - b.estimatedDays ||
    armyReadiness(b.army, ctx) - armyReadiness(a.army, ctx) ||
    a.targetNodeId.localeCompare(b.targetNodeId) ||
    a.army.armyId.localeCompare(b.army.armyId),
  );
  return candidates[0] ?? null;
}

/**
 * NPC 的目标选择以真实 72 节点战略地图为准；只有没有地图运行时状态的旧档才回退州府图。
 * 这样 NPC 能争夺关隘、港埠、粮仓等独立据点，而不只是直接向整州主城进军。
 */
function pickEnemyAttack(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  armies: Army[],
  defensiveWarTargets: ReadonlySet<FactionKey> = new Set(),
): AttackCandidate | null {
  if (armies.length === 0) return null;
  if (state.mapNodes && Object.keys(state.mapNodes).length > 0) {
    return pickEnemyMapNodeAttack(state, ctx, factionKey, armies, defensiveWarTargets);
  }
  return pickEnemyRegionAttack(state, ctx, factionKey, armies, defensiveWarTargets);
}

function strategicNodePriorityBonus(nodeType: string): number {
  if (nodeType.includes('州府/主城')) return 0.08;
  if (/关隘|边塞/.test(nodeType)) return 0.07;
  if (/粮仓|粮库|驿站/.test(nodeType)) return 0.06;
  if (/港埠|渡口|水军/.test(nodeType)) return 0.045;
  if (/矿场|盐场|马场|资源/.test(nodeType)) return 0.03;
  return 0;
}

function pickEnemyMapNodeAttack(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  armies: Army[],
  defensiveWarTargets: ReadonlySet<FactionKey>,
): AttackCandidate | null {
  const adjacency = buildMapAdjacency(ctx);
  const ownNodeIds = Object.values(state.mapNodes ?? {})
    .filter((node) => node.faction === factionKey)
    .map((node) => node.nodeId);
  const candidateIds = new Set<string>();

  // 只把与己方控制节点相邻的敌方据点列为前线目标，避免 AI 无理由越过前线。
  for (const ownNodeId of ownNodeIds) {
    for (const link of adjacency[ownNodeId] ?? []) {
      const target = state.mapNodes?.[link.to];
      if (!target || target.faction === factionKey) continue;
      if (!isAtWar(state.diplomacy, factionKey, target.faction)) continue;
      candidateIds.add(target.nodeId);
    }
  }

  const candidates: AttackCandidate[] = [];
  for (const targetNodeId of candidateIds) {
    const targetNode = state.mapNodes?.[targetNodeId];
    const region = targetNode ? state.regions[targetNode.regionId] : undefined;
    if (!targetNode || !region) continue;
    const isCapital = targetNode.nodeType === '州府/主城';
    const garrison = isCapital ? region.garrison : targetNode.garrison;
    const fortification = isCapital ? region.fortification : targetNode.fortification;

    const defenderArmies = state.armies
      .filter((army) =>
        army.faction === targetNode.faction &&
        army.troops > 0 &&
        (army.mapNodeId ? army.mapNodeId === targetNode.nodeId : army.nodeId === targetNode.regionId),
      )
      .reduce((sum, army) => sum + armyReadiness(army, ctx), 0);
    const defenderPower = defenderArmies + garrison * 0.62 + fortification * 260;

    for (const army of armies) {
      const fromMapNodeId = army.mapNodeId ?? capitalMapNodeId(ctx, army.nodeId);
      if (!fromMapNodeId) continue;
      const path = findMapPath(state, ctx, factionKey, fromMapNodeId, targetNode.nodeId, { troops: army.troops });
      const estimatedDays = estimatePathDays(army, path, seasonOf(state.date.month));
      if (!path.ok || estimatedDays > BALANCE.turnDays * 2) continue;

      const attackPower = armyReadiness(army, ctx);
      if (attackPower < Math.max(1, defenderPower) * 0.58) continue;

      const commander = ctx.charactersById[army.commanderId];
      const commandAdvantage = ((commander?.command ?? 50) + (commander?.strategy ?? 50)) / 200;
      const localUnrest = (100 - region.loyalty) / 100;
      const defenseRatio = defenderPower / Math.max(1, attackPower);
      const travelPenalty = (estimatedDays / BALANCE.turnDays) * 0.08;
      const strategicValue = strategicNodePriorityBonus(targetNode.nodeType);
      const score = defenseRatio + travelPenalty - localUnrest * 0.08 - commandAdvantage * 0.025 - strategicValue;
      candidates.push({
        army,
        region,
        targetFaction: targetNode.faction,
        targetMapNodeId: targetNode.nodeId,
        score,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      Number(defensiveWarTargets.has(b.targetFaction)) - Number(defensiveWarTargets.has(a.targetFaction)) ||
      a.score - b.score ||
      b.army.troops - a.army.troops ||
      (a.targetMapNodeId ?? a.region.regionId).localeCompare(b.targetMapNodeId ?? b.region.regionId),
  );
  return candidates[0] ?? null;
}

/** 旧存档兼容路径：没有 72 节点控制状态时以州府和原始道路寻路。 */
function pickEnemyRegionAttack(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  armies: Army[],
  defensiveWarTargets: ReadonlySet<FactionKey>,
): AttackCandidate | null {
  const adjacency = buildAdjacency(ctx);
  const ownRegionIds = Object.values(state.regions)
    .filter((region) => region.faction === factionKey)
    .map((region) => region.regionId);
  const candidateIds = new Set<string>();

  for (const ownId of ownRegionIds) {
    for (const link of adjacency[ownId] ?? []) {
      const target = state.regions[link.to];
      if (!target || target.faction === factionKey) continue;
      if (!isAtWar(state.diplomacy, factionKey, target.faction)) continue;
      candidateIds.add(target.regionId);
    }
  }

  const candidates: AttackCandidate[] = [];
  for (const regionId of candidateIds) {
    const region = state.regions[regionId];
    if (!region) continue;
    const defenderArmies = state.armies
      .filter((army) => army.faction === region.faction && army.nodeId === regionId && army.troops > 0)
      .reduce((sum, army) => sum + armyReadiness(army, ctx), 0);
    const defenderPower = defenderArmies + region.garrison * 0.62 + region.fortification * 260;

    for (const army of armies) {
      const path = findPath(state, ctx, factionKey, army.nodeId, regionId, { troops: army.troops });
      const estimatedDays = estimatePathDays(army, path, seasonOf(state.date.month));
      if (!path.ok || estimatedDays > BALANCE.turnDays * 2) continue;
      const attackPower = armyReadiness(army, ctx);
      if (attackPower < Math.max(1, defenderPower) * 0.58) continue;

      const commander = ctx.charactersById[army.commanderId];
      const commandAdvantage = ((commander?.command ?? 50) + (commander?.strategy ?? 50)) / 200;
      const localUnrest = (100 - region.loyalty) / 100;
      const defenseRatio = defenderPower / Math.max(1, attackPower);
      const travelPenalty = (estimatedDays / BALANCE.turnDays) * 0.08;
      const score = defenseRatio + travelPenalty - localUnrest * 0.08 - commandAdvantage * 0.025;
      candidates.push({ army, region, targetFaction: region.faction, score });
    }
  }

  candidates.sort(
    (a, b) =>
      Number(defensiveWarTargets.has(b.targetFaction)) - Number(defensiveWarTargets.has(a.targetFaction)) ||
      a.score - b.score ||
      b.army.troops - a.army.troops ||
      a.region.regionId.localeCompare(b.region.regionId),
  );
  return candidates[0] ?? null;
}

/** 军师/玩家可读的 NPC 意图摘要（不泄露精确状态）。 */
export function describeNpcPosture(state: GameState): { faction: FactionKey; text: string }[] {
  const out: { faction: FactionKey; text: string }[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const f = state.factions[key];
    const pressure = f.statusTags.join('、');
    out.push({
      faction: key,
      text: `${f.shortName}：${pressure}。边境调动需斥候核实，朝中动向只能从使节与商路传闻推测。`,
    });
  }
  return out;
}

export function clampMorale(n: number): number {
  return clamp(n);
}

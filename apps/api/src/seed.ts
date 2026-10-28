import fs from 'node:fs';
import type { SeedRoster } from '@tianming/shared';
import type { Db } from './db.js';
import { SEED_PATH } from './db.js';

export function loadSeed(): SeedRoster {
  if (!fs.existsSync(SEED_PATH)) {
    throw new Error(
      `缺少权威种子数据 ${SEED_PATH}。请将 tianming_world_roster_v0_3_1.json 放入 data/source/ 后重启；程序不会凭空生成替代数据。`,
    );
  }
  return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) as SeedRoster;
}

/** 参考数据同步：原始 JSON 为唯一权威来源，DB 只是可查询镜像。 */
export function syncReferenceData(db: Db, seed: SeedRoster): void {
  const tx = db.prepare('SELECT 1');
  void tx;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM relationships');
    db.exec('DELETE FROM characters');
    db.exec('DELETE FROM appointments');
    db.exec('DELETE FROM territories');
    db.exec('DELETE FROM military_districts');
    db.exec('DELETE FROM houses');
    db.exec('DELETE FROM warlord_groups');
    db.exec('DELETE FROM noble_titles');
    db.exec('DELETE FROM map_nodes');
    db.exec('DELETE FROM map_edges');
    db.exec('DELETE FROM military_units');
    db.exec('DELETE FROM national_force_allocations');
    db.exec('DELETE FROM historical_archetypes');
    db.exec('DELETE FROM factions');

    const insertFaction = db.prepare('INSERT INTO factions(key, name, payload) VALUES (?, ?, ?)');
    for (const f of seed.factions) insertFaction.run(f.key, f.name, JSON.stringify(f));

    const insertArch = db.prepare(
      'INSERT INTO historical_archetypes(archetype_id, historical_name, primary_faction_key, payload) VALUES (?, ?, ?, ?)',
    );
    for (const a of seed.historical_archetypes)
      insertArch.run(a.archetype_id, a.historical_name, a.primary_faction_key, JSON.stringify(a));

    const insertChar = db.prepare(
      `INSERT INTO characters(person_id, faction_key, name, identity_type, region, house_or_clan, warlord_group, archetype_id, status, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of seed.characters)
      insertChar.run(
        c.person_id,
        c.faction_key,
        c.name,
        c.identity_type,
        c.region,
        c.house_or_clan,
        c.warlord_group,
        c.archetype_id,
        c.status,
        JSON.stringify(c),
      );

    const insertAppointment = db.prepare(
      'INSERT INTO appointments(assignment_id, person_id, faction, region_or_station, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const a of seed.appointments)
      insertAppointment.run(a.assignment_id, a.person_id, a.faction, a.region_or_station, JSON.stringify(a));

    const insertTerritory = db.prepare(
      'INSERT INTO territories(region_id, faction, region, governor_id, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const t of seed.territories)
      insertTerritory.run(t.region_id, t.faction, t.region, t.governor_id, JSON.stringify(t));

    const insertDistrict = db.prepare(
      'INSERT INTO military_districts(district_id, faction, military_district, commander_id, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const d of seed.military_districts)
      insertDistrict.run(d.district_id, d.faction, d.military_district, d.commander_id, JSON.stringify(d));

    const insertHouse = db.prepare(
      'INSERT INTO houses(house_id, faction, house_name, patriarch_id, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const h of seed.houses)
      insertHouse.run(h.house_id, h.faction, h.house_name, h.patriarch_id, JSON.stringify(h));

    const insertWarlord = db.prepare(
      'INSERT INTO warlord_groups(warlord_id, faction, warlord_group, leader_id, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const w of seed.warlord_groups)
      insertWarlord.run(w.warlord_id, w.faction, w.warlord_group, w.leader_id, JSON.stringify(w));

    const insertTitle = db.prepare(
      'INSERT INTO noble_titles(rank_id, faction, noble_title, holder_id, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const t of seed.noble_titles)
      insertTitle.run(t.rank_id, t.faction, t.noble_title, t.holder_id, JSON.stringify(t));

    const insertRel = db.prepare(
      'INSERT INTO relationships(faction, source_person_id, target_person_id, relation, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of seed.relationships)
      insertRel.run(r.faction, r.source_person_id, r.target_person_id, r.relation, JSON.stringify(r));

    const insertNode = db.prepare(
      `INSERT INTO map_nodes(node_id, faction, region, node_name, node_type, map_x, map_y, controller_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of seed.map_nodes)
      insertNode.run(
        n.node_id,
        n.faction,
        n.region,
        n.node_name,
        n.node_type,
        n.map_x,
        n.map_y,
        n.controller_id,
        JSON.stringify(n),
      );

    const insertEdge = db.prepare(
      `INSERT INTO map_edges(edge_id, from_region, to_region, from_faction, to_faction, base_movement_cost, origin, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of seed.map_edges)
      insertEdge.run(
        e.edge_id,
        e.from_region,
        e.to_region,
        e.from_faction,
        e.to_faction,
        e.base_movement_cost,
        e.origin ?? 'source',
        JSON.stringify(e),
      );

    const insertUnit = db.prepare(
      'INSERT INTO military_units(unit_id, faction_key, unit_name, unit_type, payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const u of seed.military_units)
      insertUnit.run(u.unit_id, u.faction_key, u.unit_name, u.unit_type, JSON.stringify(u));

    const insertAlloc = db.prepare(
      `INSERT INTO national_force_allocations(allocation_id, faction_key, military_district, initial_force_count, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const a of seed.national_force_allocations)
      insertAlloc.run(a.allocation_id, a.faction_key, a.military_district, a.initial_force_count, JSON.stringify(a));

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function referenceCounts(db: Db): Record<string, number> {
  const tables = [
    'factions',
    'historical_archetypes',
    'characters',
    'appointments',
    'territories',
    'military_districts',
    'houses',
    'warlord_groups',
    'noble_titles',
    'relationships',
    'map_nodes',
    'map_edges',
    'military_units',
    'national_force_allocations',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    out[t] = row.n;
  }
  return out;
}

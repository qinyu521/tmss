# 数据字典

## 1. 权威来源

- 路径：`data/source/tianming_world_roster_v0_3_1.json`（1.39 MB，只读）
- 来源：工作区根目录原始文件复制而来，未改动任何字段或数值。
- Excel `tianming_world_roster_v0_3_1.xlsx` 仅用于人工核对，程序不读取。
- 校验脚本：`scripts/validate-seed.ts`（运行 `npm run validate:seed`），报告写入 `docs/DATA_VALIDATION_REPORT.md`。

## 2. 种子表

| 表 | 记录数 | 主要键 | 用途 |
| --- | --- | --- | --- |
| factions | 3 | key | 势力国情、颜色语义、初始兵力、地区概况 |
| historical_archetypes | 100 | archetype_id | 历史原型（只作设计参考） |
| characters | 336 | person_id | 原创人物、属性、原型、身份、忠诚 |
| appointments | 336 | assignment_id | 官职任命与权限范围 |
| territories | 24 | region_id | 州府、主官、地图坐标、风险 |
| military_districts | 18 | district_id | 军区使命、统帅、驻地 |
| houses | 18 | house_id | 世家/部落名册、家主、诉求、宿敌 |
| warlord_groups | 12 | warlord_id | 军阀/藩镇集团 |
| noble_titles | 24 | rank_id | 爵位与持有者 |
| relationships | 183 | 组合 | 人物关系（配偶/亲属/僚属等） |
| map_nodes | 72 | node_id | 州府主城、关隘、港口、粮仓、矿场等 |
| map_edges | 31 | edge_id | 原始道路连接、类型与移动成本 |
| military_units | 22 | unit_id | 特殊兵种名称、定位、强弱与限制 |
| national_force_allocations | 18 | allocation_id | 每国 6 个军区的初始兵力 |
| prototype_affinity_audit | 336 | person_id | 原型归属审计 |
| archetype_allocation_rules | 4 | rule_id | 阵营原型分配规则 |

分布：三国各 112 名原创人物；三国初始兵力 400,000 / 800,000 / 300,000；每国 8 州府、6 军区、6 世家、4 军阀、8 爵位、6 条兵力分配（各 5/10/8 万等，合计精确）。

兵种：匈奴 5（铁浮屠、西夏铁鹞子、蒙古怯薛军、辽国铁林军、清朝索伦兵）；大楚 9（无当飞军、锦帆贼、白马义从、神臂弓手、先登死士、魏武卒、陷阵营、北府兵、白袍军）；大雍 8（背嵬军、虎豹骑、白毦兵、玄甲军、虎贲军、西凉铁骑、戚家军、羽林骑）。

## 3. 校验规则（硬性）

1. 上述计数完全匹配；三国人物各 112。
2. 主键唯一：person_id、node_id、edge_id、unit_id、region_id、district_id、house_id、warlord_id、rank_id、assignment_id。
3. 引用有效：关系两端人物、任免人物、地图控制者/驻将、州府主官/副官/守将、军区统帅、世家家主/继承人/谋士、军阀首领、爵位持有者、人物原型、道路端点。
4. 兵力：每国 6 条分配，合计与 `factions.initial_force_total` 一致。
5. 州府图连通（24/24）。
6. 原始种子中不得出现 `origin=derived` 的边。
7. 原型规则冲突只报告：当前报告 12 条（杜预/羊祜/朱元璋等原型被匈奴或大雍人物引用），未修改原始数据。

## 4. 派生数据（不覆盖原始 JSON）

| 位置 | 内容 | 依据 |
| --- | --- | --- |
| `data/derived/map_extra.json` | 派生地图边（本版 0 条） | 31 条原始边已使 24 州府完全连通；若扩充需写 `derived_reason` |
| `data/derived/map_art.json` | 河流、湖泊、山脉、森林、海岸线、首都标记 | 原创架空地理，仅视觉表现，不改变道路与控制 |
| `packages/shared/src/unitProfiles.ts` | 22 兵种攻防/远程/机动/补给/地形/克制/上限/招募 | 名称与描述来自种子，数值为原创平衡 |
| `packages/shared/src/dataset.ts` | 州府人口/产出/地形推导 | 由 `regional_profile`、`key_locations` 关键词 + 势力修正；公式固定可审查 |
| `packages/shared/src/dataset.ts` | 军区驻地映射 | 军区名称与防区语义（别名表 `DISTRICT_REGION_ALIASES`）；未改种子 |
| `apps/web/src/three/mapScene.ts` | 州府显示偏移 | 原始种子中赤河州（HUN）与辽东州（YONG）同为 `(5,2)`；仅前端将后出现的辽东州及其节点/部队偏移 `(+0.38,+0.42)`，避免显示重叠。原始 JSON 与引擎坐标不变。 |
| `apps/api/migrations/001_init.sql` | SQLite 镜像表与索引 | 参考数据同步；游戏状态快照 |
| `apps/web/public/assets/portraits/*.svg` | 336 张原创肖像 | `scripts/generate-portraits.mjs`，按 person_id 稳定生成 |
| `apps/web/public/assets/units/*.svg` | 22 张兵种图标 | `scripts/generate-unit-icons.mjs`，按 unit_id 稳定生成 |

### 4.1 州府经济推导

- 人口：势力基准人口 × 关键词修正（牧/沙 0.78、农/河谷 1.22、港/商 1.08、矿 0.92）× 稳定抖动。
- 粮产：`人口 × 0.0065 × 地形修正 × 势力粮产系数`。
- 盐产：`(30 + 盐关键词×260) × 势力盐产系数`。
- 铁产：`(20 + 矿关键词×100 + 工坊×40) × 势力铁产系数`。
- 马产：`(30 + 牧场/马市关键词×420) × 势力马产系数`。
- 税基：`人口 × 0.016 × 抖动`。
- 势力系数刻意制造国情：匈奴粮 1.38 / 盐 0.85 / 铁 0.56 / 马 4.6；大雍 1.26 / 0.68 / 2.4 / 0.16；大楚 1.22 / 1.95 / 0.6 / 0.2。

### 4.2 初始部队

以 18 条 `national_force_allocations.initial_force_count` 为唯一兵员总量来源。每个军区编成一个军团，驻地由军区名称/防区推导。每个军团编入 1-2 支特殊兵种分遣队，数量为分配兵力的约 0.75% / 0.45%，且受兵种上限约束；其余为征集兵。特殊兵种分遣队**计入**该军团总兵力，不额外增加兵力。

### 4.3 数据缺失记录

当前工作区包含权威种子，无缺失。若部署时缺失：`data/source/tianming_world_roster_v0_3_1.json` 必须人工放回；程序会在启动时报错，不会生成替代数据。

## 5. 运行时存储

- SQLite：`data/runtime/tianming.db`（WAL、busy_timeout=4s、外键约束）。
- 参考数据表：factions、characters、appointments、territories、military_districts、houses、warlord_groups、noble_titles、relationships、map_nodes、map_edges、military_units、national_force_allocations、historical_archetypes（JSON payload + 常用查询列/索引）。
- 游戏表：games（state_json）、game_events（唯一 event_id）、chronicle_entries、saves（手动/自动）。
- 事件查询默认 `visible=1`；NPC 内部命令入库但不对玩家展示。

### 5.1 0.5.0 新增运行时字段

- `RegionState`：`garrisonCommanderId/garrisonCommanderName`（州兵统带）、`ambushBonus`（伏兵加成，战后清零）、`diversionBonus/diversionFor`（声东击西加成）。
- `Army`：`isDetachment`（分遣队）、`isMilitia`（州兵临时编成）；新军队拥有独立统兵官，同一统兵官不能同时统领两军。
- `Order`：`move_army.amount/units/commanderId`、`recruit.regionId/commanderId/formNewArmy`、`dispatch_garrison`、`scheme`（五类计谋与目标/施计者）。
- 原有存档缺这些字段时按 0/空兼容，不强制迁移；新存档完整写入。


## 5. 战略地图运行时状态

- 权威种子 map_nodes（72 条）与 map_edges（31 条）保持只读。
- GameState.mapNodes 是按每局生成的动态控制态，按 node_id 记录控制方、驻军、城防、补给、地形与资源画像。
- Army.nodeId 保留州府行政/军区定位；Army.mapNodeId、mapPath、mapHopCosts 表示实际战略地图位置与行军路线。
- 附属节点与父州府的连接由 parent_node_id 自动派生，不再依赖额外人工硬编码道路；跨州府道路仍使用原始 map_edges。
- 读档迁移只在缺失时补齐节点状态，保留已有节点控制与驻军；旧版在途路线继续按旧州府路径走完。

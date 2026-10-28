# 种子数据校验报告

审计日期：2026-10-28  
审计基线：权威种子 `data/source/tianming_world_roster_v0_3_1.json`（SHA `3fb4b6acc1754920d2103a47ad9b1dd17cb4dd8c`）  
规则版本：修复分支 `fix/archetype-affinity-audit-v0.6.1`

## 结论

本次静态复核确认：此前报告中的 12 条“原型归属冲突”来自旧校验器硬编码的旧规则，与种子中的 `historical_archetypes.primary_faction_key` 及用户最新明确的历史时代归属规则不一致。修订校验器后，这 12 条旧报告不应再被视为真实冲突，也不应因此错误重映射人物。

**当前静态审计：0 条主归属冲突，0 条中立原型岗位冲突。**  
注意：本报告是对已提交权威种子和修订规则的静态核对结果；完整的 Node/Vitest 执行结果必须以 GitHub Actions 或本地 `npm run validate:seed`、`npm test`、`npm run typecheck`、`npm run build` 的真实输出为准。本报告不声称这些命令已在本次修改环境中运行。

## 数据计数（种子内记录）

| 表 | 记录数 |
| --- | ---: |
| factions | 3 |
| historical_archetypes | 100 |
| characters | 336 |
| appointments | 336 |
| territories | 24 |
| military_districts | 18 |
| houses | 18 |
| warlord_groups | 12 |
| noble_titles | 24 |
| relationships | 183 |
| map_nodes | 72 |
| map_edges | 31 |
| military_units | 22 |
| national_force_allocations | 18 |
| characters_HUN | 112 |
| characters_YONG | 112 |
| characters_CHU | 112 |
| force_HUN | 400000 |
| force_YONG | 800000 |
| force_CHU | 300000 |

## 阵营规则复核

- 匈奴优先承接五胡十六国、辽、元、清及沙陀等北方政权相关历史原型。
- 大楚优先承接汉、宋人物；用户明确指定的韩信、周瑜、鲁肃、陆逊、孟珙、谢安、左宗棠等核心方向维持不变。
- 大雍优先承接唐、明人物；用户此前明确指定的李靖、诸葛亮、赵奢、李勣、曹操、司马懿、祖逖、房玄龄、杜如晦、赵普、包拯等维持不变。
- 隋、晋、春秋战国及部分五代十国原型使用 `COMMON` 中立候选标签，角色职位须为在野、州府地方官、世家、门客或地方军阀等适当岗位。
- 朱元璋及其他明代核心原型按用户规则归入大雍；杜预、羊祜等晋代原型在这份名单中属于中立候选，不再按旧规则强制归入大楚。

## 仍待进一步处理的警告

1. `HUN-P008`、`YONG-P008`、`CHU-P008` 的 `house_or_clan=外戚` 未与 `houses` 表中的实体做规范化关联。建议下一个数据修复阶段改为明确的外戚集团/家族 ID，避免将身份标签误当成世家实体。
2. 地图州府连通并不等于战略路线已经合理。下一阶段需验证每条边的地形/道路类型、移动成本、补给影响、关隘/渡口约束和路径可达性。

## 原始数据保护说明

- 权威种子文件仍然保持原样；本阶段修正校验规则，不擅自重写人物事实。
- 如后续发现真实的原型映射错误，必须通过独立分支、明确的数据 diff、版本变更日志和回归测试修复。
- 合并前应执行 `npm run validate:seed`、`npm test`、`npm run typecheck` 和 `npm run build`。

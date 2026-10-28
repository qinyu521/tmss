# 种子数据校验报告

生成时间：2026-10-28T09:22:32.620Z

结论：**通过（硬性错误 0）**

## 计数

| 表 | 记录数 |
| --- | --- |
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
| connected_regions | 24 |
| force_HUN | 400000 |
| force_YONG | 800000 |
| force_CHU | 300000 |
| top_surname_repeat | 19 |
| cheng_name_count | 0 |

## 硬性错误

- 无

## 警告

- 人物 HUN-P008 的世家 外戚 未在 houses 表中找到同名记录
- 人物 YONG-P008 的世家 外戚 未在 houses 表中找到同名记录
- 人物 CHU-P008 的世家 外戚 未在 houses 表中找到同名记录

## 原型归属冲突（仅报告，未修改原始数据）

- 原型规则冲突：杜预 期望归属 CHU，但人物 HUN-P078(呼延仲平) 属于 HUN，职位 首席谋士/总掌柜
- 原型规则冲突：杜预 期望归属 CHU，但人物 YONG-P056(温德彰) 属于 YONG，职位 淮西州府副官
- 原型规则冲突：杜预 期望归属 CHU，但人物 YONG-P092(谢建平) 属于 YONG，职位 嫡系继承人
- 原型规则冲突：羊祜 期望归属 CHU，但人物 HUN-P077(呼延岳川) 属于 HUN，职位 嫡系继承人
- 原型规则冲突：羊祜 期望归属 CHU，但人物 HUN-P111(纳兰靖礼) 属于 HUN，职位 在野/可招募人才
- 原型规则冲突：羊祜 期望归属 CHU，但人物 YONG-P055(宁珩玉) 属于 YONG，职位 淮西州府主官
- 原型规则冲突：羊祜 期望归属 CHU，但人物 YONG-P091(谢修明) 属于 YONG，职位 家主/宗主
- 原型规则冲突：羊祜 期望归属 CHU，但人物 YONG-P106(王嘉谦) 属于 YONG，职位 在野/可招募人才
- 原型规则冲突：朱元璋 期望归属 CHU，但人物 YONG-P005(晏文叙) 属于 YONG，职位 三皇子/三王子
- 原型规则冲突：朱元璋 期望归属 CHU，但人物 YONG-P027(裴昊谦) 属于 YONG，职位 大鸿胪
- 原型规则冲突：朱元璋 期望归属 CHU，但人物 YONG-P065(孟廷玉) 属于 YONG，职位 京畿禁卫军区副帅/军务参赞
- 原型规则冲突：朱元璋 期望归属 CHU，但人物 YONG-P105(叶乾明) 属于 YONG，职位 军师/幕僚长

> 原始种子 `data/source/tianming_world_roster_v0_3_1.json` 为权威数据，校验脚本不会改写。

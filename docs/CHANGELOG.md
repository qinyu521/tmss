# 变更记录

## 0.6.2 · 2026-10-28（个人部署安全加固）

### 修复
- Docker Compose 的宿主机端口改为仅绑定 `127.0.0.1:8787`，不再默认把游戏 API 暴露到所有网卡。
- 直接运行 API 时默认监听 `127.0.0.1`；只有 Docker Compose 容器内部显式绑定 `0.0.0.0`。
- 新增部署启动保护：`SINGLE_PLAYER_MODE=0` 将拒绝启动，因为当前不存在真实的登录认证与用户级存档隔离。
- Fastify 默认不信任 `X-Forwarded-For` / `X-Forwarded-Proto` 等转发头；只有显式设置 `TRUST_PROXY=1` 才信任一层代理。
- 将部署指南调整为 Cloudflare Tunnel + Cloudflare Access 的个人使用方案，明确 Access Allow policy 只允许所有者，并指出 CORS、HTTPS 和 Tunnel 本身不等于认证。
- 增加部署安全配置单元测试。

### 验证状态
- 等待本分支 CI 实际运行：`npm run validate:seed`、`npm test`、`npm run typecheck`、`npm run build`。
- 该阶段尚未在真实 1 vCPU / 2 GB VPS 上测试网络绑定、Tunnel/Access 登录和重启恢复；不能据此宣称公网部署已完成验收。


## 0.6.1 · 2026-10-28（人物原型归属审计修复分支）

### 修复
- 原型校验器不再使用过时的硬编码例外误报历史人物归属；改为读取权威种子的 `historical_archetypes.primary_faction_key`，并另行核验用户指定的核心原型归属。
- 对 `COMMON` 中立候选原型新增岗位限制，只可用于在野人才、州府地方官、世家、门客、地方军阀等岗位。
- 新增回归测试，覆盖三国核心原型方向和中立候选池岗位约束。
- 修订 `AGENTS.md`：不允许静默修改原始数据；用户明确确认的错误可在独立分支通过可审查 diff、变更日志和回归测试修复。
- 更新数据校验报告，说明旧版 12 条原型冲突来自过时规则。本分支的 Node/Vitest 运行结果仍需 CI 或本地实际执行确认。

### 验证（GitHub Actions 实际执行）
- `npm run validate:seed`：硬性错误 0、警告 3、原型冲突 0。
- `npm test`：6 个测试文件，67/67 通过。
- `npm run typecheck`：通过（shared / api / web）。
- `npm run build`：通过，Vite 生产构建成功并再次完成类型检查。
- CI 记录：https://github.com/qinyu521/tmss/actions/runs/40667972238


## 0.6.0 · 2026-10-28

### 新增

- 人物生命周期（B2，`engine/lifecycle.ts`，schema v2）：每旬按年龄段确定性掷骰（青年 0.1% / 壮年 0.2% / 中年 0.5% / 老成 1.5%，参战主将 +1.5% 战死），随机种子 `mulberry32(hash("{seed}-life-{turn}"))` 可重放；死因分病逝/寿终/战死/暴卒，每次死亡生成 succession 事件（前后状态与证据俱全）。
- 权力继承：州府主官（副手优先、否则同势力在世未主政者治理最高）、部队主将（军区副将优先，士气 -8）、匈奴部落首领（heir 接任，忠诚 -12）、大楚世家家主（heir 接任，支持 -6）、大雍皇子（退出派系、影响力重排、朝局 -10）；玩家人物身故后身份由活人承继，不进入死人视角。
- 成长：potential ≥ 70 且在世者每年（每 52 旬）主属性 +1（上限 95），只写 growthNote/attrs，不发事件。
- 存档迁移框架：`migrateState` 按 `MIGRATIONS` 数组依版本链顺序迁移；v1→v2 补 `characters` 全员在世；`getGameState`/读档自动迁移。`SCHEMA_VERSION=2`。
- 史官讣闻：君主/皇子/首领/家主/主将身故必录 `kind='biography'` 条目（不被旬录 6 条上限截断），facts 取自事件，literary 为悼词模板。
- 视图与接口：`PlayerView.deceased` 本国已故名单；`/api/characters` 与 `/api/characters/:id` 支持 `?gameId=` 合并该局生死/死因/成长/有效属性；人物面板显示「已故·死因」徽记、灰度头像与成长备注。
- 命令校验：已故人物不可任命（PERSON_DEAD）、不可统兵（COMMANDER_DEAD）；自动选将跳过已故者。
- 测试新增 6 项：lifecycle 5（60 回合死亡-事件-继承不变量、v1 迁移幂等、同种子死亡名单一致、玩家君主身故承继、第 52 旬成长）、API 1（gameId runtime 字段）。

## 0.5.2 · 2026-10-28

### 新增

- 季节系统（B4）：`engine/season.ts` 由月份推导四季（3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬），系数全部集中在 `balance.ts` 的 `seasons` 块。
  - 经济：秋收粮产 ×1.6、兵员恢复 ×1.3；冬季粮产 ×0.35、匈奴粮耗 ×1.25、河网州府税收 ×0.9；春季粮产 ×0.9、兵员恢复 ×1.2；夏季盐产 ×1.2。
  - 行军：夏季每跳疲劳 +20%（匈奴再 +15%）；冬季匈奴骑兵为主的部队经河网边成本 ×0.8（封冻涉渡）。
  - 战斗：冬季河网地形水军袭扰 ×0.8、弓骑/轻骑 ×1.1。
  - 事件与视图：`turn_start` 摘要附季节提示；跨季首旬发 `season` 类型事件；`PlayerView.season` 下发季节，顶栏日期旁显示季节与影响提示，事件面板新增「时令」标签。
- 测试新增 9 项（`packages/shared/src/season.test.ts`）：季节边界、秋粮 > 春粮、冬匈奴粮耗 > 夏、冬季河网匈奴行军成本下降且对非骑兵/非河路无效、跨季事件只发一次、同种子同日期两次 runTurn 完全一致。

## 0.5.1 · 2026-10-28

### 新增

- 战报回放（A2）：`packages/shared/src/engine/replay.ts` 新增 `buildBattleReplay(event)` 与 `BattleReplay` 类型——把 battle 事件已结算的兵力/伤亡/胜负按 `mulberry32(payload.seed)` 确定性展开为 3-6 个阶段（接战/相持/决胜，按 payload 加成插入佯攻/伏兵/骑兵迂回阶段）；伤亡分摊累计取整，最终阶段兵力精确等于事件 `after` 的剩余兵力，不重新结算、不与事件矛盾。
- 新路由 `GET /api/games/:id/battles/:eventId/replay`：校验游戏存在（404）、事件存在（404）、类型为 battle（400）；`gameRepo.getEvent` 按 ID 取单条事件完整 payload。
- 前端事件日志的战斗事件新增「回放」按钮与回放模态框（`apps/web/src/components/BattleReplay.tsx`）：setInterval 自动播放、手动步进、暂停/重播；双方兵力条与士气随阶段变化，势力色取自 `FACTION_VISUALS` token，无硬编码势力色。
- 测试新增 6 项：shared 5（确定性深相等、最终兵力与 after 一致且单调、伏兵阶段、三加成六阶段编排、非战斗抛错）、API 1（回放 200 + 两次请求一致 + 非 battle 400 + 事件/游戏不存在 404）。

## 0.5.0 · 2026-10-28

回合指挥与战局深度版本。

### 新增

- **州府驻军**：24 个州府各有常设州兵与统带（来自种子守将），地图标签直接显示「守 X 万」，州府详情与军团面板均可见。
- **按数量调兵/分兵**：`move_army` 支持 `amount`、特殊兵种清单与统兵官。可从 10 万军团中调出 1 万、5 万或任意数量，自动新建分遣队；特殊兵种按指定数量随军，不再整军团一刀切。
- **调遣州兵**：新命令 `dispatch_garrison`，从任一州府调出州兵组成野战部队，州府守备相应减少，可指定统兵官。
- **征兵扩军**：征募可选择州府、是否新建军团、统兵官；可补入现有军团、编入州兵或新建「新募营」。
- **计谋系统**：火攻、断粮、离间、预设伏兵、声东击西。每种有银钱成本、成功率（受谋略、敌将权谋、地形影响）、确定性判定种子与独立事件；成功可减员、断补给、降士气、削弱敌国政治或改变战场加成。
- **武将与以少胜多**：统率/谋略权重显著提高；新增骑兵迂回（机动差）、伏兵、佯攻加成；战报事件展示双方统兵官、兵力比、加成与随机种子。
- **朝议补全**：新增本旬朝议议题、近期朝局/战报密报、召开廷议入口；朝议不再只有派系数值。
- **军师可玩**：军师可直接施计与侦察（不能调动军队/国政），拥有独立操作空间。
- **战报回放**：战斗事件可按阶段回放，显示双方统兵官、兵力比与伏兵/迂回/佯攻阶段（沿用现有 `BattleReplay`）。
- **外交修正**：外交键顺序统一为 HUN/YONG/CHU，修复大雍-大楚被误判为未交战的问题；三国形成完整敌对/戒备关系。

### 修复

- 州兵调出后地图、右栏、军团面板同步显示剩余守备。
- 同一统兵官不能被同回合两条命令重复占用（含待结算命令）。
- 命令结果在切换页签时清除，避免旧错误残留。
- 与 0.4.1 的 LLM Provider 兼容：计谋/分兵等新事件仍可用模板史官，AI 润色不动事实。

## 0.4.1 · 2026-10-28

### 新增

- 可选 LLM 史官 Provider（A1）：`apps/api/src/llm.ts` 实现 OpenAI 兼容 Chat Completions 调用，配置走 `LLM_PROVIDER`/`LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`/`LLM_TIMEOUT_MS` 环境变量，fetch 实现可注入，无新增依赖；无密钥时游戏完整可玩。
- 新路由 `POST /api/games/:id/chronicle/llm { turn }`：只读该回合史官条目事实层与事件摘要，仅回写 literary/inference 并把 `generatedBy` 标为 `'llm'`；无配置返回 `LLM_DISABLED`，失败/超时/非法输出返回 `LLM_FAILED`/`LLM_BAD_RESPONSE`，模板条目保持不变。
- 前端史官面板新增「AI 润色本旬」按钮（仅 `llmEnabled` 时显示），条目增加「模板 / AI 润色」来源标记；`.env.example` 增加 5 个 LLM 变量模板。
- 测试新增 2 项：LLM 未配置时条目不变；注入假 fetcher 验证只更新表达层、facts 不变、`generatedBy` 变为 `'llm'`。

## 0.4.0 · 2026-10-28

首个可运行纵向版本。

### 新增

- monorepo：`apps/web`（React + Vite + Three.js）、`apps/api`（Fastify + Node 内置 SQLite）、`packages/shared`（类型/常量/平衡/规则引擎/玩家视图）。
- 权威种子导入：`data/source/tianming_world_roster_v0_3_1.json` 只读；`scripts/validate-seed.ts` 校验计数、唯一性、引用、兵力、连通性、原型冲突；报告写入 `docs/DATA_VALIDATION_REPORT.md`。
- 确定性引擎：7 天回合、命令权限/资源校验、资源账本与短缺惩罚、行军/地形/补给/战斗（可重放 seed）、三国政治机制、NPC 启发式、事件唯一 ID、模板史官（事实/文学/推断分层）。
- 3D 地图：72 节点、31 条原始边、24 州府（Voronoi 分区改为地形最近州府着色）、地形/河流/湖泊/山脉/森林/道路/海岸、州府与资源点低多边形模型、部队旗标与行军路线、10 个图层、镜头控制、标签避让。
- 界面：开始/载入、主地图、国家、人物、军团、朝议、兵种、史官、存档、设置、命令面板；响应式布局。
- 原创资产：336 张稳定 SVG 肖像（按 person_id 生成，九类身份不同头饰/服饰/胡须/背景），22 张兵种图标，程序化低多边形兵种模型。
- API：健康检查、配置、地图、势力、人物（分页/详情/关系）、兵种、审计、开局、命令提交/撤销、结束回合、事件、史官、存档/读档、删除时间线、NPC 意图（调试）。
- 部署：Dockerfile、compose.yaml、`.env.example`、Caddy/Nginx/Cloudflare Pages/Tunnel/备份恢复文档。
- 测试：Vitest 32 项（引擎 17、API 9、种子 6）；Playwright 浏览器冒烟脚本与 8 张截图。
- 文档：AGENTS、README、PROJECT_SPEC、DATA_DICTIONARY、ENGINE_RULES、ART_DIRECTION、DEPLOYMENT、IMPLEMENTATION_STATUS、CHANGELOG。

### 修复

- 地图道路按州府名称连接改为 ID 映射（此前寻路为空）。
- `validateOrder` 在回合内重复校验自身命令导致误判“命令上限”；改为排除自身。
- 人物详情 SQL 引用不存在的列（heir_id 等）导致 500；改用 `json_extract(payload, ...)`。
- Voronoi 裁剪公式错误导致 NaN 几何与州府覆盖空洞；改为地形网格最近州府着色 + 网格边界，彻底移除 NaN。
- 右侧详情面板未包裹 `.right-panel` 容器，内容错位到左侧导航；修复。
- 玩家视图泄露 NPC 内部命令；NPC 事件默认不可见。
- Node 22 内置 `node:sqlite` 在 Vitest 下解析失败；改用 `createRequire` 加载，避免 Vite 预打包。
- `better-sqlite3` 在无 MSVC 的 Windows 上编译失败；移除原生依赖，改用内置 SQLite。

### 变更

- 初始地图镜头从聚焦首都改为全大陆总览；缩短标签重叠阈值并优先本国标签。
- 势力色改为地形顶点着色，保证完整覆盖、无重叠压盖；降低直射光、增强环境光以保持色相。
- 草原/山地装饰增加 LOD：道路仅在近距离显示，树木/岩石在远距离隐藏。
- 头像生成器增加面部阴影、颚线、年龄纹、胡须/髭、势力专属冠帽，降低幼态感（仍为插画风）。
- 新增原型核心归属差异提示：`/api/audit` 返回 `coreConflicts`，人物详情返回 `coreConflict`，人物面板显示核对提示；不修改种子。
- 地图渲染改为地形顶点最近州府着色 + 网格边界，移除原 Voronoi 面片；赤河/辽东共用坐标仅做前端显示偏移。

### 数据说明

- 未修改任何原始种子数据。赤河州与辽东州在种子中共享 `(5,2)` 坐标，前端仅做显示偏移并在数据字典记录。
- 本版无派生地图边：31 条原始边已使 24 州府完全连通。
- 原型归属冲突 12 条仅报告（杜预、羊祜、朱元璋等被其他阵营引用），供人工核对。

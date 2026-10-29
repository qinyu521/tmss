# 天命史书 · AI 架空历史世界模拟器

浏览器运行的架空历史大地图策略游戏原型：选择匈奴 / 大雍 / 大楚之一及身份（君主 / 州牧 / 将军 / 军师），在 3D 大地图上经营、行军、交涉与结算。世界事实由确定性规则引擎裁决，AI 史官只做记录与评述。

> 单机 / 个人部署原型。1 vCPU / 2 GB RAM 仅适合个人或极小规模使用，不承诺并发能力。

## 技术栈

- 前端：React 18 + TypeScript + Vite + Three.js + zustand
- 后端：Node.js 22 + Fastify + 内置 `node:sqlite`（WAL）
- 共享：`packages/shared`（类型、平衡常量、规则引擎、玩家视图）
- 测试：Vitest（引擎 / 种子校验 / API 集成）+ Playwright（浏览器冒烟）

## 快速开始

要求：Node.js **22.13+**（需要内置 `node:sqlite`；本项目在 22.20 上验证），npm 10+。

```bash
npm install
npm run assets        # 生成 336 个原创 SVG 肖像与 22 个兵种图标（已生成时可跳过）
npm run dev           # 同时启动 API(8787) 与 Web(5173)
```

打开 http://localhost:5173 。

只启动后端 / 前端：

```bash
npm run dev:api
npm run dev:web
```

生产构建：

```bash
npm run assets
npm run build         # 构建前端 + 全仓 TypeScript 类型检查
npm start             # 用 API 托管已构建前端：http://localhost:8787
```

环境变量见 `.env.example`。未配置任何 LLM 密钥时，史官使用本地模板，核心玩法完整可玩。

## 验证命令（真实执行记录见 docs/IMPLEMENTATION_STATUS.md）

```bash
npm run validate:seed   # 计数 / ID 唯一 / 引用 / 兵力 / 连通性 / 原型冲突报告
npm test                # 引擎/回放/种子/API 集成测试；测试总数以命令输出和 CI 为准
npm run typecheck       # shared + api + web
npm run build           # 前端生产构建
npm run smoke           # 对运行中的 API 做端到端冒烟（需先启动 npm run dev:api）
npm run smoke:browser   # Playwright 浏览器冒烟与截图（需先启动 dev；首次先 npx playwright install chromium）
```

浏览器冒烟默认使用 Playwright 自带 Chromium；若本机已有旧版 Chromium，可用 `CHROMIUM_PATH` 指定可执行文件。截图输出到 `browser-shots/`（已 gitignore）。

## 目录

```text
apps/web                 React + Three.js 前端（3D 地图、面板、命令）
apps/api                 Fastify API、SQLite 迁移、存档与事件
packages/shared          类型 / 平衡 / 单位档案 / 确定性规则引擎 / 玩家视图
data/source              权威种子 JSON（只读，不覆盖）
data/derived             派生地图边（本版为 0 条）、美术地理、说明
docs                     规格、数据字典、规则、美术、部署、状态、变更
scripts                  种子校验、导入、头像/图标生成、冒烟测试
```

## 已实现的纵向流程

选择势力与身份 → 3D 地图（拖拽/缩放/旋转/倾斜、州府与 72 个战略节点选中、控制方图层、行军路线与部队位置）→ 查看 336 人物、原型备注、关系、22 特殊兵种和关键人物当前目标 → 下达军事/民政/政治/外交/计谋命令（后端校验权限与资源）→ 结束本回合（7 天）→ 三国 NPC 与重要人物按目标自主行动 → 资源账本与短缺惩罚 → 节点行军、据点争夺、州府战役 → 事件日志、人物动向与史官编年 → 自动/手动存档与读档。

0.5.0 版指挥系统：

- **每州有常设州兵**（地图标签显示「守 X 万」），可从州府调出州兵单独成军，调出后本地防御下降。
- **按数量调兵**：军团可调 1 万、5 万或任意数量，自动编成分遣队；可选择随军特殊兵种与统兵官。
- **征兵扩军**：可在指定州府补入现有军团、编入州兵，或新建「新募营」并选将统带。
- **计谋**：火攻、断粮、离间、伏兵、声东击西；成功率受谋略/权谋/地形影响，失败也耗银；军师可直接施计。
- **武将与以少胜多**：统率/谋略显著影响战力，叠加伏兵、迂攻、兵种克制、补给与士气，弱旅可胜强敌。
- **战报**显示双方统兵官、兵力比、加成与随机种子，并可回放确定性战果；**朝议**可提出军务、赋役、派系三类议案，列席官员确定性投票，政策通过后才产生真实资源与政治后果。

三国国情机制参与结算：

- **匈奴**：联盟协调度决定可调动兵力；部落忠诚过低会拒绝出兵；缺粮、缺盐、铁料受限导致士气、逃兵与骑兵损耗。
- **大雍**：皇子派系影响力与朝局稳定；低于阈值触发夺嫡危机，压低行政与征募效率；缺盐、缺战马。
- **大楚**：世家支持影响税赋配合与征兵；支持过低触发集体抵制；缺战马、缺铁。

## 数据与原型归属

- 种子：100 个历史原型、336 名原创角色（三国各 112）、24 州府、18 军区、18 世家、12 军阀、24 爵位、183 关系、72 地图节点、31 原始边、22 特殊兵种、18 条兵力分配。
- 三国初始兵力精确为 **40 万 / 80 万 / 30 万**，18 条分配记录合计一致。
- 原始边已使 24 州府完全连通，**本版未新增任何派生边**（`data/derived/map_extra.json`）。
- v0.6.1 校验器修正后，100 个历史原型与 336 个原创人物的主归属冲突为 **0**；仍有 3 条外戚家族 ID 规范化警告，见 `docs/DATA_VALIDATION_REPORT.md`。
- 历史人物只作为能力/制度/战略原型；游戏人物使用独立姓名、ID、关系与命运。

## 部署

- 一体化：`docker compose up -d --build`，本机访问 `http://127.0.0.1:8787`，数据库挂载到 `./data/runtime`。Compose 默认只绑定宿主机回环，不会直接开放公网 8787；VPS 远程访问请先配置单人策略的 Cloudflare Access + Tunnel。
- 前端独立：Cloudflare Pages 构建 `npm run build -w @tianming/web`，输出 `apps/web/dist`，设置 `VITE_API_BASE`。
- API：个人 VPS 优先使用 Cloudflare Tunnel + Access；Caddy/Nginx 必须配置认证后才可公开使用。仅 HTTPS/CORS 不会阻止未授权 API 调用，详见 `docs/DEPLOYMENT.md`。

## 当前限制

- 单机/个人模式，无应用内登录鉴权或按用户隔离存档；Compose 只绑定 `127.0.0.1:8787`。公开访问必须由只允许实例所有者的 Cloudflare Access 或等效认证网关保护；`SINGLE_PLAYER_MODE=0` 会因未实现多人认证而拒绝启动。
- 可选 LLM 史官润色：配置 `LLM_PROVIDER`/`LLM_API_KEY` 后可手动润色指定回合的 `literary/inference`，默认仍使用本地模板；音效预留未实现。
- 战斗结果仍由规则引擎一次性确定，不是可操作的实时战术战斗；战报回放以已结算战果驱动三维战场阵列、地形与阶段演出，WebGL 不可用时回退为二维阵列示意；水战仍主要以兵种/地形修正体现。
- 存档 schema v6；迁移链 v1 → v2（人物运行时数据）、v2 → v3（跨回合行军进度）、v3 → v4（72 节点控制状态与军团节点路线）、v4 → v5（持久化人物目标默认值）、v5 → v6（外交条约账本）。带权威种子读档时幂等补齐节点和目标字段，不覆盖既有节点易手或活跃人物目标。读档回滚时会清除存档点之后的事件。
- 浏览器 3D 依赖 WebGL；低端设备建议在设置中切换低画质。

详细规格、规则与验收记录见 `docs/`。

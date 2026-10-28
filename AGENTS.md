# AGENTS.md · 天命史书长期开发规则

本文件是本项目的长期约束，优先级高于临时需求。任何新增功能都必须遵守。

## 一、数据保全（最高优先级）

1. `data/source/tianming_world_roster_v0_3_1.json` 是**权威初始种子**，只读。任何代码、脚本、迁移都不得改写、覆盖或用程序生成的数据替换它。
2. 若种子文件缺失，必须在 `docs/IMPLEMENTATION_STATUS.md` 记录缺失原因和人工导入路径（`data/source/tianming_world_roster_v0_3_1.json`），不得凭空生成替代数据。
3. 允许新增的内容必须放在 `data/derived/`（派生边、美术地理、部署映射）或迁移文件，并在 `docs/DATA_DICTIONARY.md` 记录依据。
4. 修改数据前先运行 `npm run validate:seed`。硬性错误（计数、ID 重复、引用失效、兵力合计）导致构建失败。
5. 原型归属与用户既定规则冲突时，先生成 `docs/DATA_VALIDATION_REPORT.md` 冲突报告；**不得静默修正**。
6. 对已经由用户明确确认的阵营/原型规则，可在独立分支中修复权威种子 JSON，必须同步更新原型映射、关系/任命引用、变更日志及回归测试；不可直接覆写 `main`，必须提供可审查 diff。
7. Excel 仅供人工核对，程序只读取 JSON。

## 二、事实由规则引擎决定

- 前端只能提交 `Order`（意图）。权限、资源、距离、时序、前置条件由 `packages/shared/src/engine` 校验，结算只发生在后端。
- NPC/AI 只能选择动作，不能直接改兵力、财政、死亡、任免、领土或战斗结果。
- 每次状态变化必须生成唯一 `event_id`，带前后状态、来源、执行者与证据。
- 战斗必须保留随机种子，可重放。随机数只能来自确定性 PRNG（mulberry32），不得使用 `Math.random()` 参与结算。
- 数值全部集中在 `packages/shared/src/balance.ts` 与派生兵种档案，禁止散落在 UI 中。

## 三、权限不可被自然语言绕过

角色权限矩阵唯一定义在 `packages/shared/src/constants.ts` 的 `ROLE_ALLOWED_ORDERS`：

- 君主：全部命令。
- 州牧：本州民政、征募、贸易、部落/世家协商、驻本州部队与侦察。
- 将军：仅自己统率部队的行军、整军与侦察。
- 军师：仅侦察；不能改动国政与军队。

## 四、信息不对称

- 人物与玩家都不是全知。玩家视图由 `buildPlayerView` 生成，敌方精确库存、兵力、士气与内政数值不得下发。
- 情报必须有来源、可靠度、发生/获知时间与证实状态。侦察给出的是估算值，允许误差。
- 史官：`facts` 只能复述规则事件；文学润色与推断必须分开标记，不能改动事实。

## 五、技术栈与架构

- 前端 React + TypeScript + Vite + Three.js（不使用 R3F，保持依赖精简）；状态用 zustand。
- 后端 Node.js 22 + TypeScript + Fastify；SQLite 使用 Node 内置 `node:sqlite`（WAL），通过 `apps/api/migrations` 迁移。
- 共享类型、常量、引擎在 `packages/shared`；API 只做持久化、校验和编排。
- 地图由数据生成（72 节点 / 31 边 / 24 州府 / 派生美术地理），禁止把地图做成静态图片。
- 不使用任何商业游戏素材；头像与兵种模型必须程序化原创。
- 颜色使用 `FACTION_VISUALS` 设计 Token，禁止组件内硬编码势力色。

## 六、测试与验收

提交前至少运行：

```bash
npm run validate:seed
npm test
npm run typecheck
npm run build
```

- 不得声称未运行的测试通过。`docs/IMPLEMENTATION_STATUS.md` 只记录真实结果。
- 新增规则必须同时添加/更新测试；新增 API 必须有集成测试或用例。
- 任何里程碑完成后更新 `docs/IMPLEMENTATION_STATUS.md` 与 `docs/CHANGELOG.md`。

## 七、性能与部署

- 目标环境：1 vCPU / 2 GB RAM 的单机或极小规模部署。回合制、按需结算，禁止高频后台 tick。
- 地图使用实例化/低多边形/标签按距离显隐；避免大量独立高面数模型。
- 不允许把世界模拟放进 Cloudflare Workers 请求处理逻辑。Workers 只做静态资源/网关。
- 本地 LLM 不部署在 VPS；外部 LLM 为可选 Provider，默认关闭，无密钥时游戏必须完整可玩。
- 不提交真实密钥；配置写入 `.env`（模板为 `.env.example`）。

## 八、风格与文档

- 文案与注释使用中文；代码标识符使用英文。
- 视觉：写实残酷 + 黑幽默 + 偶尔温情，避免现代网络梗破坏历史语感。
- 每个新增系统先在 `docs/ENGINE_RULES.md` 写清规则，再实现。
- 不创建“只有静态假页面”的功能；未完成的部分列入路线图，不伪装为已完成。

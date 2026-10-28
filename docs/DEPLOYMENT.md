# 部署说明（1 vCPU / 2 GB 目标）

## 1. 模式声明

默认单机/个人模式：**无登录鉴权**。请勿把 8787 直接裸暴露到公网；至少使用 HTTPS 反向代理、Cloudflare Tunnel 或网关鉴权。

## 2. 本地 / 单机

```bash
cp .env.example .env
npm ci
npm run assets
npm run build
npm start          # API + 静态前端，http://localhost:8787
```

仅开发：`npm run dev`（API 8787 + Vite 5173，已配置 /api 代理）。

### .env

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PORT | 8787 | API 端口 |
| HOST | 0.0.0.0 | 监听地址 |
| TIANMING_DB | data/runtime/tianming.db | SQLite 路径（相对仓库根） |
| CORS_ORIGIN | http://localhost:5173,... | 逗号分隔允许来源 |
| SERVE_WEB | 1 | 是否由 API 托管 `apps/web/dist` |
| SINGLE_PLAYER_MODE | 1 | 标注部署模式 |
| LLM_PROVIDER / KEY / MODEL | 空 | 可选，默认关闭 |
| ALLOW_BACKUP_ENDPOINT | 0 | 备份 HTTP 接口默认关闭 |

## 3. Docker Compose（VPS 一体化）

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/api/health
```

- 镜像：Node 22（Debian slim），运行 `tsx apps/api/src/server.ts`。
- 持久化：`./data/runtime` 挂载到容器 `/app/data/runtime`（数据库 + WAL + backups）。
- 健康检查：`fetch /api/health`。
- 日志：`docker compose logs -f --tail=200`；compose 已限制 json-file 大小与数量。
- 资源：建议 `mem_limit: 1g`、`cpus: 1.0`（compose 中给出注释示例，按机器调整）。

### 反向代理（Caddy 示例）

```caddy
api.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
```

Nginx 等价：

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

防火墙只开放 80/443；8787 绑定本机回环或 Docker 内网。

## 4. 前端独立部署到 Cloudflare Pages

- Repository：本仓库
- Build command：`npm run assets && npm run build -w @tianming/web`
- Output directory：`apps/web/dist`
- Environment：`VITE_API_BASE=https://api.example.com`
- API 侧 `CORS_ORIGIN` 加入 Pages 域名（如 `https://tianming.pages.dev`）。

Cloudflare Workers 只用于静态资源/网关/缓存，不承载世界模拟。后台回合结算必须在 VPS API 执行。

## 5. Cloudflare Tunnel（不暴露端口）

```bash
cloudflared tunnel create tianming
cloudflared tunnel route dns tianming api.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 tianming
```

将 Tunnel 配置设为系统服务；CORS 与 `SERVE_WEB=1` 按需设置。

## 6. 备份与恢复

### 在线备份（推荐，WAL 安全）

```bash
docker compose exec tianming node -e "
const { createRequire } = require('module');
const r = createRequire('/app/apps/api/src/db.js');
const { DatabaseSync } = r('node:sqlite');
const db = new DatabaseSync('/app/data/runtime/tianming.db');
require('fs').mkdirSync('/app/data/runtime/backups',{recursive:true});
db.exec(\"VACUUM INTO '/app/data/runtime/backups/tianming-' || Date.now() || '.db'\");
"
```

或设置 `ALLOW_BACKUP_ENDPOINT=1` 后调用 `POST /api/admin/backup`（内部工具，不建议公网开放）。

### 冷备份

```bash
docker compose stop tianming
cp -r data/runtime data/runtime.bak-$(date +%F)
docker compose start tianming
```

### 恢复

```bash
docker compose stop tianming
cp data/runtime.bak-YYYY-MM-DD/tianming.db data/runtime/tianming.db
rm -f data/runtime/tianming.db-wal data/runtime/tianming.db-shm
docker compose start tianming
```

建议 cron 每日备份并保留 7-14 天；备份文件包含存档与事件，不含密钥。

## 7. 健康检查与运维

- `GET /api/health`：返回 `ok`、schema 版本、种子计数、模式、LLM 状态。
- 日志：Fastify pino 输出到 stdout；Docker json-file 轮转（max-size 10m, max-file 3）。生产也可接入 journald/loki。
- 速率限制：POST/DELETE 每 IP 60 秒 120 次（内存实现，重启重置；单机足够）。
- 输入校验：zod；请求体上限 256 KB；错误响应不泄露堆栈。
- 进程退出：SIGINT/SIGTERM 关闭 Fastify 与 SQLite。

## 8. 升级

1. 备份数据库。
2. 拉取新版本；`docker compose build`。
3. 迁移在启动时执行（`apps/api/migrations`，当前 schema v1）。破坏性变更须新增迁移文件并记录。
4. 若 schema 不兼容，应用拒绝旧存档前会在 `IMPLEMENTATION_STATUS` 说明。

## 9. 青龙面板（可选，仅定时任务）

青龙面板是定时脚本/任务面板，**不适合托管 Web 前端或长时间世界模拟**。若已在用青龙，可仅用它做：

- 每日调用健康检查（HTTP 请求 `https://api.example.com/api/health`）并在失败时通知；
- 每日执行宿主机备份脚本（`docker compose stop` → 复制 `data/runtime` → `start`），或 `docker exec` 运行 `VACUUM INTO`；
- 清理旧备份（保留 7–14 天）。

游戏本体仍应运行在 Docker Compose 的 Node 22 容器中（8787），由 Caddy/Nginx 或 Tunnel 暴露 HTTPS。

## 10. 性能与容量

- 回合按请求触发，无后台高频 tick；地图与参考数据缓存；事件按回合索引。
- 1 vCPU / 2 GB 仅适合个人/极小规模（数个并发浏览器会话），不宣称可承载大量同步玩家。
- 前端 3D 依赖客户端 GPU/WebGL；低端设备请切换低画质。

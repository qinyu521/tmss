# 部署说明（1 vCPU / 2 GB 目标）

## 1. 模式声明

默认单机/个人模式：**没有应用内登录鉴权，也没有按用户隔离存档**。知道站点地址且通过外围访问控制的人，可以读取、创建、推进、加载或删除这台实例中的游戏。因此：
- 不要将 8787 直接映射到公网；Compose 默认只绑定宿主机 `127.0.0.1:8787`。
- 远程个人使用时，推荐将单体应用放在一个主机名下，并使用 **Cloudflare Tunnel + Cloudflare Access**，Access 的 Allow policy 只允许你自己的身份；先创建 Access 应用与策略，再发布 Tunnel 路由，并开启 Tunnel 的 **Protect with Access**。
- HTTPS、CORS 或一条 DNS/Tunnel 公布路线本身都不等于身份认证。CORS 不能阻止 curl、脚本或其他非浏览器客户端。
- 当前把 `SINGLE_PLAYER_MODE=0` 设成“多用户”会直接拒绝启动，直到实现登录、游戏所有权校验、存档隔离和对应安全测试。不要绕开这个启动检查。
- 参考官方文档：[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/) 与 [Cloudflare Access 保护自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

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
| HOST | 127.0.0.1 | 直接运行时仅监听本机；Docker Compose 在容器内覆盖为 0.0.0.0 |
| TIANMING_DB | data/runtime/tianming.db | SQLite 路径（相对仓库根） |
| CORS_ORIGIN | http://localhost:5173,... | 逗号分隔允许来源 |
| SERVE_WEB | 1 | 是否由 API 托管 `apps/web/dist` |
| SINGLE_PLAYER_MODE | 1 | 仅支持单机/个人模式；设为 0 会因未实现多用户认证而拒绝启动 |
| TRUST_PROXY | 0 | 默认不信任转发头；仅当源站只能经一个可信代理访问时才设为 1 |
| LLM_PROVIDER / KEY / MODEL | 空 | 可选，默认关闭 |
| ALLOW_BACKUP_ENDPOINT | 0 | 备份 HTTP 接口默认关闭 |

## 3. Docker Compose（VPS 一体化）

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/api/health
```

- 镜像：Node 22（Debian slim），运行 `tsx apps/api/src/server.ts`。
- 暴露端口：宿主机仅绑定 `127.0.0.1:8787`，所以服务器公网 IP 的 8787 端口不会被这个 Compose 配置直接开放。要远程访问，请使用下方 Cloudflare Access/Tunnel 方案。
- 持久化：`./data/runtime` 挂载到容器 `/app/data/runtime`（数据库 + WAL + backups）。
- 健康检查：`fetch /api/health`。
- 日志：`docker compose logs -f --tail=200`；compose 已限制 json-file 大小与数量。
- 资源：建议 `mem_limit: 1g`、`cpus: 1.0`（compose 中给出注释示例，按机器调整）。

### 反向代理（可选）

**不要使用未加认证的公开反向代理配置。** 如果不使用 Cloudflare Access，至少应在 Caddy/Nginx 这一层配置访问认证，并在防火墙上只开放代理端口。下面的 Caddy Basic Auth 示例需要先运行 `caddy hash-password` 生成散列，替换用户名和散列值：

```caddy
tianming.example.com {
  encode gzip
  basic_auth {
    YOUR_USERNAME REPLACE_WITH_CADDY_PASSWORD_HASH
  }
  reverse_proxy 127.0.0.1:8787
}
```

如果用 Nginx，也必须配置 `auth_basic`/可信认证网关；只配置 HTTPS 和 `proxy_set_header` 不会限制谁能访问。

`TRUST_PROXY=1` 仅用于源站无法绕过、且前面只有一层可信反向代理的部署。若代理可以绕过，或需要信任多跳代理，先明确可信代理链；否则保持默认 `0`。

## 4. Cloudflare Pages（暂不推荐作为单机模式的默认部署）

当前版本推荐让 API 同时托管 Web 前端（`SERVE_WEB=1`），使用单一主机名，再由 Cloudflare Access 控制整站访问。将前端放在 Pages、API 放在另一主机名，会引入跨域 Cookie/Access 登录、CORS 与认证凭据传递问题；本项目尚无应用内会话和多用户授权层，不能把单纯设置 `VITE_API_BASE` 与 CORS 误认为安全方案。

Cloudflare Workers 只用于静态资源/网关/缓存，不承载世界模拟。后台回合结算必须在 VPS API 执行。若后续要使用 Pages 独立前端，必须先设计并测试跨域认证、凭据传递、API 所有权校验和按用户隔离。

## 5. Cloudflare Tunnel + Access（个人远程访问推荐）

**先配 Access，再发布 Tunnel 路由。** 若先发布一个没有 Access 的公开 hostname，任何互联网访问者都可能使用你的游戏实例。

1. 在 Cloudflare Zero Trust 控制台进入 **Access → Applications**，创建一个 Self-hosted 应用，主机名例如 `tianming.example.com`。
2. 添加 Allow policy，只允许你自己的邮箱/身份提供商账号；确认没有匹配的访客会被拒绝。不要配置“所有人都允许”。
3. 在 **Networking → Tunnels** 创建或选择 Tunnel，把公开主机名路由到本机服务 `http://localhost:8787`（如果 `cloudflared` 运行在宿主机上）。如果 `cloudflared` 跑在另一个容器/主机上，改成该服务实际可达的内部地址。
4. 在 Tunnel 对应 hostname 的设置中启用 **Protect with Access**，让 Tunnel/源站校验 Access token；这能避免只依赖边缘登录页面而源站仍可被绕过。
5. 将 `cloudflared` 安装为系统服务，或使用 Cloudflare 控制台提供的安装命令。保留 Compose 的 `127.0.0.1:8787:8787` 绑定，不要另开公网 8787。

官方步骤：[创建 Tunnel 并发布应用](https://developers.cloudflare.com/tunnel/get-started/)；[为自托管应用添加 Access 认证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

由于本版本是单人实例，Access 策略应只授权实例所有者。多人联机必须等应用层用户认证和存档隔离实现后再开放。

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

- `GET /api/health`：返回 `ok`、schema 版本、种子计数、模式、LLM 状态。它不是访问控制接口。
- `SINGLE_PLAYER_MODE=0` 会在 API 启动时失败关闭；当前版本不能安全地被多人共享使用。
- 默认不信任 `X-Forwarded-For`；只有在应用无法被绕过的单一可信代理后运行时，才配置 `TRUST_PROXY=1`。
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

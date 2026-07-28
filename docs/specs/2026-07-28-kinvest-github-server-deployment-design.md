# Kinvest GitHub 自动部署与服务器切换设计

## 1. 目标

将 Kinvest 当前 Mock 前后端部署到 `https://dearmina.cn` 和
`https://www.dearmina.cn`，复用服务器现有 HTTPS、Nginx 和 Certbot。
部署完成后，推送到 GitHub `main` 分支可触发测试和受控自动部署。

本次上线是家庭预览环境，不接入真实 iFinD、模型、腾讯云密钥服务或任何
生产凭据。页面必须继续明确标注 Mock 数据和缓存/刷新状态。

## 2. 已确认的服务器现状

- 主机：`106.54.229.241`
- 系统：CentOS Stream 9
- SSH：端口 `4334`，当前由 root 密钥完成一次性引导
- 域名：`dearmina.cn`、`www.dearmina.cn`
- 容器：Docker 28.1.1、Docker Compose 2.35.1
- 线上入口：Docker Nginx，占用 80/443
- HTTPS：Let's Encrypt 证书有效期至 2026-09-27
- 现有站点：`/root/docker/nginx/html` 中的静态小游戏
- 现有 `/api/judge` 代理没有对应的 5000 端口监听服务
- MySQL、旧占位 app 和 Certbot 一次性容器均处于停止状态
- 服务器还运行 Tailscale；本次部署不修改其配置

服务器存在 `/root/docker/.env` 和 MySQL 数据目录。部署过程不得读取、
复制、输出、提交或修改其中的凭据与数据。

## 3. 选择的架构

```text
GitHub main
    |
    | tests + controlled SSH deployment
    v
kinvest-deploy user
    |
    | sudo: one root-owned deployment command only
    v
/root/apps/Kinvest
    |
    | Docker build
    v
kinvest container :4173
    |
    | private external Docker network: web
    v
existing nginx container :80/:443
    |
    v
dearmina.cn
```

现有 Nginx 和 Kinvest 使用同一个名为 `web` 的外部 Docker 网络。
Kinvest 只声明容器内部端口 `4173`，不将该端口发布到公网或宿主机。
Nginx 通过 `http://kinvest:4173` 访问应用。

应用使用单独的 Compose 文件，由 Kinvest 仓库维护。现有
`/root/docker/docker-compose.yml` 只做一次最小修改：将 Nginx 接入
`web` 网络。现有 MySQL、Certbot 和数据卷定义保持不变。

## 4. Kinvest 容器

容器使用 Node.js LTS Alpine 基础镜像，并以非 root 用户运行。镜像只包含
运行所需代码，不包含 `.git`、测试输出、日志、数据库、`.env` 或凭据。

SQLite 数据写入独立宿主机目录：

```text
/root/docker/kinvest/data
```

该目录挂载到容器 `/data`，应用通过 `KINVEST_DB_PATH` 指向
`/data/kinvest.sqlite`。数据库、journal 和备份文件均不得提交 Git。

容器提供 `/api/health` 健康检查，至少验证：

- HTTP 服务可响应
- SQLite 可打开
- 当前数据模式明确为 `mock`
- 不要求 iFinD 或模型密钥存在

## 5. Nginx 职责

现有 HTTPS 证书路径和 ACME challenge 路由保持不变。Nginx 配置增加：

- `/` 和 `/api/` 反向代理到 Kinvest
- 静态资源缓存策略
- API 和 HTML 禁止错误的长期缓存
- `client_max_body_size` 请求体限制
- `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、
  `Permissions-Policy` 和合理的 Content Security Policy
- API 与手动刷新接口限速
- 标准 `X-Forwarded-*` 请求头
- 上游连接和响应超时
- 访问日志轮换，避免日志持续无界增长

Nginx 配置必须先在临时容器或现有容器中执行 `nginx -t`。只有测试通过才
允许 reload，不直接停止线上 Nginx。

## 6. 备份、切换与回滚

首次切换前创建权限为 `700` 的时间戳备份目录，保存：

- 当前 Nginx 配置
- 当前 Compose 文件
- 当前小游戏 HTML 和静态资源
- 当前运行容器与镜像版本说明

备份不复制 `/root/docker/.env`、MySQL 数据、证书私钥或日志。

切换顺序：

1. 构建 Kinvest 镜像。
2. 启动 Kinvest 容器并在 Docker 网络内检查 `/api/health`。
3. 写入新的 Nginx 配置到临时文件。
4. 执行 `nginx -t`。
5. 原子替换 Nginx 配置并 reload。
6. 从公网检查 HTTPS、首页、公司页、研究页和 API。

若任一关键检查失败：

1. 恢复备份的 Nginx 配置。
2. 再次执行 `nginx -t`。
3. reload Nginx。
4. 停止 Kinvest 容器。
5. 验证旧小游戏恢复。

小游戏不直接永久删除；成功稳定运行后仍保留一份可恢复备份。

## 7. GitHub Actions

GitHub Actions 仅在以下条件满足时部署：

- 目标分支是 `main`
- 测试、lint、类型检查和构建全部通过
- 同一时间只有一个生产部署

工作流不使用 root 的个人 SSH 私钥。首次引导时创建：

- 无密码登录的 `kinvest-deploy` 用户
- 独立 ED25519 部署密钥
- root 所有、不可由部署用户修改的部署脚本
- 只允许执行该部署脚本的最小 sudoers 规则

GitHub Production Environment 保存：

- 部署私钥
- 固定的服务器 host key
- SSH 主机、端口和用户配置

这些值不得写入代码、日志、Docker 镜像或工作流输出。若仓库未来改为
私有，服务器使用单独的只读 GitHub deploy key 拉取代码，不使用 PAT。

服务器部署脚本执行：

1. 获取指定 Git commit。
2. 使用 fast-forward 或全新 release 目录，避免覆盖未知文件。
3. 构建并启动新容器。
4. 执行容器健康检查。
5. 切换 Nginx。
6. 执行公网 smoke test。
7. 记录不含凭据的 commit、时间和结果。
8. 失败时恢复上一个成功版本。

## 8. 安全边界

- 不在聊天、Git、GitHub Actions 日志、网页、SQLite 或 Docker 镜像中保存
  token、API key、refresh_token、密码或证书私钥。
- 不读取或改动服务器现有 `/root/docker/.env`。
- 不启动或暴露现有 MySQL 服务。
- 不开放 4173、3306 或其他新增公网端口。
- 不修改 Tailscale。
- root SSH 只用于首次部署用户和受控脚本引导。
- 现有 FirewallD 未运行且 RPC 111 正在监听；该问题记录为独立安全加固项，
  不在首次站点切换中贸然修改，避免远程锁死。

## 9. 首次部署验收

- `https://dearmina.cn` 和 `https://www.dearmina.cn` 返回 Kinvest。
- HTTP 自动跳转 HTTPS。
- 首页、搜索、公司详情和深度研究页面可访问。
- `/api/health` 返回成功并标记 `mock`。
- 默认公司页没有 AI 投资结论。
- 深度研究内容带有 AI/Mock 标识。
- 刷新时间、缓存、市场状态、冷却和额度说明可见。
- 4173 和 3306 不可从公网访问。
- Nginx 配置测试通过，证书仍有效。
- GitHub Actions 可部署一个无功能变化的提交。
- 回滚演练能恢复旧站点或上一 Kinvest 版本。

## 10. 后续范围

首次预览稳定后再分别实施：

- FirewallD、RPC 暴露和 SSH root 策略加固
- 阶段 2 完整 SQLite 仓储和缓存规则
- 公告 PDF 与 AI 研究快照
- iFinD、模型和腾讯云密钥服务接入
- 数据库备份、恢复演练和 PostgreSQL 迁移路径

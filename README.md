# Kinvest 家庭投资看板

Kinvest 是一个面向家庭成员的投资信息看板，强调来源可追溯、确定性规则可解释，并将 AI 观点限制在独立的深度研究页面。

## 在线预览

- 线上地址：[https://dearmina.cn](https://dearmina.cn)
- 当前状态：可运行的 Mock 前后端与 SQLite 数据层
- 数据说明：当前行情、财务、公告、资讯和深度研究均为演示数据，不代表真实市场数据或投资建议
- 阶段 5：真实 iFinD、模型服务和腾讯云密钥管理服务仍待外部配置

## 本地启动

```sh
cd /Users/zhuwenpeng/Developer/Kinvest
npm run dev
```

本地首页为 `http://localhost:4173/`，深度研究示例为
`http://localhost:4173/research.html?code=09888.HK`。

## 部署与运维

`main` 分支由 GitHub Actions 完成检查和镜像构建，再以不可变镜像摘要部署到 Production 环境。应用运行在 Docker 私有网络中，不发布主机应用端口；现有 Nginx 继续负责 HTTPS 和公网入口。

完整操作说明见 [生产运维手册](docs/operations/production-runbook.md)。

## 安全声明

- 不得将 token、API key、`refresh_token`、`.env` 或敏感日志提交到 Git。
- 凭据不得进入网页、数据库、Docker 镜像或普通应用日志。
- iFinD `refresh_token` 只允许管理员人工更新到腾讯云密钥管理服务，网站只提醒到期，绝不自动轮换。
- 当前所有页面数据均为 Mock；未验证的真实指标、财务细分和资讯来源不得伪装成生产数据。

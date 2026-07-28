# Kinvest 家庭投资看板

## 目标

Kinvest 是一个面向家庭成员的「来源可追溯、默认不含 AI 观点」的投资信息看板，当前阶段先交付前端骨架与模拟数据流程，后续逐步接入 iFinD、OpenAI 兼容模型和 SQLite/生产栈。

## 当前阶段状态

- 阶段 0（仓库准备 + 设计迁移）：完成
- 阶段 1（可运行前端骨架 + 模拟数据 + 页面预览）：进行中

## 快速启动（当前阶段）

```bash
cd /Users/zhuwenpeng/Developer/Kinvest
npm run dev
```

浏览器访问：

- 首页：`http://localhost:4173/`
- 深度研究页示例：`http://localhost:4173/research.html?code=09888.HK`

## 说明

- 本阶段不接入真实 iFinD / 模型接口，全部为演示数据。
- 所有凭据字段（refresh_token、API key、env 文件）都禁止进入仓库、数据库、日志与镜像。
- 代码和文档仍按后续阶段逐步替换为真实接口与持久化实现。

## 分阶段交付与安全约束

1. 阶段 0：仓库初始化、文档归档、计划与验收标准
2. 阶段 1：前端骨架与模拟数据（本阶段）
3. 阶段 2：服务端 + SQLite + 刷新/配额/缓存边界 + iFinD 适配器
4. 阶段 3：公告 PDF 与研究快照治理
5. 阶段 4：Nginx/Docker Compose + 部署与安全更新说明
6. 阶段 5：接入真实 iFinD、模型与腾讯轻量云部署


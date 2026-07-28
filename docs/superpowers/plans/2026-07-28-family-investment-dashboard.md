# 家庭投资看板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Kinvest 家庭投资看板前端可视化骨架与运行链路（默认数据页 + 刷新透明度 + 深度研究入口），并在阶段性完成后持续向真实 iFinD 与模型接口演进。

**Architecture:** 单体全栈优先（当前以 Node + 本地静态资源 + 本地模拟数据服务作为阶段性替代），将数据边界与展示层解耦，后续替换 iFinD / 模型服务不改界面结构。

**Tech Stack:** TypeScript/JavaScript（后续过渡到 TypeScript 全栈）、Node.js、纯静态前端、SQLite（阶段2-4 目标）、Docker Compose、Nginx（计划阶段4）、Axios/`fetch` 兼容接口。

---

### Task 1: 设计评审与迁移（阶段 0）

**Files:**
- Create: `docs/specs/2026-07-28-family-investment-dashboard-design.md`（由用户审核版迁移后增加实现批注）
- Create: `docs/superpowers/plans/2026-07-28-family-investment-dashboard.md`
- Modify: `/Users/zhuwenpeng/Developer/Kinvest`（仓库初始化）

- [ ] **Step 1: Complete critical review notes in plan file**

```markdown
审阅要点：
1. 三层信息边界（原始数据/确定性计算/AI 生成）必须默认展示分离。
2. 刷新透明度（市场时段、缓存状态、下次更新时间、失败回退）必须在首页与公司页明确。
3. 无模型凭据场景下也要可预览页面（使用 fixture/mocked 数据）。
4. 自动与手动刷新规则与额度要默认显示，不许隐藏或模糊处理。
5. 深度研究页与公司数据页严格不互相覆盖，只做版本与引用回链。
```

- [ ] **Step 2: Copy approved spec and append implementation-critical deltas**

Run:
`cp /Users/zhuwenpeng/Documents/Site_trying/docs/superpowers/specs/2026-07-28-family-investment-dashboard-design.md docs/specs/2026-07-28-family-investment-dashboard-design.md`

Expected:
文件包含 1-17 节原文与用户补充审阅章节（新闻边界、刷新透明度、令牌手册、Nginx、SQLite 起步、异常信号规则）。

---

### Task 2: 阶段 0 工程初始化（当前）

**Files:**
- Modify: `.gitignore`
- Add: `package.json`
- Add: `docs/superpowers/plans/2026-07-28-family-investment-dashboard.md`
- Add: `README.md`

- [ ] **Step 1: Initialize repository and remote**

```bash
cd /Users/zhuwenpeng/Developer/Kinvest
git init
git remote add origin https://github.com/zwphhxx/Kinvest.git
git branch -M main
```

Expected:
`git status` 显示无未跟踪意外文件，主干为 `main`，origin 已设置。

- [ ] **Step 2: Record baseline docs and README**

```bash
cat .gitignore
cat README.md
```

Expected:
`README` 包含阶段0/1状态、启动命令、敏感信息约束。

---

### Task 3: TDD 与刷新规则核心函数（阶段 1 前置）

**Files:**
- Add: `server/utils/refresh-policy.js`
- Add: `server/tests/refresh-policy.test.js`
- Add: `server/tests/run-tests.js`
- Add: `package.json`

- [ ] **Step 1: Add red test first (expected failure before implementation)**

```javascript
// server/tests/refresh-policy.test.js
const assert = require('assert')
const { buildRefreshState } = require('../utils/refresh-policy')

const now = new Date('2026-07-28T15:50:00.000Z')
const snapshot = {
  market: { isOpen: true, lastOpen: new Date('2026-07-28T09:30:00.000Z'), nextAutoRefreshAt: new Date('2026-07-28T15:50:00.000Z') },
  pricing: {
    sourceTime: new Date('2026-07-28T15:40:00.000Z'),
    lastManualRefreshAt: new Date('2026-07-28T15:43:00.000Z'),
    dailyManualCount: 2,
    dailyManualLimit: 100,
    fromCache: true,
  }
}
const state = buildRefreshState(snapshot, now)
assert.equal(state.marketState, 'trading')
assert.equal(state.canManualRefresh, false)
assert.equal(state.cooldownRemainingSeconds, 120)
assert.equal(state.refreshBadge, '交易中｜自动每10分钟刷新')
```

Run:
`npm test`

Expected:
测试因缺少实现代码而失败。

- [ ] **Step 2: Implement minimal `buildRefreshState` to pass test**

```javascript
function buildRefreshState(input, now = new Date()) {
  ...
}
```

Expected:
测试可以通过（`npm test` 输出通过）。

- [ ] **Step 3: Re-run tests with fresh evidence**

```bash
npm test
```

Expected:
`PASS` + 零错误。

---

### Task 4: 阶段 1 前端骨架（模拟数据）

**Files:**
- Add: `server/server.js`
- Add: `server/data/mockData.js`
- Add: `public/index.html`
- Add: `public/research.html`
- Add: `public/app.css`
- Add: `public/app.js`

- [ ] **Step 1: Implement mock data contract and API endpoints**

```
GET /api/watchlist
GET /api/search?q=xxx
GET /api/company/:code
POST /api/company/:code/refresh
GET /api/research/:code
```

Expected:
返回最小字段集（公司页三层标签、刷新状态、财务/公告/资讯、异常项）。

- [ ] **Step 2: Build responsive frontend skeleton in `public`**

- [ ] 首页：关注清单、搜索、公司卡片、市场更新时间条。
- [ ] 公司页：行情与估值、财务与细分、经营异常、公告、资讯、宏观入口、`生成深度研究` 按钮。
- [ ] 深度研究页：版本化快照、AI 输出区块（均标记 `AI生成`）。

Expected:
桌面与手机均可渲染，不出现 AI 投资结论在默认公司页。

- [ ] **Step 3: 启动本地预览**

Run:
`npm run dev`

Expected:
可访问 `http://localhost:4173/` 与 `http://localhost:4173/research.html?code=09888.HK`。

- [ ] **Step 4: Browser 可视化核验并记录截图说明**

Expected:
记录至少桌面+手机视图检查，截图路径写入本地执行记录（或在 issue 注明截图待补齐）。

---

### Task 5: 阶段 1 交付与提交

**Files:**
- Add: git commit + `.`

- [ ] **Step 1: Commit with sensitive-scan checklist**

Run:
`git diff --stat`

Ensure:
- 无 `.env`、token、refresh_token、api key。
- 无日志包含密钥字段。
- `docs/specs` 已存在且包含批注。

- [ ] **Step 2: Commit and push**

```bash
git add .
git commit -m "feat: launch Kinvest phase-0 and mock phase-1 dashboard"
git push -u origin main
```

Expected:
远端可见提交记录。

---

### 运行前自检（本计划覆盖）

- 每个关键行为至少一个自动化测试。
- 默认页不展示 `AI生成`。
- 深度研究页全部观点块带有 `AI生成` 标识。
- 刷新/缓存状态文字化展示并可手动重试。
- 单个页面在无真实凭据时可正常展示 mock。


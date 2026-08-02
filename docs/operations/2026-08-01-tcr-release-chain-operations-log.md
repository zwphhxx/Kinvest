# TCR 发布链根因分析与改造：操作全记录与现存问题

记录日期：2026-08-01
记录人：Claude Code 会话（在用户逐步授权下执行）
范围：Kinvest TCR 发布失败根因分析 → 实验 C → 发布链三次改造(PR #7~#10)

> 状态说明：本文中的 `c29a7e1` 及其 GHCR digest 是 PR #10 合并前的历史诊断基线，不是首次本地镜像试验的固定部署输入。首次试验必须等待 PR #10 合并，并使用该合并提交在 `main` 发布工作流中产生且经过核验的完整 commit SHA 与 GHCR digest。

---

## 一、操作时间线（全部操作）

### 1. 根因分析（严格只读）

| 操作 | 结果 |
|---|---|
| gh CLI 读取 run #21/#23 日志 | run #21 docker 直推 TCR 停滞 ~20 分钟；run #23 crane copy 3 次尝试各恰好 300s 被杀（exit 124,16:12:05/16:17:07/16:22:11 UTC) |
| ego-browser 登录腾讯云控制台（用户扫码，会话已过期一次） | 确认个人版实例（广州）;`website-dev/kinvest` 创建于 2026-07-31 20:43（首次 push 自动创建）;**kinvest 与 nginx 版本列表均为 0 条**——没有任何 tag/manifest 落地，停滞发生在 blob 数据面 |
| GHCR 制品结构分析 | OCI index:amd64 镜像（7 层 ~57.8MB)+ SLSA attestation(23KB) |
| 结论 | runner→GHCR 正常（10s 推送）;TCR 控制面正常（login、仓库自动创建）;停滞在 runner→TCR blob 上传数据面 |

### 2. 实验 C（用户批准后执行）

| 操作 | 结果 |
|---|---|
| 创建 PR #7（临时探针 workflow `tcr-probe.yml`)，用户合并 | main `12ab17a`；合并触发的 deploy.yml publish 按预期再次 3×124 失败（已提前告知） |
| dispatch 探针 run `30679488993`，用户批准 RegistryPublish | **成功**:3.65MB 用时 211s ≈ **17.6KB/s**;TCR `/v2/` 控制面 0.65s 正常；确认根因为跨境吞吐劣化，排除黑洞/兼容性/凭据/代码 |
| 日志泄漏复查 | JWT 模式 0 命中；sed/grep 脱敏生效 |
| 删除 TCR 临时仓库 `website-dev/rca-probe`（用户批准，ego-browser 控制台操作） | 已删除；列表剩 kinvest、nginx;kinvest 未受影响 |
| 浏览器任务空间 | 两个任务空间（tcr-rca-readonly、tcr-cleanup-rca-probe）均已关闭 |

### 3. 发布链改造 PR

| PR | 状态 | 内容 |
|---|---|---|
| PR #7 `feat/tcr-probe` | 已合并 | 临时探针（后续 PR #8 中删除） |
| PR #8 `feat/manual-release-flow`(main `f18176d`) | 已合并 | deploy.yml 仅 GHCR 自动发布；新增 mirror-tcr-manual.yml（单次 7800s copy）与 deploy-production-manual.yml；删除探针 |
| PR #9 `feat/release-chain-binding`(main `c29a7e1`) | 已合并 | mirror 签发 release-record.json;deploy 只消费 `mirror_run_id` + release record；补充修复：expired artifact 先过滤再索引、artifact 名称与 run attempt 强绑定（`44aab01`) |
| PR #10 `feat/local-mirror-verify` | **已创建未合并** | 镜像复制改走管理员 Mac 本地脚本 `scripts/mirror-release-to-tcr.sh`;GitHub 改为只读验证 `verify-tcr-release-manual.yml` 并签发 release record；移除 GitHub 端全部 blob 传输 |

### 4. 其他只读操作

- run #30（attempt 2）publish 查询：commit `c29a7e1b…` 的 GHCR digest 为 `sha256:dd48a12750ee50f6762768f59a27b7b5367020c04a20effb9e4af9f429fffa7f`（经 imagetools 双向验证）；区分了镜像 digest 与 SLSA 元数据中的基础镜像 digest(`c610fcdf…`)。
- 获取 crane v0.21.7 官方 checksums.txt（只读下载），用于本地脚本 Darwin 双架构固定校验。

### 5. 历次验证口径

每个 PR 均执行：`npm run check`（全绿）、`npm audit --audit-level=high`(0 漏洞）、`git diff --check`、敏感信息扫描（无真实凭据）；PR #10 增加 `bash -n`（本机无 shellcheck)。CI(verify/security/container-build）全部通过。

### 6. 未做的事（边界）

未合并任何 PR（均由用户合并）；未操作生产服务器（PR #4 脚本安装为此前单独授权）；未修改 Environment/Secrets/Variables;`DEPLOY_ENABLED` 始终为 false；未读取/打印任何凭据；未执行本地镜像脚本、未触发 verify/deploy。

---

## 二、现存问题（按优先级）

### P0 — 阻断生产发布

1. **TCR `website-dev/kinvest` 仍是 0 个 tag**。生产部署链路（PR #8/#9/#10）全部就绪，但 TCR 上没有任何可部署镜像。需要：合并 PR #10 → 等待该合并提交的 `main` 发布工作流成功 → 从工作流结果取得并双向核验完整 commit SHA 与 GHCR digest → 本地执行 `scripts/mirror-release-to-tcr.sh <merge_commit_sha> <verified_ghcr_digest>` → 手工触发 verify 签发 release record。不得继续把下表中的 `c29a7e1` 历史基线作为默认试验目标。
2. **跨境链路双向劣化未解决**。runner→TCR 上传 ~17.6KB/s（实验 C 实测）;run #31 证明 7800s 单次仍失败。PR #10 的本地 Mac 方案**尚未实际验证**（依赖管理员本地网络质量，若同样劣化需备用方案：广州 CVM 中继）。
3. **整条 release-record 链路从未端到端跑通**。verify-tcr-release-manual.yml、deploy-production-manual.yml 自创建以来零执行；首次实跑可能暴露 schema/provenance 校验的细节问题，应有预案。

### P1 — 平台与流程风险

4. **TCR 个人版正在灰度限速**（控制台公告：用户级上传/下载并发限制，后续将限制最大速度）。17.6KB/s 可能部分是平台侧限速而非纯跨境问题；个人版无 SLA，长期方案应评估企业版或其他分发渠道。
5. **run #31 失败的残留不可见**：个人版控制台不展示上传会话/dangling blobs，无法确认是否有半成品 blob 占用配额；依赖 TCR 后台 GC。
6. **`DEPLOY_ENABLED=false`，生产仍运行旧镜像**；开启前需先完成 P0，并对 deploy-production-manual.yml 做一次完整演练（含 verified rollback 路径）。

### P2 — 流程与工具遗留

7. **PR #3(device-approval-contract）长期暂停**，未复核未合并。
8. **ego-browser 使用教训**:`wait()` 与 `timeout` 单位是**秒**（曾误按毫秒传值导致两次挂起）；腾讯云控制台会话会过期，需用户重新扫码；`/tcr/mirror` 路径已失效，仓库管理在 `/tcr/repository`。
9. **探针期间 crane `--verbose` 曾输出完整 HTTP 头**(PR #7，已经 sed/grep 过滤 + JWT 扫描确认无泄漏）;PR #10 起 GitHub 侧不再有 verbose 与 blob 传输，风险面已消除。
10. **本地脚本未经实机验证**:`scripts/mirror-release-to-tcr.sh` 通过 `bash -n` 与契约测试，但未在 Mac 上真实执行过；watchdog/cleanup 行为建议首次执行时关注。

---

## 三、关键事实备查

| 项 | 值 |
|---|---|
| 历史诊断 commit（非首次试验默认输入） | `c29a7e1b28a73dcc2422314d4d3f761058f891f1` |
| 历史诊断 GHCR digest（非首次试验默认输入） | `sha256:dd48a12750ee50f6762768f59a27b7b5367020c04a20effb9e4af9f429fffa7f` |
| 历史诊断 GHCR tag | `ghcr.io/zwphhxx/kinvest:c29a7e1b28a73dcc2422314d4d3f761058f891f1` |
| 首次本地镜像试验输入 | PR #10 合并提交的完整 SHA，以及该提交在 `main` 发布工作流中产生并经双向核验的 GHCR digest |
| TCR 目标 | `ccr.ccs.tencentyun.com/website-dev/kinvest:<commit_sha>`（当前 0 tags) |
| 实测跨境吞吐 | ~17.6KB/s(3.65MB / 211s，实验 C,run `30679488993`) |
| 镜像大小 | ~57.8MB 压缩（最大单层 ~52.6MB),按实测速率需 ~55 分钟~2 小时 |
| crane | v0.21.7 固定；Linux x86_64 / Darwin arm64 / Darwin x86_64 三个 SHA-256 均已入库 |

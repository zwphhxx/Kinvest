# Kinvest deploy-v5 iFinD 管理员诊断运行手册

更新日期：2026-08-26

## 1. 状态、范围与禁止事项

H4 只交付 deploy-v5 的代码能力、文档和自动化测试，真实 iFinD 尚未启用。本文描述的安装、秘密录入、部署和真实调用都属于后续生产门，不得把文档完成、PR 合并或总体计划批准解释为生产授权。

本阶段只允许两级最小诊断：

- L1：应用启动时验证独立 tmpfs bundle 的存在、权限、固定文件集合、VersionId、manifest 和 token 格式。L1 是离线 bootstrap 检查，不调用 iFinD。
- L2：已登录管理员在受保护页面触发固定的认证和交易日最小查询。L2 不接受浏览器提供证券代码、指标、路由或请求体。

真实结果只进入管理员诊断页面。家庭页面仍为 Mock；家庭展示真实 iFinD 数据必须经过独立授权门，任何区块禁止混合 real 与 Mock 字段。

唯一允许的 iFinD Production Secret 名称是：

```text
KINVEST_IFIND_REFRESH_TOKEN
```

与 [deploy-production-v5-manual.yml](../../.github/workflows/deploy-production-v5-manual.yml) 一致的 Production Variables 是：

```text
DEPLOY_V5_ENABLED
KINVEST_IFIND_DIAGNOSTIC_MODE
TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID
```

`KINVEST_IFIND_DIAGNOSTIC_MODE` 的部署值只允许 `disabled` 或 `diagnostic`；`diagnostic` 在容器内映射为应用的 `admin-diagnostic` 模式。VersionId 使用 `vYYYYMMDD-NNN`，它是非秘密元数据。

绝不在聊天、仓库、Issue、PR、普通文件、`.env`、终端历史、命令参数、截图或日志中粘贴 refresh token。不得以长期腾讯云 `SecretId`/`SecretKey`、CAM/SSM、Docker 环境变量或持久磁盘文件作为替代路线。

## 2. 权限和暂停矩阵

| 操作 | Agent 可直接完成 | 必须由用户明确批准或本人执行 |
|---|---:|---:|
| 代码、测试、文档、功能分支、PR、只读状态检查 | 是 | 否 |
| 合并 PR | 否 | 用户本人手工合并 |
| 安装 deploy-v5 服务器资产 | 否 | 用户单独批准 |
| 离线下载、上传、证明并导入精确镜像 | 否 | 用户单独批准 |
| 创建或更新 `KINVEST_IFIND_REFRESH_TOKEN` | 否 | 用户在 GitHub `Production` Environment 本人录入 |
| 修改 VersionId 或诊断模式 Variables | 否 | 用户本人操作 |
| Production deployment | 否 | 用户点击 `Approve and deploy` |
| 首次真实 L2 调用 | 否 | 用户再次明确批准 |
| Docker 或 CVM 重启 | 否 | 每次分别批准 |

任何批准只覆盖该行描述的动作，不自动授权下一生产门。

## 3. deploy-v5 安全模型

deploy-v5 通过加密 SSH stdin 接收 Production 获批后的秘密材料。forced command 只接受字面量 `deploy-v5`；token 不得进入 SSH 命令、进程参数、环境输出或状态文件。

部署程序在 `/run` 下建立独立 iFinD tmpfs bundle，和家庭登录的 access bundle 分开。Compose 只接收模式、VersionId 和只读 bundle 路径，不接收 token。候选容器在数据库备份或 Compose 切换前执行离线预检；预检失败必须清理候选 bundle，并保持当前容器和部署状态不变。

联合状态记录 deploy-v5 provenance 和非秘密元数据，包括：

- 精确镜像 digest、运行时 Image ID、commit 和 release verification run；
- schema 范围和数据库备份引用；
- `ifindDiagnosticMode`、VersionId、bundle ID；
- secret fingerprint，也就是 token 的 SHA-256 指纹。

状态只保存 fingerprint，不保存 secret。相同 VersionId 对应不同 fingerprint 时必须失败关闭。状态文件继续保持 `root:root 0600`。

`deploy-v4` 协议、现有 access-control bundle 和已上线家庭登录行为保持不变。deploy-v5 只能由新工作流和新 forced-command 分支调用；v5 未通过生产验收时回退到 v4 已验证边界，而不是向 v4 注入 iFinD 字段。

## 4. Disabled 基线

Disabled 基线的目标是先证明新镜像和 deploy-v5 资产不改变现有生产行为：

1. 确认 H4 PR 已合并且三个 PR 检查全绿。
2. 记录目标 `<MAIN_COMMIT>`、`<IMMUTABLE_DIGEST>`、release run/attempt 和现有 `current.state` 非秘密摘要。
3. 用户单独批准安装服务器资产。安装源包括 `deploy/server/install-deploy-v5.sh`、资产哈希清单、forced-command、sudoers、contract、executor 和 Compose 文件。
4. 安装过程只发布资产，不重建容器、不迁移数据库、不改变模式。
5. 用户单独批准离线精确镜像流程。只接受与 release provenance 绑定的 `<IMMUTABLE_DIGEST>` 和 `<RUNTIME_IMAGE_ID>`；不得用可变 tag 代替。
6. 用户设置 `KINVEST_IFIND_DIAGNOSTIC_MODE=disabled`，保持 `TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID` 为空，并短暂设置 `DEPLOY_V5_ENABLED=true`。
7. 用户触发 `Deploy production v5 (manual)`，选择 `FORWARD`、`disabled`，输入已验证的非秘密 release run 元数据，再批准 Production deployment。
8. 验证家庭登录、设备审批、Mock 页面、SQLite、Nginx、HTTPS、J3 timer 和元数据 deny-all 均无回归。
9. 用户将 `DEPLOY_V5_ENABLED` 恢复为 `false`。

Disabled job 的定义不得引用 `KINVEST_IFIND_REFRESH_TOKEN`，也不得建立或挂载 iFinD bundle。

## 5. Diagnostic 激活

### 5.1 录入门

用户直接在 GitHub 仓库的 `Production` Environment 中创建或更新 `KINVEST_IFIND_REFRESH_TOKEN`。Agent 只确认 Secret 名称存在，不读取值。用户为本次材料选择未复用的 `TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID=<VERSION_ID>`，并设置 `KINVEST_IFIND_DIAGNOSTIC_MODE=diagnostic`。

Secret 录入、VersionId 修改和真实调用是三个不同的暂停点。不要在 Secret 刚录入后自动触发部署或查询。

### 5.2 L1 bootstrap、权限与格式

用户单独批准 diagnostic Production deployment 后，deploy-v5：

1. 在 Production 审批后重新验证 main commit 和 release provenance。
2. 通过加密 stdin 接收 token，只在 `/run` tmpfs 创建候选 iFinD bundle。
3. 验证 bundle 实际位于 tmpfs，目录和文件 owner/mode 正确，无符号链接、硬链接、额外文件或 manifest 漂移。
4. 使用非 root、只读根文件系统、`--cap-drop ALL`、`--network none` 的候选容器运行 L1 预检。
5. L1 成功后才允许备份数据库和切换 Compose；失败则不改变生产。

验收只记录稳定结果码、VersionId、fingerprint、bundle ID、镜像身份和时间，不记录 token。

### 5.3 L2 管理员受保护最小查询

L1 完成后仍需用户明确批准首次真实调用。管理员通过家庭登录保护的独立管理员页面运行两级诊断：先交换内存 access token，再执行固定交易日最小查询。

L2 必须确认：

- 匿名、仅家庭设备、过期管理员和跨来源请求均无法触发；
- 浏览器不能修改 URL、路由、代码、指标、日期范围或请求体；
- 认证与最小查询状态分开显示；
- 仅保留安全错误分类、请求数、耗时和 `dataVol`；
- 官方剩余额度继续显示为 unavailable，不把本站计数冒充官方额度；
- refresh token、access token、请求头、原始响应、RequestId 和供应商错误正文不进入 API、数据库、审计或日志。

## 6. 健康检查和敏感日志扫描

每次基线、激活、回滚或 RESTORE 后都检查：

```text
Public health: https://dearmina.cn/api/health
Public site:   https://dearmina.cn/
Expected mode: device-approval with family investment data still Mock
Expected image: <IMMUTABLE_DIGEST> / <RUNTIME_IMAGE_ID>
Expected state: <VERSION_ID> and fingerprint only; no secret material
```

还要确认 Nginx、HTTPS、安全响应头、桌面/手机登录流程、SQLite `quick_check`、timer、deny-all 和管理员诊断授权边界。日志扫描范围包括 GitHub run、SSH/deployer 稳定输出、应用、Nginx、Docker inspect、审计表和部署状态；只保存“匹配数为零”等非秘密结论，不保存疑似秘密片段。

## 7. ROLLBACK、RESTORE 与重启

### ROLLBACK

`ROLLBACK` 只选择 `previous.state` 中精确、兼容的旧镜像和 provenance，但使用当前获批的 GitHub token 材料重新预检。它不恢复已撤销 token。旧镜像不支持 iFinD tmpfs provider 或 schema 不兼容时必须停在人工恢复门，不得只切镜像后宣称回滚完成。

### RESTORE

`RESTORE` 只允许重建 `current.state` 对应的 access bundle 和 iFinD bundle，并恢复当前精确 Image ID。它不拉镜像、不迁移数据库，也不改变 digest、commit、schema、release provenance 或 VersionId。

### Docker 与 CVM 重启

Docker 重启不应删除主机 `/run` 中仍被引用的 bundle，但仍需单独批准并复验容器、挂载和权限。CVM 重启后 tmpfs 消失，应用必须 fail closed（失败关闭），不得无秘密启动或退回 Mock provider。此时需要用户启用部署门、触发获批 `RESTORE`、批准 Production deployment，重建 bundle 后再恢复当前精确镜像。

重启测试不得和 token 轮换、镜像前向发布或数据库维护合并执行。

## 8. Token 轮换

1. 管理员人工登录 iFinD 官方页面取得新 refresh token。
2. 用户在 GitHub `Production` Environment 更新 `KINVEST_IFIND_REFRESH_TOKEN`，不经过聊天、命令参数或文件。
3. 用户选择新的 `<VERSION_ID>`；禁止用旧 VersionId 覆盖为不同材料。
4. 用户批准 diagnostic `FORWARD` 或符合状态边界的 `RESTORE`，完成 L1。
5. 用户另行批准一次 L2 最小查询。
6. 成功后只归档旧 VersionId、fingerprint、部署 run 和验收结果等非秘密元数据。
7. 清空本地剪贴板并退出显示 token 的 iFinD 页面。

轮换失败时保持或恢复当前已验证部署状态；不要把旧 token 写入持久文件作为兼容副本。

## 9. 紧急 disable 和回退路线

怀疑 token 泄露、供应商行为异常或权限边界失效时：

1. 停止新的诊断调用并记录非秘密事件时间。
2. 用户将 `KINVEST_IFIND_DIAGNOSTIC_MODE` 设为 `disabled`，短暂启用 `DEPLOY_V5_ENABLED`。
3. 用户触发并批准 disabled `FORWARD`，使 iFinD bundle 不再挂载；完成健康和日志扫描后恢复部署门为 `false`。
4. 用户在 iFinD/GitHub 管理界面撤销或替换 token；不得在服务器保存备份 token。
5. 如 deploy-v5 无法安全执行，保持现有 v4 家庭访问控制边界，不引入长期 SecretId/Key、SSM/CAM、`.env`、命令参数或聊天传密来绕过阻塞。

## 10. 归档与清理

验收完成后保留：PR、commit、release run/attempt、精确 digest、运行时 Image ID、状态 schema、VersionId、fingerprint、健康结果和零匹配日志扫描摘要。它们都是非秘密元数据。

经单独批准可清理 Mac、普通用户和 root 暂存区中的离线 tar 归档；只删除归档，不删除正在运行或回滚需要的 Docker 镜像、release attestation、数据库备份、`current.state`、`previous.state` 或被状态引用的 bundle。清理前后均不得打印归档内容。

H4 完成条件只是代码、测试、审查和 PR 合并。H5 以后每个服务器安装、离线导入、Production deployment、真实 token 录入和真实 iFinD 调用仍分别等待用户明确批准。

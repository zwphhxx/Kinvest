# Kinvest 生产运维手册

更新日期：2026-07-29

## 1. 适用范围与当前状态

- 线上地址：[https://dearmina.cn](https://dearmina.cn)
- 当前运行内容：Kinvest Mock 前后端、SQLite 数据层和安全 Mock 研究状态
- 当前不包含：真实 iFinD 数据、真实模型调用、腾讯云密钥管理服务运行时读取
- 阶段 5 才接入真实 iFinD、模型服务和腾讯云密钥管理服务；在外部配置完成前，不得把 fixture 或 Mock 标记成真实数据

本文只记录操作名称、文件位置和检查方法，不记录任何密钥值。运维人员也不得把密钥粘贴到聊天、工单、终端历史或截图中。

## 2. 生产架构

```text
浏览器
  |
  | HTTPS
  v
现有 Nginx 容器
  |
  | external Docker network: web
  v
Kinvest 应用容器
  |
  v
SQLite 持久化目录
```

- Kinvest 是 Docker 应用容器，与现有 Nginx 通过 external `web` 网络通信。
- 应用不发布主机端口；公网只保留现有 Nginx 的 HTTP/HTTPS 入口。
- Nginx 继续使用现有证书和宿主机端口，不由 Kinvest 重建另一套入口。
- SQLite 起步并通过应用数据访问层隔离，后续可迁移 PostgreSQL。
- 当前后台任务保持单实例；未来多用户再拆分 worker、队列和 Redis，并增加家庭登录、RBAC、审计和横向扩容。

关键服务器路径：

| 用途 | 路径 |
|---|---|
| Kinvest Compose、状态和数据 | `/root/docker/kinvest` |
| Nginx 主配置 | `/root/docker/nginx/conf/nginx.conf` |
| Nginx Kinvest Compose 覆盖 | `/root/docker/docker-compose.kinvest-nginx.yml` |
| root 管理的部署程序 | `/usr/local/sbin/deploy-kinvest` |
| 上线前旧站备份 | `/root/docker/backups/kinvest-pre-cutover-20260729T082131Z` |

首次切换时未修改 Tailscale、防火墙和现有数据库。后续维护也不得把这些系统当作 Kinvest 发布的一部分顺带修改；如需调整，应另开变更并单独备份、评审和验证。

## 3. GitHub 发布与部署流程

发布流程为"GHCR 自动发布 + TCR 手工镜像 + Production 手工部署"三段式：

1. `main` 分支 push 后，`deploy.yml` 自动执行 verify / security / container-build，
   将镜像发布到 GHCR `ghcr.io/zwphhxx/kinvest:<commit>`，并验证 GHCR 报告的
   immutable digest 与构建输出一致。自动流程不触碰 TCR、不进入 Production，
   也不需要任何 Environment 审批。
2. 需要部署时，管理员手工触发 `mirror-tcr-manual.yml`（workflow_dispatch），
   输入 `commit_sha`、`ghcr_digest`、`confirm=MIRROR`。workflow 分两个阶段：
   `validate`（无 Environment）先校验输入格式、commit 属于 main 历史、
   `ghcr_digest` 与 GHCR 上该 commit 标签的实际 digest 一致；通过后 `mirror`
   （RegistryPublish Environment）以单次有界尝试（7800 秒）将精确 digest 从
   GHCR 复制到 `ccr.ccs.tencentyun.com/website-dev/kinvest:<commit_sha>`。
   复制期间日志只有固定心跳，crane 输出只写入临时文件并即时清理，永不打印。
   成功后查询 TCR 实际 digest（必须与 GHCR digest 一致），生成
   `release-record.json`（schema_version、commit_sha、ghcr_digest、tcr_digest、
   tcr_repository、mirror_run_id、mirror_run_attempt；不含任何凭据）并以
   `kinvest-release-record-<run_id>` artifact 保留 30 天。
   背景：实测 GitHub runner → TCR（广州）上传吞吐约 17.6KB/s，57.8MB 镜像
   需要约 1~2 小时；crane 不支持断点续传，多次短超时重试等于每次从零重传，
   因此采用单次超长尝试，由人工选择链路状况合适的时机触发（全程需要
   RegistryPublish Environment 审批）。
3. 镜像完成后，管理员手工触发 `deploy-production-manual.yml`
   （workflow_dispatch），只需输入成功 mirror run 的 `mirror_run_id` 和
   `confirm=DEPLOY`，不再人工输入 commit 或 digest。`validate`（无
   Environment）校验 mirror run 的来源（本仓库、mirror-tcr-manual.yml、
   workflow_dispatch、main 分支、success）、下载并校验唯一 release record
   artifact（schema、仓库地址固定、digest 格式、tcr_digest 等于 ghcr_digest、
   commit 属于 main 历史），且 `DEPLOY_ENABLED` 必须为 `true`；全部通过后
   `deploy`（Production Environment + 人工审批）才通过受限 SSH 将精确 TCR
   digest 传给服务器部署入口。
4. 服务器行为不变：从 TCR 拉取指定摘要，启动候选容器并等待健康检查；
   候选失败时保留或恢复最近一个本地、健康的镜像，不把失败候选切到线上。

部署开关和配置只使用以下名称：

| 类型 | 名称 |
|---|---|
| Repository variable | `DEPLOY_ENABLED` |
| Production variable | `DEPLOY_HOST` |
| Production variable | `DEPLOY_PORT` |
| Production variable | `DEPLOY_USER` |
| Production secret | `DEPLOY_SSH_KEY` |
| Production secret | `DEPLOY_KNOWN_HOSTS` |
| RegistryPublish secret | `TCR_USERNAME` |
| RegistryPublish secret | `TCR_PASSWORD` |

本手册不记录这些配置的值。`DEPLOY_ENABLED` 关闭时仍可执行构建、检查和 GHCR
发布，但手工部署任务会拒绝执行。`TCR_USERNAME` 和 `TCR_PASSWORD` 只允许被
`RegistryPublish` Environment 中的 mirror 任务读取；自动流程与 PR 事件都无法
访问这两个 secret。

### 发布检查

在 GitHub 仓库的 Actions 页面确认：

- `verify` 和 GHCR 发布任务成功，并记录 publish 输出的 GHCR digest。
- 手工 mirror 任务的 `ghcr_digest` 输入与 publish 输出一致；mirror 成功后
  记录其 run ID 与输出的 TCR digest（与 release record 内容一致）。
- 手工 Production 部署任务的 `mirror_run_id` 输入就是上述成功的 mirror run；
  validate 任务输出的 commit/digest 与 release record 一致。
- 日志只显示 commit、镜像摘要和健康状态，不显示 secret 内容。
- 失败日志中的错误已经脱敏。

在服务器确认：

```sh
docker inspect --format '{{.Config.Image}}' kinvest
docker inspect --format '{{.State.Health.Status}}' kinvest
cat /root/docker/kinvest/state/current.state
```

`current.state` 只应包含部署 commit、不可变镜像摘要等非敏感元数据。若它出现任何凭据，应立即停止发布、限制文件访问并按安全事件处理。

## 4. 日常健康与状态检查

### 公网健康

```sh
curl -fsS https://dearmina.cn/api/health
curl -fsSI https://dearmina.cn/
```

预期结果：

- 健康接口成功并明确报告当前 Mock/ready 状态。
- 首页返回 HTTPS 成功状态。
- HTTP 会跳转到 HTTPS。
- 响应包含生产安全头。

### 容器与私有网络

```sh
docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' kinvest
docker inspect --format '{{.State.Status}}' nginx
docker network inspect web
```

预期 `kinvest` 为 `running healthy`，`nginx` 为 `running`，且两者都连接到 `web`。Kinvest 不应出现主机端口映射。

### Nginx 配置

```sh
docker exec nginx nginx -t
```

只有语法检查成功后才允许重载：

```sh
docker exec nginx nginx -s reload
```

不要先重载再检查，也不要为 Kinvest 创建第二个公网 Nginx。

## 5. Nginx 职责

生产入口的 Nginx 负责：

- HTTPS 终止及 HTTP 到 HTTPS 跳转。
- 将应用和 API 请求反向代理到 `web` 网络内的 Kinvest 容器。
- 对可安全缓存的静态资源设置缓存策略，不缓存个性化或健康状态响应。
- 限制请求体大小，降低异常上传和资源耗尽风险。
- 统一添加内容安全策略、禁止嗅探、点击劫持防护、Referrer Policy 等安全响应头。
- 对 API 和高成本入口实施基础单 IP 限速。

应用层仍负责业务限速、手动刷新冷却、每日额度、参数允许列表和鉴权。Nginx 限速不能替代业务规则。

修改 `/root/docker/nginx/conf/nginx.conf` 时：

1. 先把当前文件复制到 root-only 的时间戳备份目录。
2. 用临时文件写入候选配置，不原地截断生产文件。
3. 执行 `docker exec nginx nginx -t`。
4. 检查成功后再原子替换并 reload。
5. 立即检查公网首页、健康接口和安全响应头。
6. 任一检查失败，恢复刚才的配置备份，再次执行 `nginx -t` 后 reload。

## 6. SQLite 权限、备份与恢复

### 权限基线

- 应用容器身份：UID/GID `10001:10001`
- 持久化目录：属主 `10001:10001`，目录模式 `0750`
- SQLite 主文件：模式 `0600`
- SQLite `-wal` 和 `-shm` 文件存在时：模式 `0600`

检查：

```sh
stat -c '%u:%g %a %n' /root/docker/kinvest/data
find /root/docker/kinvest/data -maxdepth 1 -type f -printf '%u:%g %m %p\n'
```

发现属主或权限偏离时，不要在容器运行中直接递归修改。把以下内容保存为 root-only 临时脚本并执行；脚本使用失败即停和退出清理，保证迁移失败时也会尝试恢复当前容器：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

wait_healthy() {
  for attempt in $(seq 1 30); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' kinvest 2>/dev/null || true)" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

stopped=0
cleanup() {
  rc=$?
  if (( stopped )); then
    docker start kinvest >/dev/null || rc=1
    wait_healthy || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT

docker stop kinvest
stopped=1
/root/docker/kinvest/migrate-data-uid.sh
docker start kinvest
wait_healthy
stopped=0
trap - EXIT
```

迁移后重新检查目录、主数据库、`-wal` 和 `-shm`。不得把 UID 改成服务器已有普通用户，也不得把目录或数据库放宽到 group/world 可写。

### 一致性备份

SQLite 文件备份必须在应用停止写入时进行。把以下内容保存为 root-only 临时脚本并执行；它不读取任何 secret，且备份失败时会尝试恢复当前容器：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/root/docker/backups/kinvest-data-$stamp"
work="$backup.incomplete"
test ! -e "$backup"
test ! -e "$work"
install -d -o root -g root -m 700 "$work"

wait_healthy() {
  for attempt in $(seq 1 30); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' kinvest 2>/dev/null || true)" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

stopped=0
cleanup() {
  rc=$?
  if (( stopped )); then
    docker start kinvest >/dev/null || rc=1
    wait_healthy || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT

docker stop kinvest
stopped=1
tar --numeric-owner -C /root/docker/kinvest -czf "$work/data.tar.gz" data
chmod 600 "$work/data.tar.gz"
gzip -t "$work/data.tar.gz"
sha256sum "$work/data.tar.gz" > "$work/data.tar.gz.sha256"
chmod 600 "$work/data.tar.gz.sha256"
docker start kinvest
wait_healthy
stopped=0
install -o root -g root -m 600 /dev/null "$work/COMPLETE"
mv -T "$work" "$backup"
trap - EXIT
```

只有容器重新达到 `healthy` 后，备份操作才算完成。备份目录不得包含 `.env`、token、应用日志或无关数据库。

该备份仍与生产数据位于同一台服务器，只能处理误操作，不能覆盖整机或磁盘故障。阶段 5 前应增加加密异地备份、独立校验和、保留周期和定期恢复演练；异地包同样不得包含 `.env`、token、现有 MySQL 或敏感日志。

### 恢复 SQLite

恢复前应先记录当前镜像摘要和 commit，并再做一次当前数据冷备份。恢复必须使用唯一时间戳目录，不能复用 `data.before-restore`，也不能直接向当前 `data` 解压。

以下是 root 管理脚本模板。先把 `REVIEWED-BACKUP` 替换为人工核验过的备份目录名称；若服务器没有批准的 `sqlite3` 完整性检查工具，应停止操作，不得跳过完整性检查：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

root=/root/docker/kinvest
backup_name=REVIEWED-BACKUP
[[ "$backup_name" =~ ^kinvest-data-[0-9]{8}T[0-9]{6}Z$ ]]
backup_dir=$(realpath -e -- "/root/docker/backups/$backup_name")
[[ "$backup_dir" == "/root/docker/backups/$backup_name" ]]
archive=$(realpath -e -- "$backup_dir/data.tar.gz")
[[ "$archive" == "$backup_dir/data.tar.gz" ]]

for protected_path in /root/docker/backups "$backup_dir" "$archive"; do
  test "$(stat -c '%U:%G' "$protected_path")" = 'root:root'
  mode=$(stat -c '%a' "$protected_path")
  (( (8#$mode & 0022) == 0 ))
done
test -f "$backup_dir/COMPLETE"
test -f "$backup_dir/data.tar.gz.sha256"
(cd "$backup_dir" && sha256sum -c data.tar.gz.sha256)

stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage="$root/restore-stage-$stamp"
candidate="$stage/data"
previous="$root/data.before-restore-$stamp"
failed="$root/data.failed-restore-$stamp"

test -f "$archive"
test ! -e "$stage"
test ! -e "$previous"
test ! -e "$failed"
gzip -t "$archive"
tar -tzf "$archive" | awk '
  $0 !~ /^data(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ { bad=1 }
  END { exit bad ? 1 : 0 }
'
tar -tvzf "$archive" | awk '
  substr($1, 1, 1) != "d" && substr($1, 1, 1) != "-" { bad=1 }
  END { exit bad ? 1 : 0 }
'

install -d -o root -g root -m 700 "$stage"
tar --no-same-owner --no-same-permissions -C "$stage" -xzf "$archive"
test -d "$candidate"
test -f "$candidate/kinvest.sqlite"
test ! -L "$candidate/kinvest.sqlite"
test "$(stat -c '%h' "$candidate/kinvest.sqlite")" = '1'
chown -R 10001:10001 "$candidate"
find "$candidate" -type d -exec chmod 750 {} \;
find "$candidate" -type f -exec chmod 600 {} \;
test "$(stat -c '%u:%g:%a' "$candidate")" = '10001:10001:750'
test "$(stat -c '%u:%g:%a' "$candidate/kinvest.sqlite")" = '10001:10001:600'
command -v sqlite3 >/dev/null
test "$(sqlite3 "$candidate/kinvest.sqlite" 'PRAGMA quick_check;')" = 'ok'

wait_healthy() {
  for attempt in $(seq 1 30); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' kinvest 2>/dev/null || true)" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

current_moved=0
candidate_active=0
rollback_restore() {
  trap - ERR INT TERM
  set +e
  rollback_failed=0
  docker stop kinvest >/dev/null 2>&1 || rollback_failed=1
  if (( candidate_active )) && [[ -d "$root/data" ]]; then
    mv -T "$root/data" "$failed" || rollback_failed=1
  fi
  if (( current_moved )) && [[ -d "$previous" ]]; then
    if [[ -e "$root/data" ]]; then
      rollback_failed=1
    else
      mv -T "$previous" "$root/data" || rollback_failed=1
    fi
  fi
  if [[ -d "$root/data" ]]; then
    docker start kinvest >/dev/null || rollback_failed=1
    wait_healthy || rollback_failed=1
  else
    rollback_failed=1
  fi
  if (( rollback_failed )); then
    printf '%s\n' '自动恢复旧数据失败：保持停机或当前状态，立即人工处置。' >&2
  else
    printf '%s\n' '候选恢复失败，旧数据与健康容器已恢复。' >&2
  fi
  exit 1
}
trap rollback_restore ERR INT TERM

docker stop kinvest
mv -T "$root/data" "$previous"
current_moved=1
mv -T "$candidate" "$root/data"
candidate_active=1
docker start kinvest

wait_healthy
curl -fsS https://dearmina.cn/api/health >/dev/null
trap - ERR INT TERM
```

恢复成功后保留 `data.before-restore-<timestamp>` 和空的暂存父目录，直到业务数据、权限和 schema 版本均已确认。失败候选若存在，会保留为 `data.failed-restore-<timestamp>` 供离线调查；不要在恢复脚本中自动删除旧数据或失败候选。

## 7. 应用回滚

部署程序维护：

- `/root/docker/kinvest/state/current.state`
- `/root/docker/kinvest/state/previous.state`

回滚只使用 `previous.state` 已记录且服务器本地存在的 immutable digest。不要使用 `latest`，不要在故障期间临时改 Dockerfile，也不要把未经验证的镜像载入生产。

回滚步骤：

1. 读取 `current.state` 与 `previous.state`，记录当前和目标 commit/digest。
2. 用 `docker image inspect` 确认目标 digest 已在本地。
3. 查阅目标发布的 schema 兼容声明，并用批准的只读查询记录当前 SQLite schema 版本。
4. 只有目标旧镜像明确兼容当前 schema 时，才允许仅回滚应用镜像。
5. 若 schema 不兼容，停止镜像回滚：使用与目标发布匹配且已验证的数据备份执行第 6 节恢复，或实施经过评审的前向修复。
6. 确认当前 SQLite 冷备份可用。
7. 以 `previous.state` 中的 digest 和 40 位 commit 调用 `/usr/local/sbin/deploy-kinvest`。
8. 等待容器 `healthy`，再检查公网健康和首页。
9. 记录回滚原因、目标 commit、schema 版本、时间和验证结果，但不记录凭据。

示意命令中的值必须来自已经审核的 `previous.state`：

```sh
/usr/local/sbin/deploy-kinvest 'ghcr.io/zwphhxx/kinvest@sha256:REVIEWED_DIGEST' 'REVIEWED_40_CHAR_COMMIT'
docker inspect --format '{{.State.Health.Status}} {{.Config.Image}}' kinvest
curl -fsS https://dearmina.cn/api/health
```

不得照抄占位符执行。旧镜像曾经健康不代表它能读取已经迁移的当前数据库。若缺少 schema 兼容声明、`previous.state` 缺失、镜像不在本地或前一版本不健康，应停止自动处理，保留当前服务并人工评估。

应用回滚与数据库恢复是两个独立变更：前者切换镜像，后者替换持久化数据。未来数据库迁移应优先采用向后兼容的展开/收缩方式；任何不兼容迁移必须随发布提供 schema 版本、匹配备份和经过演练的恢复步骤。

## 8. 旧站备份与入口恢复

首次切换前备份位于：

```text
/root/docker/backups/kinvest-pre-cutover-20260729T082131Z
```

该备份用于恢复旧站 Nginx 配置和静态内容，不用于覆盖现有数据库、Tailscale 或防火墙。

恢复前：

1. 确认备份目录和文件属 root 且不可被普通用户写入。
2. 记录当前 Nginx 配置并复制到新的时间戳目录。
3. 人工核对备份内的 Nginx 配置、Compose 文件和静态文件清单。
4. 不复制备份之外的 `.env`、证书私钥、日志或数据库。

入口恢复采用候选文件、语法检查、原子替换：

```sh
backup=/root/docker/backups/kinvest-pre-cutover-20260729T082131Z
install -o root -g root -m 600 "$backup/nginx.conf" /root/docker/nginx/conf/nginx.conf.restore
docker cp /root/docker/nginx/conf/nginx.conf.restore nginx:/tmp/nginx.conf.restore
docker exec nginx nginx -t -c /tmp/nginx.conf.restore
```

只有确认备份内路径和候选语法都正确后，才替换
`/root/docker/nginx/conf/nginx.conf` 并 reload。恢复后分别检查 HTTP 跳转、HTTPS 页面和 Nginx 状态。若备份中的实际文件名与示例不同，停止并按备份清单操作，不猜测路径。

## 9. 镜像仓库与拉取（TCR 主用，GHCR 备份）

生产部署只从腾讯云 TCR 个人版 `ccr.ccs.tencentyun.com/website-dev/kinvest`
拉取（与服务器同区域，避开 GHCR 跨境链路）。GHCR 继续作为备份仓库发布，
但不接受为新的部署输入；`deploy-kinvest.sh` 与 SSH 入口只接受精确的 TCR
immutable digest，拒绝其他仓库、tag 和可变引用。

拉取安全行为：

- 拉取由 `deploy-kinvest.sh` 执行有界重试：最多 3 次尝试，每次由 `timeout` 限制在 300 秒内，两次尝试之间递增等待（2 秒、4 秒）；任一次成功立即停止。
- 只重试明确的临时失败或超时（退出码 124/137/143，或 stderr 中出现连接重置、超时、5xx 等临时特征）；摘要不存在、权限拒绝和未分类错误不重试。
- 部署日志只记录尝试编号、退出码和最终结果；拉取的原始 stderr 只用于本地失败分类，不写入部署日志。
- 全部尝试失败后执行既有 verified rollback：不替换 `current.state`，不停止当前健康容器，previous 继续服务。
- 重试不是无限兜底：链路持续劣化时部署仍会失败，此时应等待链路恢复后重新部署同一 digest。
- TCR 侧的镜像补给由手工 `mirror-tcr-manual.yml` 执行（单次有界 7800 秒
  crane copy，详见第 3 节）；GitHub runner → TCR 跨境上传吞吐实测约
  17.6KB/s，镜像补给是小时级操作，应安排在低峰时间窗口并预留充足时间。
- 回滚只依赖服务器本地已经存在且曾健康运行的镜像。
- 超时不等于镜像不存在或鉴权失败，应区分网络超时、摘要不存在和权限拒绝。
- 不切换到未经审核的公共镜像代理，也不因超时关闭 TLS 或主机校验。

仓库迁移与回滚边界：

- `current.state` 与 `previous.state` 可同时存在 GHCR 和 TCR 两种仓库引用；
  首次 TCR 部署时 `current.state` 通常仍是 GHCR 地址，这是受支持的迁移路径。
- TCR 候选失败时，verified rollback 可回滚到本地已有的 GHCR previous 镜像；
  回滚只使用本地镜像，不从 GHCR 重新拉取。
- TCR 部署成功后，`current.state` 写入 TCR digest，`previous.state` 保留
  GHCR 记录，直到下一次成功部署将其替换为 TCR。

TCR 个人版限制：

- 个人版无 SLA，可用性与性能不作承诺；发布或部署失败时按既有重试与回滚
  语义处理，不得为绕过故障临时改回 GHCR 输入或使用 `latest`。
- 个人版使用固定用户名/密码凭据，没有短期令牌；凭据只允许保存在
  `RegistryPublish` Environment 的 `TCR_USERNAME`、`TCR_PASSWORD` secret 中。
- 怀疑凭据泄露时，立即在 TCR 控制台重置密码、更新两个 secret，并审查
  发布日志；凭据不得写入仓库、Issue、日志、服务器文件或 docker config。
- 工作流不向服务器分发任何 registry 凭据；服务器拉取的是私有仓库镜像，
  其访问配置属于服务器基线，变更需单独评审。

GHCR 备份仓库的预热仍在正式部署前、低风险时间窗口按工作流产出的完整 digest 执行：

```sh
docker pull 'ghcr.io/zwphhxx/kinvest@sha256:REVIEWED_DIGEST'
docker image inspect 'ghcr.io/zwphhxx/kinvest@sha256:REVIEWED_DIGEST'
```

只有摘要完全匹配才可继续部署。可以安全重试同一摘要；若必须从可信构建机传输镜像，应传输精确的 linux/amd64 构建产物，加载后再次校验 digest，不能用本地标签代替摘要证明。

## 10. 人工安全更新 iFinD refresh_token

网站只提醒管理员 token 即将到期或已经失效，绝不执行一键轮换、定时轮换或绕过 iFinD 登录流程。

阶段 5 配置完成后的标准操作：

1. 管理员人工进入 iFinD 官方登录页完成登录和必要验证。
2. 管理员取得新的 `refresh_token`，不在网页表单、聊天或工单中转发。
3. 管理员直接在腾讯云密钥管理服务中更新对应 secret 的新版本。
4. 确认应用运行身份只具备读取所需 secret 的最小权限。
5. 触发 Kinvest 应用安全重载，使进程重新从腾讯云密钥管理服务读取 token。
6. 执行一个最小、低额度、已验证指标的 iFinD 查询。
7. 只记录“更新时间、操作者、secret 版本、验证成功/失败”等审计元数据，不记录 token。
8. 验证成功后按腾讯云策略停用旧 secret 版本；失败时恢复旧版本并调查，不把 token 改写到本地文件。

强制边界：

- token 不落盘。
- token 不进入网页。
- token 不进入 SQLite 或未来数据库。
- token 不进入应用日志、Nginx 日志或审计正文。
- token 不进入 Git 仓库、Docker 镜像、GitHub Actions 普通变量或构建缓存。
- token 不在聊天中粘贴。
- 网站不自动轮换 token，只显示到期提醒和人工操作指引。

阶段 5 尚未完成腾讯云密钥管理服务的外部配置，因此当前不得创建本地临时 token 方案作为替代。

## 11. 故障处置顺序

1. 先确认公网健康接口和当前用户影响。
2. 再确认 `kinvest`、`nginx` 和 `web` 网络状态。
3. 保留当前日志和 state 元数据，但先脱敏再共享。
4. 候选发布失败时保持最近健康版本，不反复重启 Nginx。
5. 应用故障优先回滚 immutable digest；入口故障优先恢复最近 Nginx 配置。
6. 数据故障先停止写入并冷备份，再决定 SQLite 恢复。
7. 不在 Kinvest 故障处理中调整 Tailscale、防火墙或现有数据库。
8. 恢复后检查健康接口、首页、Mock/真实数据标识、安全响应头和容器健康。

任何处置都不得通过降低 SSH 主机校验、开放应用端口、放宽数据库权限或打印 secret 来换取临时恢复。

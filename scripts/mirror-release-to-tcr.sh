#!/usr/bin/env bash
# 本地 TCR 镜像:将 GHCR 上已发布的精确 digest 复制到 TCR 个人版。
# 在管理员 Mac(境内网络)上手工执行,利用本地到 TCR(广州)的境内链路,
# 替代跨境低吞吐的 GitHub runner 复制。
# 边界:只复制镜像;不生成 release record,不操作 GitHub,不操作服务器。
# 凭据:只使用当前用户已有的 Docker credential store;不接受命令行密码,
# 不读取任何凭据文件,不打印 docker 客户端配置。
set -euo pipefail

readonly CRANE_VERSION='v0.21.7'
readonly CRANE_SHA256_ARM64='1858c55dcd6053fe869bcb0c4ec20666383ddce445ad0f7e15e1e506b1f7fe52'
readonly CRANE_SHA256_X86_64='63a7dd15168d4dcac37933c7f6745438f2943d5898a1cf7896ad3341d8519bf2'
readonly GHCR_REPOSITORY='ghcr.io/zwphhxx/kinvest'
readonly TCR_REPOSITORY='ccr.ccs.tencentyun.com/website-dev/kinvest'
readonly MIRROR_TIMEOUT_SECONDS="${MIRROR_TIMEOUT_SECONDS:-3600}"

usage() {
  printf '用法: %s <commit_sha> <ghcr_digest>\n' "$(basename "$0")" >&2
  printf '%s\n' 'commit_sha 为 main 上 40 位小写 hex;ghcr_digest 为 sha256:<64 位小写 hex>。' >&2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

main() {
  if (($# != 2)); then
    usage
    exit 2
  fi
  local commit_sha="$1"
  local ghcr_digest="$2"
  if [[ "$commit_sha" == *latest* || "$ghcr_digest" == *latest* ]]; then
    fail '禁止使用 latest 或任何可变标签。'
  fi
  if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
    fail 'commit_sha 必须是 40 位小写 hex。'
  fi
  if [[ ! "$ghcr_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail 'ghcr_digest 必须是 sha256:<64 位小写 hex>。'
  fi
  if [[ "$(uname -s)" != 'Darwin' ]]; then
    fail '本脚本只在 macOS 上运行。'
  fi
  local arch
  arch="$(uname -m)"
  local crane_asset
  local crane_sha256
  case "$arch" in
    arm64)
      crane_asset='go-containerregistry_Darwin_arm64.tar.gz'
      crane_sha256="$CRANE_SHA256_ARM64"
      ;;
    x86_64)
      crane_asset='go-containerregistry_Darwin_x86_64.tar.gz'
      crane_sha256="$CRANE_SHA256_X86_64"
      ;;
    *)
      fail "不支持的 CPU 架构: ${arch}"
      ;;
  esac
  if [[ ! "$MIRROR_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || ((MIRROR_TIMEOUT_SECONDS < 60)); then
    fail 'MIRROR_TIMEOUT_SECONDS 必须是不小于 60 的整数。'
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "$work_dir"
  }
  trap cleanup EXIT INT TERM

  curl -fsSL --max-time 120 \
    -o "$work_dir/crane.tar.gz" \
    "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/${crane_asset}" \
    || fail 'crane 下载失败。'
  printf '%s  %s\n' "$crane_sha256" "$work_dir/crane.tar.gz" | shasum -a 256 -c - >/dev/null \
    || fail 'crane SHA-256 校验失败。'
  tar -xzf "$work_dir/crane.tar.gz" -C "$work_dir" crane
  rm -f "$work_dir/crane.tar.gz"
  local crane="$work_dir/crane"
  "$crane" version >/dev/null || fail 'crane 无法执行。'

  local copy_src="${GHCR_REPOSITORY}@${ghcr_digest}"
  local tcr_ref="${TCR_REPOSITORY}:${commit_sha}"

  local tag_digest
  if ! tag_digest="$("$crane" digest "${GHCR_REPOSITORY}:${commit_sha}" 2>"$work_dir/query.log")"; then
    fail 'GHCR commit 标签 digest 查询失败(检查网络与 GHCR 访问)。'
  fi
  if [[ "$tag_digest" != "$ghcr_digest" ]]; then
    fail '输入 digest 与 GHCR 上该 commit 标签的实际 digest 不一致。'
  fi
  printf 'mirror source: %s\n' "$copy_src"
  printf 'mirror destination: %s\n' "$tcr_ref"

  local copy_log="$work_dir/copy.log"
  local status=0
  local copy_pid=''
  "$crane" copy "$copy_src" "$tcr_ref" >"$copy_log" 2>&1 &
  copy_pid=$!
  local deadline=$(( $(date +%s) + MIRROR_TIMEOUT_SECONDS ))
  while kill -0 "$copy_pid" 2>/dev/null; do
    if (($(date +%s) >= deadline)); then
      kill -TERM "$copy_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$copy_pid" 2>/dev/null || true
      status=124
      break
    fi
    sleep 5
  done
  if ((status == 0)); then
    wait "$copy_pid" || status=$?
  fi
  if ((status != 0)); then
    printf 'TCR mirror copy failed with exit code %s.\n' "$status" >&2
    exit 1
  fi

  local tcr_digest
  if ! tcr_digest="$("$crane" digest "$tcr_ref" 2>"$work_dir/query.log")"; then
    fail 'TCR digest 查询失败。'
  fi
  if [[ ! "$tcr_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail 'TCR 报告的 digest 格式非法。'
  fi
  if [[ "$tcr_digest" != "$ghcr_digest" ]]; then
    fail 'TCR digest 与 GHCR digest 不一致。'
  fi

  printf 'commit_sha: %s\n' "$commit_sha"
  printf 'ghcr_digest: %s\n' "$ghcr_digest"
  printf 'tcr_digest: %s\n' "$tcr_digest"
  cleanup
  trap - EXIT INT TERM
  printf '%s\n' 'TCR mirror completed successfully.'
}

main "$@"

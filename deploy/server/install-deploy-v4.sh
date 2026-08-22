#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_SBIN='/usr/local/sbin'
LOCAL_LIBEXEC='/usr/local/libexec'
SERVER_ROOT='/root/docker/kinvest'
SUDOERS_DIR='/etc/sudoers.d'
RUN_ROOT='/run'
BACKUP_ROOT="$SERVER_ROOT/install-backups/deploy-v4"
SOURCE_ASSETS=('deploy-kinvest-v4' 'deploy-kinvest-v3.sh' 'kinvest-ssh-command-v3' 'deploy-v3-contract.py' 'docker-compose-v3.yml' 'kinvest-deploy-v4.sudoers' 'access-control-network.conf.example')
TARGETS=("$LOCAL_SBIN/deploy-kinvest-v4" "$LOCAL_SBIN/deploy-kinvest-v3" "$LOCAL_SBIN/kinvest-ssh-command" "$LOCAL_LIBEXEC/kinvest-deploy-v4-contract" "$SERVER_ROOT/docker-compose-v4.yml" "$SUDOERS_DIR/kinvest-deploy-v4" "$SERVER_ROOT/access-control-network.conf.example")
MODES=('0755' '0755' '0755' '0755' '0644' '0440' '0600')
EXPECTED_ASSET_HASHES=(
  'fb25bd314ab46e3af56fe46e83564000d7388d6f7670b63d370b4047d2d4e86d'
  'e1a015b62e96a892c5a66350d95c4fd10b03545dd71d4dc8f8452b6ee31a1bd2'
  '6a711ade7cd00e953ff9a6849d21c547fb3de5a2739ae4a7d5de5ed1a3878136'
  '0b76145d334501a1ad45810737acd667a36b14482a3ed550377c24982a30d15c'
  '7698dd619fb6a441763f85e4e35c819af55e431c6d0ac9c4b527930d07a644aa'
  '3001cab7876d3d03b3188aa60f25450d0010ba272e2419b10a5da2fba9ad51cf'
  'cef9b242ad3de3c2134e2a4e7e1ae1693ce55cd63bb9ac9d65710ec796309594'
)

fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
[[ "$#" -eq 1 && "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && ! -L "$SOURCE_DIR" ]] || fail 'usage: install-deploy-v4.sh /absolute/canonical/source/dir' 2
[[ "$(id -u)" -eq 0 ]] || fail 'deploy-v4 installation must run as root'
[[ "$(realpath -e "$SOURCE_DIR")" == "$SOURCE_DIR" ]] || fail 'deploy-v4 source directory must be canonical'

for index in "${!SOURCE_ASSETS[@]}"; do
  source="$SOURCE_DIR/${SOURCE_ASSETS[$index]}"
  [[ -f "$source" && ! -L "$source" ]] || fail "invalid deploy-v4 source file: ${SOURCE_ASSETS[$index]}"
  actual="$(sha256sum "$source" | awk '{print $1}')"
  [[ "$actual" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "untrusted deploy-v4 source hash: ${SOURCE_ASSETS[$index]}"
done
bash -n "$SOURCE_DIR/deploy-kinvest-v4"
bash -n "$SOURCE_DIR/deploy-kinvest-v3.sh"
bash -n "$SOURCE_DIR/kinvest-ssh-command-v3"
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$SOURCE_DIR/deploy-v3-contract.py"
visudo -cf "$SOURCE_DIR/kinvest-deploy-v4.sudoers" >/dev/null

install -d -o root -g root -m 0700 "$BACKUP_ROOT"
stage="$(mktemp -d "$RUN_ROOT/kinvest-deploy-v4-stage.XXXXXX")"
backup="$(mktemp -d "$BACKUP_ROOT/kinvest-deploy-v4-backup.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
chmod 0700 "$stage" "$backup"

for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || fail "unsafe deploy-v4 target: $target"
  install -d -o root -g root -m 0755 "$(dirname "$target")"
  if [[ -f "$target" ]]; then cp -p "$target" "$backup/$index.asset"; else : >"$backup/$index.absent"; fi
  install -o root -g root -m "${MODES[$index]}" "$SOURCE_DIR/${SOURCE_ASSETS[$index]}" "$stage/$index"
done
{
  printf '%s\n' kinvest-deploy-v4-install-backup-v1
  for index in "${!TARGETS[@]}"; do
    printf '%s|%s|%s\n' "$index" "${TARGETS[$index]}" "$(sha256sum "$stage/$index" | awk '{print $1}')"
  done
} >"$backup/manifest.txt"
chmod 0600 "$backup/manifest.txt"

exec 9>"$SERVER_ROOT/state/deploy.lock"
flock -n 9 || fail 'another Kinvest deployment is already running'
for index in "${!TARGETS[@]}"; do
  temporary="$(mktemp "$(dirname "${TARGETS[$index]}")/.kinvest-v4-install.XXXXXX")"
  install -o root -g root -m "${MODES[$index]}" "$stage/$index" "$temporary"
  mv -fT "$temporary" "${TARGETS[$index]}"
done
visudo -cf "$SUDOERS_DIR/kinvest-deploy-v4" >/dev/null
sudo -n -U kinvest-deploy -l "$LOCAL_SBIN/deploy-kinvest-v4" >/dev/null
sha256sum "${TARGETS[@]}"
printf 'deploy-v4 installation backup preserved at %s\n' "$backup"
printf '%s\n' 'deploy-v4 assets installed; no configuration was enabled and no container was restarted.'

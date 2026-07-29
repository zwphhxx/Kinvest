#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
PUBLIC_KEY_FILE="${2:-}"
TARGET='/root/docker/kinvest'
DEPLOY_USER='kinvest-deploy'
DEPLOY_HOME='/home/kinvest-deploy'

if [[ -z "$SOURCE_DIR" || -z "$PUBLIC_KEY_FILE" ]]; then
  printf '%s\n' 'usage: bootstrap-server.sh /absolute/source/dir /absolute/public-key-file' >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'bootstrap must run as root' >&2
  exit 1
fi

for command in docker setpriv install useradd passwd visudo realpath flock; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "required command is unavailable: $command" >&2
    exit 1
  fi
done
docker compose version >/dev/null

assert_not_symlink() {
  local candidate="$1"

  if [[ -L "$candidate" ]]; then
    printf '%s\n' "refusing symlinked path: $candidate" >&2
    exit 1
  fi
}

if [[ "$SOURCE_DIR" != /* || "$PUBLIC_KEY_FILE" != /* ]]; then
  printf '%s\n' 'source paths must be absolute' >&2
  exit 2
fi

if [[ "$(realpath -e -- "$SOURCE_DIR")" != "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
  printf '%s\n' 'source directory must be canonical, physical, and present' >&2
  exit 2
fi

if [[ "$(realpath -e -- "$PUBLIC_KEY_FILE")" != "$PUBLIC_KEY_FILE" || ! -f "$PUBLIC_KEY_FILE" ]]; then
  printf '%s\n' 'public key file must be canonical, physical, and present' >&2
  exit 2
fi

assert_not_symlink "$SOURCE_DIR"
assert_not_symlink "$PUBLIC_KEY_FILE"

for source_file in docker-compose.yml prepare-data-dir.sh deploy-kinvest.sh; do
  assert_not_symlink "$SOURCE_DIR/$source_file"
  if [[ ! -f "$SOURCE_DIR/$source_file" ]]; then
    printf '%s\n' "required bootstrap source is missing: $source_file" >&2
    exit 1
  fi
done

if [[ ! -d '/root/docker' ]]; then
  printf '%s\n' 'required server directory /root/docker is absent' >&2
  exit 1
fi

for target_component in '/root' '/root/docker' "$TARGET" "$TARGET/data" "$TARGET/state"; do
  assert_not_symlink "$target_component"
done

install -d -o root -g root -m 0750 -- "$TARGET"
install -d -o root -g root -m 0700 -- "$TARGET/state"

for target_file in docker-compose.yml prepare-data-dir.sh deploy-kinvest.sh; do
  assert_not_symlink "$TARGET/$target_file"
done

install -o root -g root -m 0644 -- "$SOURCE_DIR/docker-compose.yml" "$TARGET/docker-compose.yml"
install -o root -g root -m 0755 -- "$SOURCE_DIR/prepare-data-dir.sh" "$TARGET/prepare-data-dir.sh"
install -o root -g root -m 0755 -- "$SOURCE_DIR/deploy-kinvest.sh" "$TARGET/deploy-kinvest.sh"
install -o root -g root -m 0755 -- "$TARGET/deploy-kinvest.sh" /usr/local/sbin/deploy-kinvest

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$DEPLOY_HOME" --shell /bin/bash "$DEPLOY_USER"
fi

deploy_home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
if [[ "$deploy_home" != "$DEPLOY_HOME" ]]; then
  printf '%s\n' 'existing deployment user has an unexpected home directory' >&2
  exit 1
fi

passwd --lock kinvest-deploy >/dev/null
assert_not_symlink "$DEPLOY_HOME"
assert_not_symlink "$DEPLOY_HOME/.ssh"
assert_not_symlink "$DEPLOY_HOME/.ssh/authorized_keys"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 -- "$DEPLOY_HOME/.ssh"
chmod 700 "$DEPLOY_HOME/.ssh"
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0600 -- \
  "$PUBLIC_KEY_FILE" "$DEPLOY_HOME/.ssh/authorized_keys"

"$TARGET/prepare-data-dir.sh" >/dev/null
docker network inspect web >/dev/null 2>&1 || docker network create web >/dev/null

sudoers_file='/etc/sudoers.d/kinvest-deploy'
assert_not_symlink "$sudoers_file"
temporary_sudoers="$(mktemp /etc/sudoers.d/.kinvest-deploy.XXXXXX)"
printf '%s\n' \
  'kinvest-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest *' \
  > "$temporary_sudoers"
chmod 0440 "$temporary_sudoers"
visudo -cf "$temporary_sudoers" >/dev/null
mv -f -- "$temporary_sudoers" "$sudoers_file"
visudo -cf "$sudoers_file" >/dev/null

printf '%s\n' 'Kinvest server bootstrap is ready; no deployment was started.'

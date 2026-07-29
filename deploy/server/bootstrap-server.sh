#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
PUBLIC_KEY_FILE="${2:-}"
DOCKER_ROOT='/root/docker'
TARGET="$DOCKER_ROOT/kinvest"
DEPLOY_USER='kinvest-deploy'
DEPLOY_HOME='/home/kinvest-deploy'
APP_UID='10001'
APP_GID='10001'
DEPLOY_UID='10002'
DEPLOY_GID='10002'
LOCAL_DEPLOY_SCRIPT='/usr/local/sbin/deploy-kinvest'
LOCAL_SSH_COMMAND='/usr/local/sbin/kinvest-ssh-command'
SUDOERS_FILE='/etc/sudoers.d/kinvest-deploy'

if [[ -z "$SOURCE_DIR" || -z "$PUBLIC_KEY_FILE" ]]; then
  printf '%s\n' 'usage: bootstrap-server.sh /absolute/source/dir /absolute/public-key-file' >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'bootstrap must run as root' >&2
  exit 1
fi

for command in docker setpriv install useradd groupadd passwd visudo realpath flock timeout wc grep getent mktemp stat fuser; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "required command is unavailable: $command" >&2
    exit 1
  fi
done

if getent passwd "$APP_UID" >/dev/null; then
  printf '%s\n' "UID $APP_UID is already assigned; refusing to prepare Kinvest." >&2
  exit 1
fi

if getent group "$APP_GID" >/dev/null; then
  printf '%s\n' "GID $APP_GID is already assigned; refusing to prepare Kinvest." >&2
  exit 1
fi

docker compose version >/dev/null

assert_not_symlink() {
  local candidate="$1"

  if [[ -L "$candidate" ]]; then
    printf '%s\n' "refusing symlinked path: $candidate" >&2
    exit 1
  fi
}

assert_existing_path_canonical() {
  local candidate="$1"

  if [[ -e "$candidate" && "$(realpath -e -- "$candidate")" != "$candidate" ]]; then
    printf '%s\n' "refusing non-canonical existing path: $candidate" >&2
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

source_files=(docker-compose.yml migrate-data-uid-lib.sh migrate-data-uid.sh prepare-data-dir.sh deploy-kinvest.sh kinvest-ssh-command)
for source_file in "${source_files[@]}"; do
  assert_not_symlink "$SOURCE_DIR/$source_file"
  if [[ ! -f "$SOURCE_DIR/$source_file" ]]; then
    printf '%s\n' "required bootstrap source is missing: $source_file" >&2
    exit 1
  fi
  if [[ "$(realpath -e -- "$SOURCE_DIR/$source_file")" != "$SOURCE_DIR/$source_file" ]]; then
    printf '%s\n' "bootstrap source must use its canonical path: $source_file" >&2
    exit 1
  fi
done

if [[ ! -d "$DOCKER_ROOT" ]]; then
  printf '%s\n' "required server directory $DOCKER_ROOT is absent" >&2
  exit 1
fi

target_components=(
  '/root'
  "$DOCKER_ROOT"
  "$TARGET"
  "$TARGET/data"
  "$TARGET/state"
  "${LOCAL_DEPLOY_SCRIPT%/*}"
  "${DEPLOY_HOME%/*}"
  "$DEPLOY_HOME"
  "$DEPLOY_HOME/.ssh"
  "${SUDOERS_FILE%/*}"
)
for target_component in "${target_components[@]}"; do
  assert_not_symlink "$target_component"
  assert_existing_path_canonical "$target_component"
done

target_files=()
for source_file in "${source_files[@]}"; do
  target_files+=("$TARGET/$source_file")
done
target_files+=(
  "$LOCAL_DEPLOY_SCRIPT"
  "$LOCAL_SSH_COMMAND"
  "$DEPLOY_HOME/.ssh/authorized_keys"
  "$SUDOERS_FILE"
)
for target_file in "${target_files[@]}"; do
  assert_not_symlink "$target_file"
  assert_existing_path_canonical "$target_file"
done

if [[ "$(wc -l < "$PUBLIC_KEY_FILE")" -ne 1 ]]; then
  printf '%s\n' 'deployment public key file must contain exactly one line' >&2
  exit 2
fi

public_key_type=''
public_key_blob=''
public_key_comment=''
IFS=' ' read -r public_key_type public_key_blob public_key_comment < "$PUBLIC_KEY_FILE"

if [[ "$public_key_type" != 'ssh-ed25519' || ! "$public_key_blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  printf '%s\n' 'deployment public key must be one plain Ed25519 key without options' >&2
  exit 2
fi

DEPLOY_ACCOUNT_STATE=''
deploy_record=''
existing_deploy_uid=''
existing_deploy_gid=''
deploy_home=''

if id "$DEPLOY_USER" >/dev/null 2>&1; then
  DEPLOY_ACCOUNT_STATE='existing'
  deploy_record="$(getent passwd "$DEPLOY_USER")"
  IFS=: read -r _ _ existing_deploy_uid existing_deploy_gid _ deploy_home _ <<< "$deploy_record"

  if [[ -z "$existing_deploy_uid" || -z "$existing_deploy_gid" ]]; then
    printf '%s\n' 'existing deployment user has an invalid account record' >&2
    exit 1
  fi
  if [[ "$existing_deploy_uid" == "$APP_UID" || "$existing_deploy_gid" == "$APP_GID" ]]; then
    printf '%s\n' 'deployment user must not share the Kinvest application UID or GID' >&2
    exit 1
  fi
  if [[ "$deploy_home" != "$DEPLOY_HOME" ]]; then
    printf '%s\n' 'existing deployment user has an unexpected home directory' >&2
    exit 1
  fi
  if id -nG "$DEPLOY_USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    printf '%s\n' 'deployment user has forbidden direct Docker daemon access' >&2
    exit 1
  fi
else
  DEPLOY_ACCOUNT_STATE='fresh'
  if getent passwd "$DEPLOY_UID" >/dev/null || getent group "$DEPLOY_GID" >/dev/null; then
    printf '%s\n' "deployment UID:GID $DEPLOY_UID:$DEPLOY_GID is already assigned" >&2
    exit 1
  fi
  if getent passwd "$DEPLOY_USER" >/dev/null || getent group "$DEPLOY_USER" >/dev/null; then
    printf '%s\n' "deployment account name is partially assigned: $DEPLOY_USER" >&2
    exit 1
  fi
fi

install -d -o root -g root -m 0750 -- "$TARGET"
install -d -o root -g root -m 0700 -- "$TARGET/state"

install -o root -g root -m 0644 -- "$SOURCE_DIR/docker-compose.yml" "$TARGET/docker-compose.yml"
install -o root -g root -m 0644 -- "$SOURCE_DIR/migrate-data-uid-lib.sh" "$TARGET/migrate-data-uid-lib.sh"
install -o root -g root -m 0755 -- "$SOURCE_DIR/migrate-data-uid.sh" "$TARGET/migrate-data-uid.sh"
install -o root -g root -m 0755 -- "$SOURCE_DIR/prepare-data-dir.sh" "$TARGET/prepare-data-dir.sh"
install -o root -g root -m 0755 -- "$SOURCE_DIR/deploy-kinvest.sh" "$TARGET/deploy-kinvest.sh"
install -o root -g root -m 0755 -- "$SOURCE_DIR/kinvest-ssh-command" "$TARGET/kinvest-ssh-command"
install -o root -g root -m 0755 -- "$TARGET/deploy-kinvest.sh" "$LOCAL_DEPLOY_SCRIPT"
install -o root -g root -m 0755 -- "$TARGET/kinvest-ssh-command" "$LOCAL_SSH_COMMAND"

"$TARGET/migrate-data-uid.sh" >/dev/null
"$TARGET/prepare-data-dir.sh" >/dev/null

if [[ "$DEPLOY_ACCOUNT_STATE" == 'fresh' ]]; then
  groupadd --gid "$DEPLOY_GID" "$DEPLOY_USER"
  useradd --uid "$DEPLOY_UID" --gid "$DEPLOY_GID" --create-home --home-dir "$DEPLOY_HOME" --shell /bin/bash "$DEPLOY_USER"

  deploy_record="$(getent passwd "$DEPLOY_USER")"
  IFS=: read -r _ _ existing_deploy_uid existing_deploy_gid _ deploy_home _ <<< "$deploy_record"

  if [[ "$existing_deploy_uid" != "$DEPLOY_UID" || "$existing_deploy_gid" != "$DEPLOY_GID" || "$deploy_home" != "$DEPLOY_HOME" ]]; then
    printf '%s\n' 'fresh deployment user does not match the preflighted identity' >&2
    exit 1
  fi
  if id -nG "$DEPLOY_USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    printf '%s\n' 'fresh deployment user has forbidden direct Docker daemon access' >&2
    exit 1
  fi
fi

passwd --lock kinvest-deploy >/dev/null
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 -- "$DEPLOY_HOME/.ssh"
chmod 700 "$DEPLOY_HOME/.ssh"

authorized_keys_temporary="$(mktemp "$DEPLOY_HOME/.ssh/.authorized_keys.XXXXXX")"
printf 'restrict,command="/usr/local/sbin/kinvest-ssh-command" %s %s\n' \
  "$public_key_type" "$public_key_blob" > "$authorized_keys_temporary"
chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys_temporary"
chmod 0600 "$authorized_keys_temporary"
mv -f -- "$authorized_keys_temporary" "$DEPLOY_HOME/.ssh/authorized_keys"

docker network inspect web >/dev/null 2>&1 || docker network create web >/dev/null

temporary_sudoers="$(mktemp "${SUDOERS_FILE%/*}/.kinvest-deploy.XXXXXX")"
printf '%s\n' \
  'kinvest-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest ""' \
  > "$temporary_sudoers"
chmod 0440 "$temporary_sudoers"
visudo -cf "$temporary_sudoers" >/dev/null
mv -f -- "$temporary_sudoers" "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null

printf '%s\n' "Kinvest server bootstrap is ready for container UID:GID $APP_UID:$APP_GID; no deployment was started."

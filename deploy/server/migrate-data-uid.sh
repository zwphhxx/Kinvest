#!/usr/bin/env sh
set -eu

DATA_DIR='/root/docker/kinvest/data'
STATE_DIR='/root/docker/kinvest/state'
LOCK_FILE="$STATE_DIR/deploy.lock"
APP_UID='10001'
APP_GID='10001'
LEGACY_UID='1000'
LEGACY_GID='1000'
SQLITE_FILES='kinvest.sqlite kinvest.sqlite-wal kinvest.sqlite-shm kinvest.sqlite-journal'
DATA_RECLAIMED='false'
MIGRATION_COMPLETE='false'

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: migrate-data-uid.sh' >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Kinvest data UID migration must run as root.' >&2
  exit 1
fi

for REQUIRED_COMMAND in docker flock stat fuser setpriv chown chmod; do
  if ! command -v "$REQUIRED_COMMAND" >/dev/null 2>&1; then
    printf '%s\n' "$REQUIRED_COMMAND is required for offline Kinvest data migration." >&2
    exit 1
  fi
done

assert_no_symlink_components() {
  for PATH_COMPONENT in \
    '/root' \
    '/root/docker' \
    '/root/docker/kinvest' \
    "$STATE_DIR" \
    "$DATA_DIR" \
    "$LOCK_FILE"; do
    if [ -L "$PATH_COMPONENT" ]; then
      printf '%s\n' "Refusing symlinked migration path: $PATH_COMPONENT" >&2
      exit 1
    fi
  done
}

assert_no_symlink_components

if [ ! -d "$STATE_DIR" ]; then
  printf '%s\n' "Kinvest state directory is missing: $STATE_DIR" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s\n' 'another Kinvest deployment or migration is already running' >&2
  exit 1
fi

assert_no_symlink_components

if [ ! -e "$DATA_DIR" ]; then
  printf '%s\n' 'Kinvest data directory is absent; no legacy UID migration is required.'
  exit 0
fi

if [ ! -d "$DATA_DIR" ]; then
  printf '%s\n' "Kinvest data path is not a directory: $DATA_DIR" >&2
  exit 1
fi

cd -P -- "$DATA_DIR"
if [ "$(pwd -P)" != "$DATA_DIR" ]; then
  printf '%s\n' "Refusing unexpected physical data directory: $(pwd -P)" >&2
  exit 1
fi

CONTAINER_IDS=$(docker ps -aq --no-trunc)
for CONTAINER_ID in $CONTAINER_IDS; do
  MOUNT_SOURCES=$(docker inspect --type container --format '{{range .Mounts}}{{println .Source}}{{end}}' "$CONTAINER_ID")
  CONTAINER_USES_DATA='false'

  while IFS= read -r MOUNT_SOURCE; do
    if [ "$MOUNT_SOURCE" = "$DATA_DIR" ]; then
      CONTAINER_USES_DATA='true'
    fi
  done <<EOF
$MOUNT_SOURCES
EOF

  if [ "$CONTAINER_USES_DATA" = 'true' ]; then
    CONTAINER_STATUS=$(docker inspect --type container --format '{{.State.Status}}' "$CONTAINER_ID")
    CONTAINER_NAME=$(docker inspect --type container --format '{{.Name}}' "$CONTAINER_ID")
    CONTAINER_NAME=${CONTAINER_NAME#/}

    if [ "$CONTAINER_STATUS" != 'exited' ]; then
      printf '%s\n' \
        "Container $CONTAINER_NAME is $CONTAINER_STATUS and mounts $DATA_DIR; stop it before migration." >&2
      exit 1
    fi
  fi
done

for SQLITE_FILE in $SQLITE_FILES; do
  if [ ! -e "$SQLITE_FILE" ] && [ ! -L "$SQLITE_FILE" ]; then
    continue
  fi

  if [ -L "$SQLITE_FILE" ]; then
    continue
  fi

  if fuser -s "$SQLITE_FILE"; then
    printf '%s\n' "SQLite file has an open file handle: $SQLITE_FILE" >&2
    exit 1
  else
    FUSER_STATUS=$?
    if [ "$FUSER_STATUS" -ne 1 ]; then
      printf '%s\n' "Unable to verify open file handles for: $SQLITE_FILE" >&2
      exit 1
    fi
  fi
done

finish_migration() {
  STATUS=$?
  trap - EXIT HUP INT TERM

  if [ "$STATUS" -ne 0 ] && [ "$DATA_RECLAIMED" = 'true' ] && [ "$MIGRATION_COMPLETE" != 'true' ]; then
    chown root:root -- . >/dev/null 2>&1 || true
    chmod 0700 -- . >/dev/null 2>&1 || true
    printf '%s\n' \
      'Kinvest UID migration failed after data isolation; data remains root-only and manual intervention is required.' >&2
  fi

  exit "$STATUS"
}

trap finish_migration EXIT HUP INT TERM

chown root:root -- .
chmod 0700 -- .
DATA_RECLAIMED='true'

if [ "$(stat -c '%u:%g' -- .)" != '0:0' ] || [ "$(stat -c '%a' -- .)" != '700' ]; then
  printf '%s\n' 'Failed to isolate the Kinvest data directory as root-only.' >&2
  exit 1
fi

PRESENT_SQLITE_FILES=''

for SQLITE_FILE in $SQLITE_FILES; do
  if [ ! -e "$SQLITE_FILE" ] && [ ! -L "$SQLITE_FILE" ]; then
    continue
  fi

  if [ -L "$SQLITE_FILE" ]; then
    printf '%s\n' "Refusing symlinked SQLite file: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_TYPE=$(stat -c '%F' -- "$SQLITE_FILE")
  case "$FILE_TYPE" in
    'regular file'|'regular empty file')
      ;;
    *)
      printf '%s\n' "Refusing non-regular SQLite file: $SQLITE_FILE" >&2
      exit 1
      ;;
  esac

  LINK_COUNT=$(stat -c '%h' -- "$SQLITE_FILE")
  if [ "$LINK_COUNT" -ne 1 ]; then
    printf '%s\n' "Refusing SQLite file with multiple hard links: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_OWNER=$(stat -c '%u:%g' -- "$SQLITE_FILE")
  case "$FILE_OWNER" in
    "$APP_UID:$APP_GID"|"$LEGACY_UID:$LEGACY_GID")
      ;;
    *)
      printf '%s\n' "Refusing SQLite file with unexpected owner $FILE_OWNER: $SQLITE_FILE" >&2
      exit 1
      ;;
  esac

  PRESENT_SQLITE_FILES="$PRESENT_SQLITE_FILES $SQLITE_FILE"
done

for SQLITE_FILE in $PRESENT_SQLITE_FILES; do
  FILE_OWNER=$(stat -c '%u:%g' -- "$SQLITE_FILE")
  if [ "$FILE_OWNER" = "$LEGACY_UID:$LEGACY_GID" ]; then
    chown "$APP_UID:$APP_GID" -- "$SQLITE_FILE"
  elif [ "$FILE_OWNER" != "$APP_UID:$APP_GID" ]; then
    printf '%s\n' "SQLite file owner changed during migration: $SQLITE_FILE" >&2
    exit 1
  fi

  chmod 0600 -- "$SQLITE_FILE"

  if [ "$(stat -c '%u:%g' -- "$SQLITE_FILE")" != "$APP_UID:$APP_GID" ] ||
    [ "$(stat -c '%a' -- "$SQLITE_FILE")" != '600' ]; then
    printf '%s\n' "SQLite file migration verification failed: $SQLITE_FILE" >&2
    exit 1
  fi
done

chown "$APP_UID:$APP_GID" -- .
chmod 0750 -- .

setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups sh -c '
  for SQLITE_FILE do
    if [ ! -r "$SQLITE_FILE" ] || [ ! -w "$SQLITE_FILE" ]; then
      exit 1
    fi
    exec 3<> "$SQLITE_FILE"
    exec 3>&-
  done
' sh $PRESENT_SQLITE_FILES

if [ "$(stat -c '%u:%g' -- .)" != "$APP_UID:$APP_GID" ] ||
  [ "$(stat -c '%a' -- .)" != '750' ]; then
  printf '%s\n' 'Kinvest data directory final ownership verification failed.' >&2
  exit 1
fi

MIGRATION_COMPLETE='true'
printf '%s\n' "Kinvest offline data UID migration completed for UID:GID $APP_UID:$APP_GID."

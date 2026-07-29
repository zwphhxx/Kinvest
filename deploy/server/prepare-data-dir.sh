#!/usr/bin/env sh
set -eu

DATA_DIR='/root/docker/kinvest/data'
APP_UID='10001'
APP_GID='10001'
LEGACY_UID='1000'
LEGACY_GID='1000'
SQLITE_FILES='kinvest.sqlite kinvest.sqlite-wal kinvest.sqlite-shm kinvest.sqlite-journal'

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Kinvest data directory preparation must run as root.' >&2
  exit 1
fi

for REQUIRED_COMMAND in setpriv stat docker; do
  if ! command -v "$REQUIRED_COMMAND" >/dev/null 2>&1; then
    printf '%s\n' "$REQUIRED_COMMAND is required to prepare the Kinvest data directory." >&2
    exit 1
  fi
done

assert_no_symlink_components() {
  for PATH_COMPONENT in '/root' '/root/docker' '/root/docker/kinvest' "$DATA_DIR"; do
    if [ -L "$PATH_COMPONENT" ]; then
      printf '%s\n' "Refusing to use symlinked path component: $PATH_COMPONENT" >&2
      exit 1
    fi
  done
}

assert_no_symlink_components
install -d -m 0750 -- "$DATA_DIR"
assert_no_symlink_components

cd -P -- "$DATA_DIR"
if [ "$(pwd -P)" != "$DATA_DIR" ]; then
  printf '%s\n' "Refusing unexpected physical data directory: $(pwd -P)" >&2
  exit 1
fi

PRESENT_SQLITE_FILES=''
LEGACY_SQLITE_FILES=''

for SQLITE_FILE in $SQLITE_FILES; do
  if [ ! -e "$SQLITE_FILE" ] && [ ! -L "$SQLITE_FILE" ]; then
    continue
  fi

  if [ -L "$SQLITE_FILE" ]; then
    printf '%s\n' "Refusing symlinked SQLite file: $SQLITE_FILE" >&2
    exit 1
  fi

  if [ ! -f "$SQLITE_FILE" ]; then
    printf '%s\n' "Refusing non-regular SQLite file: $SQLITE_FILE" >&2
    exit 1
  fi

  LINK_COUNT=$(stat -c '%h' -- "$SQLITE_FILE")
  if [ "$LINK_COUNT" -ne 1 ]; then
    printf '%s\n' "Refusing SQLite file with multiple hard links: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_OWNER=$(stat -c '%u:%g' -- "$SQLITE_FILE")
  case "$FILE_OWNER" in
    "$APP_UID:$APP_GID")
      ;;
    "$LEGACY_UID:$LEGACY_GID")
      LEGACY_SQLITE_FILES="$LEGACY_SQLITE_FILES $SQLITE_FILE"
      ;;
    *)
      printf '%s\n' "Refusing SQLite file with unexpected owner $FILE_OWNER: $SQLITE_FILE" >&2
      exit 1
      ;;
  esac

  PRESENT_SQLITE_FILES="$PRESENT_SQLITE_FILES $SQLITE_FILE"
done

if [ -n "$LEGACY_SQLITE_FILES" ]; then
  RUNNING_KINVEST=$(docker ps \
    --filter 'name=^/kinvest$' \
    --filter 'status=running' \
    --format '{{.Names}}')

  if [ "$RUNNING_KINVEST" = 'kinvest' ]; then
    printf '%s\n' 'Legacy SQLite files were found while the Kinvest container is running; stop it first.' >&2
    exit 1
  fi
fi

chown "$APP_UID:$APP_GID" -- .
chmod 0750 -- .

for SQLITE_FILE in $PRESENT_SQLITE_FILES; do
  if [ -L "$SQLITE_FILE" ] || [ ! -f "$SQLITE_FILE" ]; then
    printf '%s\n' "SQLite file changed during validation: $SQLITE_FILE" >&2
    exit 1
  fi

  LINK_COUNT=$(stat -c '%h' -- "$SQLITE_FILE")
  if [ "$LINK_COUNT" -ne 1 ]; then
    printf '%s\n' "SQLite file link count changed during validation: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_OWNER=$(stat -c '%u:%g' -- "$SQLITE_FILE")
  case "$FILE_OWNER" in
    "$APP_UID:$APP_GID")
      ;;
    "$LEGACY_UID:$LEGACY_GID")
      chown "$APP_UID:$APP_GID" -- "$SQLITE_FILE"
      ;;
    *)
      printf '%s\n' "SQLite file owner changed during validation: $SQLITE_FILE" >&2
      exit 1
      ;;
  esac

  chmod 0600 -- "$SQLITE_FILE"

  if [ "$(stat -c '%u:%g' -- "$SQLITE_FILE")" != "$APP_UID:$APP_GID" ]; then
    printf '%s\n' "SQLite file ownership migration failed: $SQLITE_FILE" >&2
    exit 1
  fi
done

setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups sh -c '
  for SQLITE_FILE do
    if [ ! -r "$SQLITE_FILE" ] || [ ! -w "$SQLITE_FILE" ]; then
      exit 1
    fi
    exec 3<> "$SQLITE_FILE"
    exec 3>&-
  done
' sh $PRESENT_SQLITE_FILES

PROBE_BASE=".kinvest-write-probe-$$"

cleanup() {
  rm -f -- "$PROBE_BASE.sqlite" "$PROBE_BASE.sqlite-wal" "$PROBE_BASE.sqlite-shm"
}

trap cleanup EXIT HUP INT TERM

setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups sh -c '
  umask 077
  : > "$1.sqlite"
  : > "$1.sqlite-wal"
  : > "$1.sqlite-shm"
' sh "$PROBE_BASE"

cleanup
trap - EXIT HUP INT TERM

printf '%s\n' "Kinvest data directory is ready for UID:GID $APP_UID:$APP_GID."

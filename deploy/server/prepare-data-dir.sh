#!/usr/bin/env sh
set -eu

DATA_DIR='/root/docker/kinvest/data'
APP_UID='10001'
APP_GID='10001'
SQLITE_FILES='kinvest.sqlite kinvest.sqlite-wal kinvest.sqlite-shm kinvest.sqlite-journal'

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Kinvest data directory preparation must run as root.' >&2
  exit 1
fi

for REQUIRED_COMMAND in install setpriv stat mktemp; do
  if ! command -v "$REQUIRED_COMMAND" >/dev/null 2>&1; then
    printf '%s\n' "$REQUIRED_COMMAND is required to verify the Kinvest data directory." >&2
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

if [ ! -e "$DATA_DIR" ]; then
  install -d -o "$APP_UID" -g "$APP_GID" -m 0750 -- "$DATA_DIR"
elif [ ! -d "$DATA_DIR" ]; then
  printf '%s\n' "Kinvest data path is not a directory: $DATA_DIR" >&2
  exit 1
fi

assert_no_symlink_components

cd -P -- "$DATA_DIR"
if [ "$(pwd -P)" != "$DATA_DIR" ]; then
  printf '%s\n' "Refusing unexpected physical data directory: $(pwd -P)" >&2
  exit 1
fi

if [ "$(stat -c '%F' -- .)" != 'directory' ]; then
  printf '%s\n' 'Kinvest data path is not a regular directory.' >&2
  exit 1
fi

if [ "$(stat -c '%u:%g' -- .)" != "$APP_UID:$APP_GID" ]; then
  printf '%s\n' "Kinvest data directory must already have owner $APP_UID:$APP_GID." >&2
  exit 1
fi

DIRECTORY_MODE=$(stat -c '%a' -- .)
case "$DIRECTORY_MODE" in
  700|750)
    ;;
  *)
    printf '%s\n' "Kinvest data directory has unsafe mode $DIRECTORY_MODE." >&2
    exit 1
    ;;
esac

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

  if [ "$(stat -c '%h' -- "$SQLITE_FILE")" -ne 1 ]; then
    printf '%s\n' "Refusing SQLite file with multiple hard links: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_OWNER=$(stat -c '%u:%g' -- "$SQLITE_FILE")
  if [ "$FILE_OWNER" != "$APP_UID:$APP_GID" ]; then
    printf '%s\n' \
      "SQLite file must have expected owner $APP_UID:$APP_GID, found $FILE_OWNER: $SQLITE_FILE" >&2
    exit 1
  fi

  FILE_MODE=$(stat -c '%a' -- "$SQLITE_FILE")
  if [ "$FILE_MODE" != '600' ]; then
    printf '%s\n' "SQLite file has unsafe mode $FILE_MODE: $SQLITE_FILE" >&2
    exit 1
  fi

  PRESENT_SQLITE_FILES="$PRESENT_SQLITE_FILES $SQLITE_FILE"
done

setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups sh -c '
  for SQLITE_FILE do
    if [ ! -r "$SQLITE_FILE" ] || [ ! -w "$SQLITE_FILE" ]; then
      exit 1
    fi
    exec 3<> "$SQLITE_FILE"
    exec 3>&-
  done
  shift "$#"

  umask 077
  PROBE_FILES=""

  cleanup() {
    rm -f -- $PROBE_FILES
  }

  trap cleanup EXIT HUP INT TERM

  for PROBE_ROLE in main wal shm; do
    PROBE_FILE=$(mktemp ".kinvest-$PROBE_ROLE-probe.XXXXXXXXXX")
    PROBE_FILES="$PROBE_FILES $PROBE_FILE"
  done

  cleanup
  trap - EXIT HUP INT TERM
' sh $PRESENT_SQLITE_FILES

printf '%s\n' "Kinvest data directory is ready for UID:GID $APP_UID:$APP_GID."

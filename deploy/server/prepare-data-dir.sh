#!/usr/bin/env sh
set -eu

DATA_DIR='/root/docker/kinvest/data'
APP_UID='1000'
APP_GID='1000'

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Kinvest data directory preparation must run as root.' >&2
  exit 1
fi

if [ -L "$DATA_DIR" ]; then
  printf '%s\n' "Refusing to use symlinked data directory: $DATA_DIR" >&2
  exit 1
fi

if ! command -v setpriv >/dev/null 2>&1; then
  printf '%s\n' 'setpriv is required to verify the Kinvest application UID can write data.' >&2
  exit 1
fi

install -d -m 0750 -- "$DATA_DIR"
chown "$APP_UID:$APP_GID" -- "$DATA_DIR"
chmod 0750 -- "$DATA_DIR"

PROBE_BASE="$DATA_DIR/.kinvest-write-probe-$$"

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

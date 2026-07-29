#!/usr/bin/env sh
set -eu

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: migrate-data-uid.sh' >&2
  exit 2
fi

MIGRATION_ROOT='/root/docker/kinvest'
DATA_DIR='/root/docker/kinvest/data'
STATE_DIR='/root/docker/kinvest/state'

readonly MIGRATION_ROOT DATA_DIR STATE_DIR

. '/root/docker/kinvest/migrate-data-uid-lib.sh'

kinvest_migrate_data_uid \
  "$MIGRATION_ROOT" \
  "$DATA_DIR" \
  "$STATE_DIR" \
  '/usr/bin/id' \
  '/usr/bin/docker' \
  '/usr/bin/flock' \
  '/usr/bin/stat' \
  '/usr/sbin/fuser' \
  '/usr/bin/setpriv' \
  '/usr/bin/chown' \
  '/usr/bin/chmod' \
  '/bin/sh'

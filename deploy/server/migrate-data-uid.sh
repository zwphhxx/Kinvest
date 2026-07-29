#!/usr/bin/env sh
set -eu

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: migrate-data-uid.sh' >&2
  exit 2
fi

KINVEST_FIXED_MIGRATION_ROOT='/root/docker/kinvest'
KINVEST_FIXED_DATA_DIR='/root/docker/kinvest/data'
KINVEST_FIXED_STATE_DIR='/root/docker/kinvest/state'

readonly \
  KINVEST_FIXED_MIGRATION_ROOT \
  KINVEST_FIXED_DATA_DIR \
  KINVEST_FIXED_STATE_DIR

. '/root/docker/kinvest/migrate-data-uid-lib.sh'

kinvest_migrate_data_uid \
  "$KINVEST_FIXED_MIGRATION_ROOT" \
  "$KINVEST_FIXED_DATA_DIR" \
  "$KINVEST_FIXED_STATE_DIR" \
  '/usr/bin/id' \
  '/usr/bin/docker' \
  '/usr/bin/flock' \
  '/usr/bin/stat' \
  '/usr/sbin/fuser' \
  '/usr/bin/mktemp' \
  '/usr/bin/rm' \
  '/usr/bin/setpriv' \
  '/usr/bin/chown' \
  '/usr/bin/chmod' \
  '/bin/sh'

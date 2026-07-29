kinvest_migrate_data_uid() {
  set -eu

  if [ "$#" -ne 14 ]; then
    printf '%s\n' 'Kinvest migration core requires root, data, state, and eleven command adapters.' >&2
    return 2
  fi

  MIGRATION_ROOT=$1
  DATA_DIR=$2
  STATE_DIR=$3
  ID_COMMAND=$4
  DOCKER_COMMAND=$5
  FLOCK_COMMAND=$6
  STAT_COMMAND=$7
  FUSER_COMMAND=$8
  MKTEMP_COMMAND=$9
  shift 9
  RM_COMMAND=$1
  SETPRIV_COMMAND=$2
  CHOWN_COMMAND=$3
  CHMOD_COMMAND=$4
  SHELL_COMMAND=$5

  LOCK_FILE="$STATE_DIR/deploy.lock"
  APP_UID='10001'
  APP_GID='10001'
  LEGACY_UID='1000'
  LEGACY_GID='1000'
  SQLITE_FILES='kinvest.sqlite kinvest.sqlite-wal kinvest.sqlite-shm kinvest.sqlite-journal'
  DATA_RECLAIMED='false'
  MIGRATION_COMPLETE='false'
  FUSER_TEMP_FILES=''

  if [ "$DATA_DIR" != "$MIGRATION_ROOT/data" ] || [ "$STATE_DIR" != "$MIGRATION_ROOT/state" ]; then
    printf '%s\n' 'Kinvest migration paths must be rooted under the supplied migration root.' >&2
    return 2
  fi

  if [ "$("$ID_COMMAND" -u)" -ne 0 ]; then
    printf '%s\n' 'Kinvest data UID migration must run as root.' >&2
    return 1
  fi

  for REQUIRED_COMMAND in \
    "$ID_COMMAND" \
    "$DOCKER_COMMAND" \
    "$FLOCK_COMMAND" \
    "$STAT_COMMAND" \
    "$FUSER_COMMAND" \
    "$MKTEMP_COMMAND" \
    "$RM_COMMAND" \
    "$SETPRIV_COMMAND" \
    "$CHOWN_COMMAND" \
    "$CHMOD_COMMAND" \
    "$SHELL_COMMAND"; do
    if [ ! -x "$REQUIRED_COMMAND" ]; then
      printf '%s\n' "Required Kinvest migration command is not executable: $REQUIRED_COMMAND" >&2
      return 1
    fi
  done

  assert_no_symlink_path() {
    SYMLINK_CANDIDATE=$1
    case "$SYMLINK_CANDIDATE" in
      /*)
        ;;
      *)
        printf '%s\n' "Refusing non-absolute migration path: $SYMLINK_CANDIDATE" >&2
        return 1
        ;;
    esac

    SYMLINK_CURRENT=''
    SYMLINK_REMAINDER=${SYMLINK_CANDIDATE#/}
    SYMLINK_OLD_IFS=$IFS
    IFS='/'
    for SYMLINK_COMPONENT in $SYMLINK_REMAINDER; do
      SYMLINK_CURRENT="$SYMLINK_CURRENT/$SYMLINK_COMPONENT"
      if [ -L "$SYMLINK_CURRENT" ]; then
        IFS=$SYMLINK_OLD_IFS
        printf '%s\n' "Refusing symlinked migration path: $SYMLINK_CURRENT" >&2
        return 1
      fi
    done
    IFS=$SYMLINK_OLD_IFS
  }

  assert_migration_paths() {
    assert_no_symlink_path "$MIGRATION_ROOT"
    assert_no_symlink_path "$STATE_DIR"
    assert_no_symlink_path "$DATA_DIR"
    assert_no_symlink_path "$LOCK_FILE"
  }

  assert_migration_paths

  if [ ! -d "$STATE_DIR" ]; then
    printf '%s\n' "Kinvest state directory is missing: $STATE_DIR" >&2
    return 1
  fi

  exec 9>"$LOCK_FILE"
  if ! "$FLOCK_COMMAND" -n 9; then
    printf '%s\n' 'another Kinvest deployment or migration is already running' >&2
    return 1
  fi

  assert_migration_paths

  if [ ! -e "$DATA_DIR" ]; then
    printf '%s\n' 'Kinvest data directory is absent; no legacy UID migration is required.'
    return 0
  fi

  if [ ! -d "$DATA_DIR" ]; then
    printf '%s\n' "Kinvest data path is not a directory: $DATA_DIR" >&2
    return 1
  fi

  cd -P -- "$DATA_DIR"
  if [ "$(pwd -P)" != "$DATA_DIR" ]; then
    printf '%s\n' "Refusing unexpected physical data directory: $(pwd -P)" >&2
    return 1
  fi

  cleanup_fuser_temp_files() {
    TEMP_CLEANUP_OK='true'
    for TEMP_FILE in $FUSER_TEMP_FILES; do
      if ! "$RM_COMMAND" -f -- "$TEMP_FILE"; then
        TEMP_CLEANUP_OK='false'
      fi
    done
    FUSER_TEMP_FILES=''
    [ "$TEMP_CLEANUP_OK" = 'true' ]
  }

  finish_migration() {
    STATUS=$1
    trap - EXIT HUP INT TERM

    if ! cleanup_fuser_temp_files; then
      printf '%s\n' 'Unable to clean up Kinvest fuser verification files; manual intervention is required.' >&2
      STATUS=125
    fi

    if [ "$DATA_RECLAIMED" = 'true' ] && [ "$MIGRATION_COMPLETE" != 'true' ]; then
      RESTORE_OK='true'

      if ! "$CHOWN_COMMAND" root:root -- .; then
        RESTORE_OK='false'
      fi
      if ! "$CHMOD_COMMAND" 0700 -- .; then
        RESTORE_OK='false'
      fi

      RESTORED_OWNER=''
      RESTORED_MODE=''
      if ! RESTORED_OWNER=$("$STAT_COMMAND" -c '%u:%g' -- .); then
        RESTORE_OK='false'
      fi
      if ! RESTORED_MODE=$("$STAT_COMMAND" -c '%a' -- .); then
        RESTORE_OK='false'
      fi

      if [ "$RESTORED_OWNER" != '0:0' ] || [ "$RESTORED_MODE" != '700' ]; then
        RESTORE_OK='false'
      fi

      if [ "$RESTORE_OK" = 'true' ]; then
        printf '%s\n' \
          'Kinvest migration did not complete; data remains root-only and manual intervention is required.' >&2
        if [ "$STATUS" -eq 0 ]; then
          STATUS=124
        fi
      else
        printf '%s\n' \
          'Cannot verify root-only after migration failure; manual intervention is required.' >&2
        STATUS=125
      fi
    fi

    exit "$STATUS"
  }

  trap 'finish_migration "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  CONTAINER_IDS=$("$DOCKER_COMMAND" ps -aq --no-trunc)
  for CONTAINER_ID in $CONTAINER_IDS; do
    MOUNT_SOURCES=$(
      "$DOCKER_COMMAND" inspect --type container \
        --format '{{range .Mounts}}{{println .Source}}{{end}}' "$CONTAINER_ID"
    )
    CONTAINER_USES_DATA='false'

    while IFS= read -r MOUNT_SOURCE; do
      if [ "$MOUNT_SOURCE" = "$DATA_DIR" ]; then
        CONTAINER_USES_DATA='true'
      fi
    done <<EOF
$MOUNT_SOURCES
EOF

    if [ "$CONTAINER_USES_DATA" = 'true' ]; then
      CONTAINER_STATUS=$(
        "$DOCKER_COMMAND" inspect --type container --format '{{.State.Status}}' "$CONTAINER_ID"
      )
      CONTAINER_NAME=$(
        "$DOCKER_COMMAND" inspect --type container --format '{{.Name}}' "$CONTAINER_ID"
      )
      CONTAINER_NAME=${CONTAINER_NAME#/}

      if [ "$CONTAINER_STATUS" != 'exited' ]; then
        printf '%s\n' \
          "Container $CONTAINER_NAME is $CONTAINER_STATUS and mounts $DATA_DIR; stop it before migration." >&2
        return 1
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

    umask 077
    FUSER_STDOUT=$("$MKTEMP_COMMAND" "$STATE_DIR/.kinvest-fuser-stdout.XXXXXXXXXX")
    FUSER_TEMP_FILES="$FUSER_TEMP_FILES $FUSER_STDOUT"
    FUSER_STDERR=$("$MKTEMP_COMMAND" "$STATE_DIR/.kinvest-fuser-stderr.XXXXXXXXXX")
    FUSER_TEMP_FILES="$FUSER_TEMP_FILES $FUSER_STDERR"

    FUSER_STATUS=0
    if "$FUSER_COMMAND" "$SQLITE_FILE" >"$FUSER_STDOUT" 2>"$FUSER_STDERR"; then
      FUSER_STATUS=0
    else
      FUSER_STATUS=$?
    fi

    FUSER_STDOUT_HAS_DATA='false'
    FUSER_STDERR_HAS_DATA='false'
    [ ! -s "$FUSER_STDOUT" ] || FUSER_STDOUT_HAS_DATA='true'
    [ ! -s "$FUSER_STDERR" ] || FUSER_STDERR_HAS_DATA='true'

    if [ "$FUSER_STATUS" -eq 1 ] &&
      [ "$FUSER_STDOUT_HAS_DATA" = 'false' ] &&
      [ "$FUSER_STDERR_HAS_DATA" = 'false' ]; then
      :
    elif [ "$FUSER_STATUS" -eq 0 ] &&
      [ "$FUSER_STDOUT_HAS_DATA" = 'true' ] &&
      [ "$FUSER_STDERR_HAS_DATA" = 'false' ]; then
      cleanup_fuser_temp_files
      printf '%s\n' "SQLite file has an open file handle: $SQLITE_FILE" >&2
      return 1
    else
      cleanup_fuser_temp_files
      printf '%s\n' "Unable to verify open file handles for: $SQLITE_FILE" >&2
      return 1
    fi

    if ! cleanup_fuser_temp_files; then
      printf '%s\n' 'Unable to clean up fuser verification files.' >&2
      return 1
    fi
  done

  "$CHOWN_COMMAND" root:root -- .
  "$CHMOD_COMMAND" 0700 -- .
  DATA_RECLAIMED='true'

  if [ "$("$STAT_COMMAND" -c '%u:%g' -- .)" != '0:0' ] ||
    [ "$("$STAT_COMMAND" -c '%a' -- .)" != '700' ]; then
    printf '%s\n' 'Failed to isolate the Kinvest data directory as root-only.' >&2
    return 1
  fi

  PRESENT_SQLITE_FILES=''

  for SQLITE_FILE in $SQLITE_FILES; do
    if [ ! -e "$SQLITE_FILE" ] && [ ! -L "$SQLITE_FILE" ]; then
      continue
    fi

    if [ -L "$SQLITE_FILE" ]; then
      printf '%s\n' "Refusing symlinked SQLite file: $SQLITE_FILE" >&2
      return 1
    fi

    FILE_TYPE=$("$STAT_COMMAND" -c '%F' -- "$SQLITE_FILE")
    case "$FILE_TYPE" in
      'regular file'|'regular empty file')
        ;;
      *)
        printf '%s\n' "Refusing non-regular SQLite file: $SQLITE_FILE" >&2
        return 1
        ;;
    esac

    LINK_COUNT=$("$STAT_COMMAND" -c '%h' -- "$SQLITE_FILE")
    if [ "$LINK_COUNT" -ne 1 ]; then
      printf '%s\n' "Refusing SQLite file with multiple hard links: $SQLITE_FILE" >&2
      return 1
    fi

    FILE_OWNER=$("$STAT_COMMAND" -c '%u:%g' -- "$SQLITE_FILE")
    case "$FILE_OWNER" in
      "$APP_UID:$APP_GID"|"$LEGACY_UID:$LEGACY_GID")
        ;;
      *)
        printf '%s\n' "Refusing SQLite file with unexpected owner $FILE_OWNER: $SQLITE_FILE" >&2
        return 1
        ;;
    esac

    PRESENT_SQLITE_FILES="$PRESENT_SQLITE_FILES $SQLITE_FILE"
  done

  for SQLITE_FILE in $PRESENT_SQLITE_FILES; do
    FILE_OWNER=$("$STAT_COMMAND" -c '%u:%g' -- "$SQLITE_FILE")
    if [ "$FILE_OWNER" = "$LEGACY_UID:$LEGACY_GID" ]; then
      "$CHOWN_COMMAND" "$APP_UID:$APP_GID" -- "$SQLITE_FILE"
    elif [ "$FILE_OWNER" != "$APP_UID:$APP_GID" ]; then
      printf '%s\n' "SQLite file owner changed during migration: $SQLITE_FILE" >&2
      return 1
    fi

    "$CHMOD_COMMAND" 0600 -- "$SQLITE_FILE"

    if [ "$("$STAT_COMMAND" -c '%u:%g' -- "$SQLITE_FILE")" != "$APP_UID:$APP_GID" ] ||
      [ "$("$STAT_COMMAND" -c '%a' -- "$SQLITE_FILE")" != '600' ]; then
      printf '%s\n' "SQLite file migration verification failed: $SQLITE_FILE" >&2
      return 1
    fi
  done

  "$CHOWN_COMMAND" "$APP_UID:$APP_GID" -- .
  "$CHMOD_COMMAND" 0750 -- .

  "$SETPRIV_COMMAND" --reuid="$APP_UID" --regid="$APP_GID" --clear-groups \
    "$SHELL_COMMAND" -c '
      for SQLITE_FILE do
        if [ ! -r "$SQLITE_FILE" ] || [ ! -w "$SQLITE_FILE" ]; then
          exit 1
        fi
        exec 3<> "$SQLITE_FILE"
        exec 3>&-
      done
    ' sh $PRESENT_SQLITE_FILES

  if [ "$("$STAT_COMMAND" -c '%u:%g' -- .)" != "$APP_UID:$APP_GID" ] ||
    [ "$("$STAT_COMMAND" -c '%a' -- .)" != '750' ]; then
    printf '%s\n' 'Kinvest data directory final ownership verification failed.' >&2
    return 1
  fi

  for SQLITE_FILE in $PRESENT_SQLITE_FILES; do
    if [ "$("$STAT_COMMAND" -c '%F' -- "$SQLITE_FILE")" != 'regular file' ] &&
      [ "$("$STAT_COMMAND" -c '%F' -- "$SQLITE_FILE")" != 'regular empty file' ]; then
      printf '%s\n' "Final SQLite file type verification failed: $SQLITE_FILE" >&2
      return 1
    fi
    if [ "$("$STAT_COMMAND" -c '%h' -- "$SQLITE_FILE")" -ne 1 ] ||
      [ "$("$STAT_COMMAND" -c '%u:%g' -- "$SQLITE_FILE")" != "$APP_UID:$APP_GID" ] ||
      [ "$("$STAT_COMMAND" -c '%a' -- "$SQLITE_FILE")" != '600' ]; then
      printf '%s\n' "Final SQLite file state verification failed: $SQLITE_FILE" >&2
      return 1
    fi
  done

  MIGRATION_COMPLETE='true'
  printf '%s\n' "Kinvest offline data UID migration completed for UID:GID $APP_UID:$APP_GID."
}

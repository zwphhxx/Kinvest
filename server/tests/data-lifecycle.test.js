const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const migrationLibraryPath = path.join(rootDir, 'deploy/server/migrate-data-uid-lib.sh')
const migrationWrapperPath = path.join(rootDir, 'deploy/server/migrate-data-uid.sh')

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 })
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function runInstalledProductionWrapper() {
  const rawFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-migration-wrapper-'))
  const fixtureRoot = fs.realpathSync(rawFixtureRoot)
  const kinvestRoot = path.join(fixtureRoot, 'kinvest')
  const stateDir = path.join(kinvestRoot, 'state')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const attackerRoot = path.join(fixtureRoot, 'attacker')

  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(fakeBin)
  fs.copyFileSync(migrationLibraryPath, path.join(kinvestRoot, 'migrate-data-uid-lib.sh'))

  const adapterSource = `#!/bin/sh
case "\${0##*/}" in
  id)
    [ "$#" -eq 1 ] && [ "$1" = '-u' ] || exit 90
    printf '%s\\n' '0'
    ;;
  flock)
    [ "$#" -eq 2 ] && [ "$1" = '-n' ] && [ "$2" = '9' ] || exit 91
    ;;
esac
`
  const adapterPaths = {}
  for (const name of [
    'id',
    'docker',
    'flock',
    'stat',
    'fuser',
    'mktemp',
    'rm',
    'setpriv',
    'chown',
    'chmod'
  ]) {
    const adapterPath = path.join(fakeBin, name)
    writeExecutable(adapterPath, adapterSource)
    adapterPaths[name] = adapterPath
  }

  const replacements = new Map([
    ['/root/docker/kinvest', kinvestRoot],
    ['/usr/bin/id', adapterPaths.id],
    ['/usr/bin/docker', adapterPaths.docker],
    ['/usr/bin/flock', adapterPaths.flock],
    ['/usr/bin/stat', adapterPaths.stat],
    ['/usr/sbin/fuser', adapterPaths.fuser],
    ['/usr/bin/mktemp', adapterPaths.mktemp],
    ['/usr/bin/rm', adapterPaths.rm],
    ['/usr/bin/setpriv', adapterPaths.setpriv],
    ['/usr/bin/chown', adapterPaths.chown],
    ['/usr/bin/chmod', adapterPaths.chmod]
  ])
  let installedWrapper = fs.readFileSync(migrationWrapperPath, 'utf8')
  for (const [productionValue, fixtureValue] of replacements) {
    installedWrapper = installedWrapper.split(productionValue).join(fixtureValue)
  }

  const installedWrapperPath = path.join(fixtureRoot, 'migrate-data-uid.sh')
  writeExecutable(installedWrapperPath, installedWrapper)
  const result = spawnSync(installedWrapperPath, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: path.join(attackerRoot, 'data'),
      KINVEST_FIXED_DATA_DIR: path.join(attackerRoot, 'fixed-data'),
      KINVEST_FIXED_MIGRATION_ROOT: attackerRoot,
      KINVEST_FIXED_STATE_DIR: path.join(attackerRoot, 'fixed-state'),
      MIGRATION_ROOT: attackerRoot,
      STATE_DIR: path.join(attackerRoot, 'state')
    }
  })

  return {
    attackerRoot,
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    lockPath: path.join(stateDir, 'deploy.lock'),
    result
  }
}

function runMigrationCore({
  containers = [],
  files,
  flockConflict = false,
  fuserResult = 'clear',
  restoreFailure = '',
  signalAfterFinal = ''
}) {
  const rawFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-migration-core-'))
  const fixtureRoot = fs.realpathSync(rawFixtureRoot)
  const kinvestRoot = path.join(fixtureRoot, 'kinvest')
  const dataDir = path.join(kinvestRoot, 'data')
  const stateDir = path.join(kinvestRoot, 'state')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const modelDir = path.join(fixtureRoot, 'model')
  const operationLog = path.join(modelDir, 'operations.log')
  const unrelatedPath = path.join(dataDir, 'family-notes.txt')

  for (const directory of [dataDir, stateDir, fakeBin, modelDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  fs.writeFileSync(path.join(modelDir, 'directory.owner'), '1000:1000\n')
  fs.writeFileSync(path.join(modelDir, 'directory.mode'), '750\n')
  fs.writeFileSync(path.join(modelDir, 'fuser.result'), `${fuserResult}\n`)
  fs.writeFileSync(path.join(modelDir, 'restore.failure'), `${restoreFailure}\n`)
  fs.writeFileSync(path.join(modelDir, 'signal.after-final'), `${signalAfterFinal}\n`)
  fs.writeFileSync(path.join(modelDir, 'container.ids'), containers.map(({ id }) => id).join('\n'))
  if (flockConflict) {
    fs.writeFileSync(path.join(modelDir, 'flock.conflict'), '')
  }

  fs.writeFileSync(unrelatedPath, 'unrelated family data', { mode: 0o640 })
  const unrelatedBefore = fs.statSync(unrelatedPath)
  const unrelatedHashBefore = fileHash(unrelatedPath)

  for (const file of files) {
    const filePath = path.join(dataDir, file.name)
    fs.writeFileSync(filePath, file.content || file.name, { mode: file.mode || 0o640 })
    fs.writeFileSync(path.join(modelDir, `${file.name}.owner`), `${file.owner || '1000:1000'}\n`)
    fs.writeFileSync(path.join(modelDir, `${file.name}.mode`), `${(file.mode || 0o640).toString(8)}\n`)
    fs.writeFileSync(path.join(modelDir, `${file.name}.links`), '1\n')
    fs.writeFileSync(path.join(modelDir, `${file.name}.type`), 'regular file\n')
  }

  for (const container of containers) {
    fs.writeFileSync(path.join(modelDir, `${container.id}.name`), `${container.name}\n`)
    fs.writeFileSync(path.join(modelDir, `${container.id}.status`), `${container.status}\n`)
    fs.writeFileSync(
      path.join(modelDir, `${container.id}.mounts`),
      `${(container.mounts || [dataDir]).join('\n')}\n`
    )
  }

  writeExecutable(
    path.join(fakeBin, 'id'),
    `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = '-u' ] || exit 90
printf '%s\\n' '0'
`
  )

  writeExecutable(
    path.join(fakeBin, 'flock'),
    `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = '-n' ] && [ "$2" = '9' ] || exit 91
printf '%s\\n' 'flock -n 9' >> "$KINVEST_TEST_MODEL/operations.log"
[ ! -f "$KINVEST_TEST_MODEL/flock.conflict" ]
`
  )

  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
set -eu
printf 'docker' >> "$KINVEST_TEST_MODEL/operations.log"
for argument in "$@"; do printf ' %s' "$argument" >> "$KINVEST_TEST_MODEL/operations.log"; done
printf '\\n' >> "$KINVEST_TEST_MODEL/operations.log"

if [ "$#" -eq 3 ] && [ "$1" = 'ps' ] && [ "$2" = '-aq' ] && [ "$3" = '--no-trunc' ]; then
  cat "$KINVEST_TEST_MODEL/container.ids"
  exit 0
fi

if [ "$#" -eq 6 ] && [ "$1" = 'inspect' ] && [ "$2" = '--type' ] &&
  [ "$3" = 'container' ] && [ "$4" = '--format' ]; then
  format="$5"
  container_id="$6"
  case "$format" in
    '{{range .Mounts}}{{println .Source}}{{end}}')
      cat "$KINVEST_TEST_MODEL/$container_id.mounts"
      ;;
    '{{.State.Status}}')
      cat "$KINVEST_TEST_MODEL/$container_id.status"
      ;;
    '{{.Name}}')
      cat "$KINVEST_TEST_MODEL/$container_id.name"
      ;;
    *)
      exit 92
      ;;
  esac
  exit 0
fi

exit 93
`
  )

  writeExecutable(
    path.join(fakeBin, 'fuser'),
    `#!/bin/sh
[ "$#" -eq 1 ] || exit 94
case "$1" in
  kinvest.sqlite|kinvest.sqlite-wal|kinvest.sqlite-shm|kinvest.sqlite-journal) ;;
  *) exit 95 ;;
esac
printf '%s\\n' "fuser $1" >> "$KINVEST_TEST_MODEL/operations.log"
case "$(cat "$KINVEST_TEST_MODEL/fuser.result")" in
  clear) exit 1 ;;
  busy) printf '%s\\n' '4321'; exit 0 ;;
  exit1-stderr) printf '%s\\n' 'diagnostic' >&2; exit 1 ;;
  exit1-stdout) printf '%s\\n' 'contradiction'; exit 1 ;;
  exit0-empty) exit 0 ;;
  error) exit 2 ;;
  *) exit 96 ;;
esac
`
  )

  writeExecutable(
    path.join(fakeBin, 'mktemp'),
    `#!/bin/sh
[ "$#" -eq 1 ] || exit 114
case "$1" in
  "$KINVEST_TEST_STATE"/.kinvest-fuser-*.XXXXXXXXXX) ;;
  *) exit 115 ;;
esac
printf '%s\\n' "mktemp $1" >> "$KINVEST_TEST_MODEL/operations.log"
exec /usr/bin/mktemp "$1"
`
  )

  writeExecutable(
    path.join(fakeBin, 'rm'),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = '-f' ] && [ "$2" = '--' ] || exit 116
case "$3" in
  "$KINVEST_TEST_STATE"/.kinvest-fuser-*) ;;
  *) exit 117 ;;
esac
printf '%s\\n' "rm -f -- $3" >> "$KINVEST_TEST_MODEL/operations.log"
exec /bin/rm -f "$3"
`
  )

  writeExecutable(
    path.join(fakeBin, 'chown'),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$2" = '--' ] || exit 97
owner="$1"
target="$3"
case "$target" in
  .)
    case "$owner" in root:root) owner='0:0' ;; 10001:10001) ;; *) exit 98 ;; esac
    if [ "$owner" = '0:0' ] && [ -f "$KINVEST_TEST_MODEL/final-handoff" ]; then
      : > "$KINVEST_TEST_MODEL/restore-started"
      [ "$(cat "$KINVEST_TEST_MODEL/restore.failure")" != 'chown' ] || exit 118
    fi
    printf '%s\\n' "$owner" > "$KINVEST_TEST_MODEL/directory.owner"
    if [ "$owner" = '10001:10001' ]; then
      : > "$KINVEST_TEST_MODEL/final-handoff"
    fi
    ;;
  kinvest.sqlite|kinvest.sqlite-wal|kinvest.sqlite-shm|kinvest.sqlite-journal)
    [ "$owner" = '10001:10001' ] || exit 99
    [ -f "$KINVEST_TEST_MODEL/$target.owner" ] || exit 100
    printf '%s\\n' "$owner" > "$KINVEST_TEST_MODEL/$target.owner"
    ;;
  *)
    exit 101
    ;;
esac
printf '%s\\n' "chown $1 -- $target" >> "$KINVEST_TEST_MODEL/operations.log"
if [ "$target" = '.' ] && [ "$owner" = '10001:10001' ]; then
  signal="$(cat "$KINVEST_TEST_MODEL/signal.after-final")"
  [ -z "$signal" ] || kill "-$signal" "$PPID"
fi
`
  )

  writeExecutable(
    path.join(fakeBin, 'chmod'),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$2" = '--' ] || exit 102
mode="$1"
target="$3"
case "$target:$mode" in
  .:0700)
    if [ -f "$KINVEST_TEST_MODEL/restore-started" ]; then
      [ "$(cat "$KINVEST_TEST_MODEL/restore.failure")" != 'chmod' ] || exit 119
    fi
    stored_mode='700'
    ;;
  .:0750) stored_mode='750' ;;
  kinvest.sqlite:0600|kinvest.sqlite-wal:0600|kinvest.sqlite-shm:0600|kinvest.sqlite-journal:0600)
    [ -f "$KINVEST_TEST_MODEL/$target.mode" ] || exit 103
    stored_mode='600'
    ;;
  *)
    exit 104
    ;;
esac
if [ "$target" = '.' ]; then
  printf '%s\\n' "$stored_mode" > "$KINVEST_TEST_MODEL/directory.mode"
else
  printf '%s\\n' "$stored_mode" > "$KINVEST_TEST_MODEL/$target.mode"
fi
/bin/chmod "$mode" "$target"
printf '%s\\n' "chmod $mode -- $target" >> "$KINVEST_TEST_MODEL/operations.log"
`
  )

  writeExecutable(
    path.join(fakeBin, 'stat'),
    `#!/bin/sh
[ "$#" -eq 4 ] && [ "$1" = '-c' ] && [ "$3" = '--' ] || exit 105
format="$2"
target="$4"
if [ "$target" = '.' ]; then
  case "$format" in
    '%F') printf '%s\\n' 'directory' ;;
    '%u:%g'|'%a')
      if [ -f "$KINVEST_TEST_MODEL/restore-started" ] &&
        [ "$(cat "$KINVEST_TEST_MODEL/restore.failure")" = 'stat' ]; then
        exit 120
      fi
      if [ "$format" = '%u:%g' ]; then
        cat "$KINVEST_TEST_MODEL/directory.owner"
      else
        cat "$KINVEST_TEST_MODEL/directory.mode"
      fi
      ;;
    *) exit 106 ;;
  esac
  exit 0
fi
case "$target" in
  kinvest.sqlite|kinvest.sqlite-wal|kinvest.sqlite-shm|kinvest.sqlite-journal) ;;
  *) exit 107 ;;
esac
[ -f "$KINVEST_TEST_MODEL/$target.owner" ] || exit 108
case "$format" in
  '%F') cat "$KINVEST_TEST_MODEL/$target.type" ;;
  '%h') cat "$KINVEST_TEST_MODEL/$target.links" ;;
  '%u:%g') cat "$KINVEST_TEST_MODEL/$target.owner" ;;
  '%a') cat "$KINVEST_TEST_MODEL/$target.mode" ;;
  *) exit 109 ;;
esac
`
  )

  writeExecutable(
    path.join(fakeBin, 'setpriv'),
    `#!/bin/sh
[ "$#" -ge 7 ] || exit 110
[ "$1" = '--reuid=10001' ] && [ "$2" = '--regid=10001' ] &&
  [ "$3" = '--clear-groups' ] && [ "$4" = '/bin/sh' ] && [ "$5" = '-c' ] || exit 111
[ "$(cat "$KINVEST_TEST_MODEL/directory.owner")" = '10001:10001' ] || exit 112
for model_file in "$KINVEST_TEST_MODEL"/kinvest.sqlite*.owner; do
  [ "$(cat "$model_file")" = '10001:10001' ] || exit 113
done
printf '%s\\n' 'setpriv 10001:10001' >> "$KINVEST_TEST_MODEL/operations.log"
shift 3
exec "$@"
`
  )

  const harnessPath = path.join(fixtureRoot, 'run-migration-core.sh')
  writeExecutable(
    harnessPath,
    `#!/bin/sh
set -eu
. "$1"
shift
kinvest_migrate_data_uid "$@"
`
  )

  const result = spawnSync(
    harnessPath,
    [
      migrationLibraryPath,
      kinvestRoot,
      dataDir,
      stateDir,
      path.join(fakeBin, 'id'),
      path.join(fakeBin, 'docker'),
      path.join(fakeBin, 'flock'),
      path.join(fakeBin, 'stat'),
      path.join(fakeBin, 'fuser'),
      path.join(fakeBin, 'mktemp'),
      path.join(fakeBin, 'rm'),
      path.join(fakeBin, 'setpriv'),
      path.join(fakeBin, 'chown'),
      path.join(fakeBin, 'chmod'),
      '/bin/sh'
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KINVEST_TEST_MODEL: modelDir,
        KINVEST_TEST_STATE: stateDir
      }
    }
  )

  return {
    cleanup() {
      fs.chmodSync(dataDir, 0o700)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    dataDir,
    directoryModel() {
      return {
        mode: fs.readFileSync(path.join(modelDir, 'directory.mode'), 'utf8').trim(),
        owner: fs.readFileSync(path.join(modelDir, 'directory.owner'), 'utf8').trim()
      }
    },
    fileModel(name) {
      return {
        mode: fs.readFileSync(path.join(modelDir, `${name}.mode`), 'utf8').trim(),
        owner: fs.readFileSync(path.join(modelDir, `${name}.owner`), 'utf8').trim()
      }
    },
    operationLines() {
      return fs.existsSync(operationLog)
        ? fs.readFileSync(operationLog, 'utf8').trim().split('\n').filter(Boolean)
        : []
    },
    result,
    snapshot(name) {
      const filePath = path.join(dataDir, name)
      const fileStat = fs.statSync(filePath)
      return {
        hash: fileHash(filePath),
        mode: fileStat.mode & 0o777
      }
    },
    unrelatedAfter() {
      const fileStat = fs.statSync(unrelatedPath)
      return {
        gid: fileStat.gid,
        hash: fileHash(unrelatedPath),
        mode: fileStat.mode & 0o777,
        uid: fileStat.uid
      }
    },
    unrelatedBefore: {
      gid: unrelatedBefore.gid,
      hash: unrelatedHashBefore,
      mode: unrelatedBefore.mode & 0o777,
      uid: unrelatedBefore.uid
    }
  }
}

function assertNoFileMutation(fixture, before) {
  assert.deepEqual(fixture.snapshot('kinvest.sqlite'), before)
  assert.equal(fixture.operationLines().some((line) => /^(?:chown|chmod)/.test(line)), false)
}

function run() {
  assert.equal(fs.existsSync(migrationLibraryPath), true, 'the executable migration core library must exist')
  assert.equal(fs.existsSync(migrationWrapperPath), true, 'the production migration wrapper must exist')

  const productionWrapper = runInstalledProductionWrapper()
  try {
    assert.equal(productionWrapper.result.status, 0, productionWrapper.result.stderr)
    assert.doesNotMatch(productionWrapper.result.stderr, /readonly variable|read only/i)
    assert.equal(fs.existsSync(productionWrapper.lockPath), true)
    assert.equal(fs.existsSync(productionWrapper.attackerRoot), false)
  } finally {
    productionWrapper.cleanup()
  }

  for (const status of ['running', 'paused', 'restarting']) {
    const mountedSameSource = runMigrationCore({
      containers: [{ id: `same-${status}`, name: `arbitrary-${status}-name`, status }],
      files: [{ name: 'kinvest.sqlite', content: `before-${status}` }]
    })
    const sameSourceBefore = mountedSameSource.snapshot('kinvest.sqlite')
    try {
      assert.equal(mountedSameSource.result.status, 1)
      assert.match(mountedSameSource.result.stderr, new RegExp(`arbitrary-${status}-name.*${status}`))
      assertNoFileMutation(mountedSameSource, sameSourceBefore)
      assert.match(
        mountedSameSource.operationLines().join('\n'),
        /docker inspect --type container --format \{\{range \.Mounts\}\}/
      )
    } finally {
      mountedSameSource.cleanup()
    }
  }

  for (const fuserResult of [
    'busy',
    'exit1-stderr',
    'exit1-stdout',
    'exit0-empty',
    'error'
  ]) {
    const occupied = runMigrationCore({
      files: [{ name: 'kinvest.sqlite', content: `before-${fuserResult}` }],
      fuserResult
    })
    const before = occupied.snapshot('kinvest.sqlite')
    try {
      assert.equal(occupied.result.status, 1)
      assert.match(
        occupied.result.stderr,
        fuserResult === 'busy' ? /open file handle/i : /Unable to verify open file handles/
      )
      assertNoFileMutation(occupied, before)
      assert.equal(
        occupied.operationLines().filter((line) => line.startsWith('mktemp ')).length,
        2
      )
      assert.equal(
        occupied.operationLines().filter((line) => line.startsWith('rm -f -- ')).length,
        2
      )
    } finally {
      occupied.cleanup()
    }
  }

  const success = runMigrationCore({
    files: [
      { name: 'kinvest.sqlite', content: 'main database bytes' },
      { name: 'kinvest.sqlite-wal', content: 'wal bytes' },
      { name: 'kinvest.sqlite-shm', content: 'shm bytes' }
    ]
  })
  try {
    assert.equal(success.result.status, 0, success.result.stderr)
    for (const name of ['kinvest.sqlite', 'kinvest.sqlite-wal', 'kinvest.sqlite-shm']) {
      assert.deepEqual(success.fileModel(name), { mode: '600', owner: '10001:10001' })
      assert.equal(success.snapshot(name).mode, 0o600)
    }
    assert.deepEqual(success.directoryModel(), { mode: '750', owner: '10001:10001' })
    assert.deepEqual(success.unrelatedAfter(), success.unrelatedBefore)

    const operations = success.operationLines()
    const reclaimIndex = operations.indexOf('chown root:root -- .')
    const firstFileChownIndex = operations.indexOf('chown 10001:10001 -- kinvest.sqlite')
    const finalDirectoryIndex = operations.indexOf('chown 10001:10001 -- .')
    assert.ok(reclaimIndex >= 0 && firstFileChownIndex > reclaimIndex)
    assert.ok(finalDirectoryIndex > firstFileChownIndex)
  } finally {
    success.cleanup()
  }

  const lateFailure = runMigrationCore({
    files: [
      { name: 'kinvest.sqlite', owner: '1000:1000' },
      { name: 'kinvest.sqlite-wal', owner: '2000:2000' }
    ]
  })
  try {
    assert.equal(lateFailure.result.status, 1)
    assert.deepEqual(lateFailure.directoryModel(), { mode: '700', owner: '0:0' })
    assert.equal(
      lateFailure.operationLines().some((line) => line === 'chown 10001:10001 -- kinvest.sqlite'),
      false
    )
    assert.match(lateFailure.result.stderr, /manual intervention/i)
  } finally {
    lateFailure.cleanup()
  }

  const lockConflict = runMigrationCore({
    files: [{ name: 'kinvest.sqlite', content: 'locked bytes' }],
    flockConflict: true
  })
  const lockedBefore = lockConflict.snapshot('kinvest.sqlite')
  try {
    assert.equal(lockConflict.result.status, 1)
    assertNoFileMutation(lockConflict, lockedBefore)
    assert.deepEqual(lockConflict.operationLines(), ['flock -n 9'])
  } finally {
    lockConflict.cleanup()
  }

  /** @type {Array<[string, number]>} */
  const signalCases = [
    ['HUP', 129],
    ['INT', 130],
    ['TERM', 143]
  ]

  for (const [signal, expectedStatus] of signalCases) {
    const interrupted = runMigrationCore({
      files: [{ name: 'kinvest.sqlite' }],
      signalAfterFinal: signal
    })
    try {
      assert.equal(interrupted.result.status, expectedStatus)
      assert.deepEqual(interrupted.directoryModel(), { mode: '700', owner: '0:0' })
      assert.match(interrupted.result.stderr, /data remains root-only/i)
    } finally {
      interrupted.cleanup()
    }
  }

  for (const restoreFailure of ['chown', 'chmod', 'stat']) {
    const failedRestore = runMigrationCore({
      files: [{ name: 'kinvest.sqlite' }],
      restoreFailure,
      signalAfterFinal: 'TERM'
    })
    try {
      assert.equal(failedRestore.result.status, 125)
      assert.match(failedRestore.result.stderr, /cannot verify root-only|无法验证root-only/i)
      assert.doesNotMatch(failedRestore.result.stderr, /data remains root-only/i)
    } finally {
      failedRestore.cleanup()
    }
  }
}

module.exports = { run }

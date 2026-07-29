const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 })
}

function readRootFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

function runMigrationFixture({ containers = [], files, busyFile = '' }) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-offline-migration-'))
  const fixtureDataDir = path.join(fixtureRoot, 'data')
  const stateDir = path.join(fixtureRoot, 'state')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const fakeState = path.join(fixtureRoot, 'fake-state')

  fs.mkdirSync(fixtureDataDir)
  fs.mkdirSync(stateDir)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(fakeState)

  const dataDir = fs.realpathSync(fixtureDataDir)
  const unrelatedPath = path.join(dataDir, 'family-notes.txt')
  fs.writeFileSync(unrelatedPath, 'untouched', { mode: 0o640 })

  for (const file of files) {
    const filePath = path.join(dataDir, file.name)
    if (file.kind === 'symlink') {
      const target = path.join(fixtureRoot, `${file.name}.target`)
      fs.writeFileSync(target, file.content || 'target')
      fs.symlinkSync(target, filePath)
      continue
    }

    fs.writeFileSync(filePath, file.content || file.name, { mode: 0o640 })
    fs.writeFileSync(path.join(fakeState, `${file.name}.owner`), `${file.owner || '1000:1000'}\n`)
    fs.writeFileSync(path.join(fakeState, `${file.name}.links`), `${file.kind === 'hardlink' ? 2 : 1}\n`)
    if (file.kind === 'hardlink') {
      fs.linkSync(filePath, path.join(dataDir, `${file.name}.other-link`))
    }
  }

  fs.writeFileSync(path.join(fakeState, 'container-ids'), containers.map(({ id }) => id).join('\n'))
  for (const container of containers) {
    fs.writeFileSync(path.join(fakeState, `${container.id}.name`), `${container.name}\n`)
    fs.writeFileSync(path.join(fakeState, `${container.id}.status`), `${container.status}\n`)
    fs.writeFileSync(path.join(fakeState, `${container.id}.mount`), `${container.mountSource || dataDir}\n`)
  }
  fs.writeFileSync(path.join(fakeState, 'busy-file'), busyFile)

  writeExecutable(
    path.join(fakeBin, 'id'),
    '#!/bin/sh\n[ "${1:-}" = "-u" ] && { printf "%s\\n" 0; exit 0; }\nexec /usr/bin/id "$@"\n'
  )
  writeExecutable(
    path.join(fakeBin, 'flock'),
    '#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = "-n" ] && [ "$2" = "9" ]\n'
  )
  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MIGRATION_FAKE_STATE/docker.log"
if [ "$#" -eq 3 ] && [ "$1" = 'ps' ] && [ "$2" = '-aq' ] && [ "$3" = '--no-trunc' ]; then
  cat "$MIGRATION_FAKE_STATE/container-ids"
  exit 0
fi
if [ "$#" -eq 6 ] && [ "$1" = 'inspect' ] && [ "$2" = '--type' ] && [ "$3" = 'container' ] && [ "$4" = '--format' ]; then
  format="$5"
  id="$6"
  case "$format" in
    '{{range .Mounts}}{{println .Source}}{{end}}') cat "$MIGRATION_FAKE_STATE/$id.mount" ;;
    '{{.State.Status}}') cat "$MIGRATION_FAKE_STATE/$id.status" ;;
    '{{.Name}}') cat "$MIGRATION_FAKE_STATE/$id.name" ;;
    *) exit 94 ;;
  esac
  exit 0
fi
exit 95
`
  )
  writeExecutable(
    path.join(fakeBin, 'fuser'),
    `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = '-s' ] || exit 96
[ "\${2##*/}" = "$(cat "$MIGRATION_FAKE_STATE/busy-file")" ] && exit 0
exit 1
`
  )
  writeExecutable(
    path.join(fakeBin, 'chown'),
    `#!/bin/sh
owner="$1"
target=''
for argument in "$@"; do target="$argument"; done
printf '%s %s\\n' "$owner" "$target" >> "$MIGRATION_FAKE_STATE/chown.log"
base="\${target##*/}"
if [ "$target" = '.' ]; then
  if [ "$owner" = 'root:root' ]; then
    printf '%s\\n' '0:0' > "$MIGRATION_FAKE_STATE/directory.owner"
  else
    printf '%s\\n' "$owner" > "$MIGRATION_FAKE_STATE/directory.owner"
  fi
elif [ "$owner" = '10001:10001' ]; then
  : > "$MIGRATION_FAKE_STATE/$base.migrated"
fi
`
  )
  writeExecutable(
    path.join(fakeBin, 'chmod'),
    `#!/bin/sh
mode="$1"
shift
[ "\${1:-}" = '--' ] && shift
exec /bin/chmod "$mode" "$@"
`
  )
  writeExecutable(
    path.join(fakeBin, 'stat'),
    `#!/bin/sh
format=''
target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-c' ]; then
    shift
    format="$1"
  elif [ "$1" != '--' ]; then
    target="$1"
  fi
  shift
done
base="\${target##*/}"
case "$format" in
  '%F') [ "$target" = '.' ] && printf '%s\\n' directory || printf '%s\\n' 'regular empty file' ;;
  '%h') cat "$MIGRATION_FAKE_STATE/$base.links" ;;
  '%a')
    if [ "$target" = '.' ]; then
      mode="$(/usr/bin/stat -f '%Lp' .)"
      printf '%s\\n' "$mode"
    else
      mode="$(/usr/bin/stat -f '%Lp' "$target")"
      printf '%s\\n' "$mode"
    fi
    ;;
  '%u:%g')
    if [ "$target" = '.' ]; then
      cat "$MIGRATION_FAKE_STATE/directory.owner"
    elif [ -f "$MIGRATION_FAKE_STATE/$base.migrated" ]; then
      printf '%s\\n' '10001:10001'
    else
      cat "$MIGRATION_FAKE_STATE/$base.owner"
    fi
    ;;
  *) exit 97 ;;
esac
`
  )
  writeExecutable(
    path.join(fakeBin, 'setpriv'),
    `#!/bin/sh
[ "$(cat "$MIGRATION_FAKE_STATE/directory.owner")" = '10001:10001' ] || exit 98
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reuid=*|--regid=*|--clear-groups) shift ;;
    *) exec "$@" ;;
  esac
done
exit 99
`
  )

  fs.writeFileSync(path.join(fakeState, 'directory.owner'), '1000:1000\n')

  const migrationSource = readRootFile('deploy/server/migrate-data-uid.sh')
    .replace("DATA_DIR='/root/docker/kinvest/data'", `DATA_DIR='${dataDir}'`)
    .replace("STATE_DIR='/root/docker/kinvest/state'", `STATE_DIR='${stateDir}'`)
  const scriptPath = path.join(fixtureRoot, 'migrate-data-uid.sh')
  writeExecutable(scriptPath, migrationSource)

  const unrelatedBefore = fs.statSync(unrelatedPath)
  const result = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MIGRATION_FAKE_STATE: fakeState
    }
  })

  return {
    chownLog() {
      const logPath = path.join(fakeState, 'chown.log')
      return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
    },
    cleanup() {
      fs.chmodSync(dataDir, 0o700)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    dataDir,
    result,
    unrelatedBefore,
    unrelatedPath
  }
}

function run() {
  const migrationSource = readRootFile('deploy/server/migrate-data-uid.sh')
  const reclaimIndex = migrationSource.indexOf('chown root:root -- .')
  const preflightIndex = migrationSource.indexOf("stat -c '%F'")
  const fileMigrationIndex = migrationSource.indexOf('chown "$APP_UID:$APP_GID" -- "$SQLITE_FILE"')

  assert.ok(reclaimIndex >= 0)
  assert.ok(preflightIndex > reclaimIndex, 'SQLite lstat checks must happen after root reclaims the directory')
  assert.ok(fileMigrationIndex > preflightIndex, 'all metadata preflight must precede file migration')
  assert.match(migrationSource, /manual intervention/i)
  assert.doesNotMatch(migrationSource, /\b(?:find|xargs|chown\s+-R|chmod\s+-R)\b/)

  const success = runMigrationFixture({
    files: [
      { name: 'kinvest.sqlite', content: 'main content' },
      { name: 'kinvest.sqlite-wal', content: 'wal content' },
      { name: 'kinvest.sqlite-shm', content: 'shm content' }
    ]
  })
  try {
    assert.equal(success.result.status, 0, success.result.stderr)
    assert.equal(fs.readFileSync(path.join(success.dataDir, 'kinvest.sqlite'), 'utf8'), 'main content')
    assert.equal(fs.readFileSync(path.join(success.dataDir, 'kinvest.sqlite-wal'), 'utf8'), 'wal content')
    assert.equal(fs.readFileSync(path.join(success.dataDir, 'kinvest.sqlite-shm'), 'utf8'), 'shm content')
    for (const name of ['kinvest.sqlite', 'kinvest.sqlite-wal', 'kinvest.sqlite-shm']) {
      assert.equal(fs.statSync(path.join(success.dataDir, name)).mode & 0o777, 0o600)
      assert.ok(success.chownLog().includes(`10001:10001 ${name}`))
    }
    const unrelatedAfter = fs.statSync(success.unrelatedPath)
    assert.equal(unrelatedAfter.uid, success.unrelatedBefore.uid)
    assert.equal(unrelatedAfter.gid, success.unrelatedBefore.gid)
    assert.equal(unrelatedAfter.mode & 0o777, success.unrelatedBefore.mode & 0o777)
    assert.equal(success.chownLog().some((line) => line.endsWith('family-notes.txt')), false)
    assert.equal(success.chownLog().at(-1), '10001:10001 .')
  } finally {
    success.cleanup()
  }

  for (const status of ['running', 'paused', 'restarting']) {
    const mounted = runMigrationFixture({
      containers: [{ id: `container-${status}`, name: 'unrelated-preview-name', status }],
      files: [{ name: 'kinvest.sqlite' }]
    })
    try {
      assert.equal(mounted.result.status, 1)
      assert.match(mounted.result.stderr, new RegExp(`unrelated-preview-name.*${status}`))
      assert.deepEqual(mounted.chownLog(), [])
    } finally {
      mounted.cleanup()
    }
  }

  const fullPreflight = runMigrationFixture({
    files: [
      { name: 'kinvest.sqlite', owner: '1000:1000' },
      { name: 'kinvest.sqlite-wal', owner: '2000:2000' }
    ]
  })
  try {
    assert.equal(fullPreflight.result.status, 1)
    assert.match(fullPreflight.result.stderr, /unexpected owner 2000:2000/)
    assert.equal(fullPreflight.chownLog().some((line) => line.endsWith('kinvest.sqlite')), false)
    assert.equal(fullPreflight.chownLog().at(-1), 'root:root .')
  } finally {
    fullPreflight.cleanup()
  }

  for (const file of [
    { name: 'kinvest.sqlite', kind: 'symlink' },
    { name: 'kinvest.sqlite', kind: 'hardlink' }
  ]) {
    const unsafeLink = runMigrationFixture({ files: [file] })
    try {
      assert.equal(unsafeLink.result.status, 1)
      assert.match(unsafeLink.result.stderr, /(?:symlink|hard link)/i)
      assert.equal(unsafeLink.chownLog().some((line) => line.endsWith('kinvest.sqlite')), false)
      assert.equal(unsafeLink.chownLog().at(-1), 'root:root .')
    } finally {
      unsafeLink.cleanup()
    }
  }

  const busy = runMigrationFixture({
    files: [{ name: 'kinvest.sqlite' }],
    busyFile: 'kinvest.sqlite'
  })
  try {
    assert.equal(busy.result.status, 1)
    assert.match(busy.result.stderr, /open file handle/i)
    assert.deepEqual(busy.chownLog(), [])
  } finally {
    busy.cleanup()
  }
}

module.exports = { run }

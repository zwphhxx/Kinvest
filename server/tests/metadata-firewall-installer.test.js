const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const manifestRelativePath = 'deploy/server/metadata-firewall-assets.sha256'
const assets = [
  {
    id: 'library',
    source: 'deploy/server/kinvest-metadata-firewall-lib.sh',
    target: '/usr/local/libexec/kinvest-metadata-firewall-lib.sh',
    mode: 0o755
  },
  {
    id: 'wrapper',
    source: 'deploy/server/kinvest-metadata-firewall.sh',
    target: '/usr/local/sbin/kinvest-metadata-firewall',
    mode: 0o755
  },
  {
    id: 'service',
    source: 'deploy/server/kinvest-metadata-firewall.service',
    target: '/etc/systemd/system/kinvest-metadata-firewall.service',
    mode: 0o644
  },
  {
    id: 'timer',
    source: 'deploy/server/kinvest-metadata-firewall.timer',
    target: '/etc/systemd/system/kinvest-metadata-firewall.timer',
    mode: 0o644
  },
  {
    id: 'drop-in',
    source: 'deploy/server/docker-kinvest-metadata-firewall.conf',
    target: '/etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf',
    mode: 0o644
  },
  {
    id: 'modules-load',
    source: 'deploy/server/kinvest-br-netfilter.modules-load.conf',
    target: '/etc/modules-load.d/kinvest-br-netfilter.conf',
    mode: 0o644
  },
  {
    id: 'sysctl',
    source: 'deploy/server/kinvest-br-netfilter.sysctl.conf',
    target: '/etc/sysctl.d/90-kinvest-br-netfilter.conf',
    mode: 0o644
  }
]

function write(filePath, contents, mode = 0o755) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, { mode })
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

function targetPath(context, asset) {
  return path.join(context.targetRoot, asset.target.slice(1))
}

function backupDirectories(context) {
  const root = path.join(context.targetRoot, 'var/backups/kinvest-metadata-firewall')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).filter((entry) => entry.startsWith('install-'))
}

function fakeCommands(bin) {
  write(
    path.join(bin, 'id'),
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = '-u' ]; then
  printf '%s\\n' "\${KINVEST_TEST_CALLER_UID:-${process.getuid()}}"
  exit 0
fi
exec /usr/bin/id "$@"
`
  )
  write(
    path.join(bin, 'sha256sum'),
    `#!/bin/sh
set -eu
if [ "\${1:-}" = '-c' ]; then
  manifest=$2
  while IFS=' ' read -r expected relative; do
    [ -n "$expected" ] || continue
    actual=$(/usr/bin/shasum -a 256 "$relative" | /usr/bin/awk '{print $1}')
    [ "$actual" = "$expected" ] || exit 1
  done < "$manifest"
  exit 0
fi
exec /usr/bin/shasum -a 256 "$@"
`
  )
  write(
    path.join(bin, 'modprobe'),
    `#!/bin/sh
printf 'modprobe:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
[ "\${KINVEST_TEST_FAIL_MODPROBE:-0}" != '1' ]
`
  )
  write(
    path.join(bin, 'sysctl'),
    `#!/bin/sh
printf 'sysctl:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
[ "\${KINVEST_TEST_FAIL_SYSCTL:-0}" != '1' ]
`
  )
  write(
    path.join(bin, 'systemctl'),
    `#!/bin/sh
printf 'systemctl:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
[ "\${KINVEST_TEST_FAIL_DAEMON_RELOAD:-0}" != '1' ]
`
  )
  write(
    path.join(bin, 'mv'),
    `#!/bin/sh
set -eu
[ "\${1:-}" = '-fT' ] && shift
[ "\${1:-}" = '--' ] && shift
exec /bin/mv -f "$@"
`
  )
}

function fixtureAssetContents(asset) {
  if (asset.id === 'library') return '#!/bin/sh\nkinvest_fixture_library=1\n'
  if (asset.id === 'wrapper') {
    return `#!/bin/sh
printf 'wrapper:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
[ "$#" -eq 1 ] && [ "$1" = 'verify-bridge-netfilter' ] || exit 91
[ "\${KINVEST_TEST_FAIL_VERIFIER:-0}" != '1' ]
`
  }
  if (asset.id === 'service') return '[Unit]\nDescription=fixture service\n'
  if (asset.id === 'timer') return '[Timer]\nOnUnitActiveSec=5min\n'
  if (asset.id === 'drop-in') return '[Service]\nExecStartPre=/bin/true\n'
  if (asset.id === 'modules-load') return 'br_netfilter\n'
  return 'net.bridge.bridge-nf-call-iptables = 1\n'
}

function createFixture(installer, { present = assets.map((asset) => asset.id) } = {}) {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-metadata-installer-')))
  const sourceRoot = path.join(fixture, 'verified-source')
  const targetRoot = path.join(fixture, 'target-root')
  const bin = path.join(fixture, 'bin')
  const operations = path.join(fixture, 'operations.log')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(targetRoot)
  fs.mkdirSync(bin)
  fs.writeFileSync(operations, '')
  fakeCommands(bin)

  for (const asset of assets) {
    const contents = fixtureAssetContents(asset)
    write(path.join(sourceRoot, asset.source), contents, asset.mode)
    if (present.includes(asset.id)) {
      write(targetPath({ targetRoot }, asset), `old-${asset.id}\n`, 0o600)
    }
  }
  const manifest = assets
    .map((asset) => {
      const contents = fs.readFileSync(path.join(sourceRoot, asset.source))
      return `${sha256(contents)}  ${asset.source}`
    })
    .join('\n') + '\n'
  write(path.join(sourceRoot, manifestRelativePath), manifest, 0o644)

  const securePath = `${bin}:${process.env.PATH}`
  const instrumented = installer
    .replace("TARGET_ROOT=''", `TARGET_ROOT='${targetRoot}'`)
    .replace("REQUIRED_UID='0'", `REQUIRED_UID='${process.getuid()}'`)
    .replace(
      "SECURE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
      `SECURE_PATH='${securePath}'`
    )
    .replace("INSTALL_OWNER='root'", `INSTALL_OWNER='${process.getuid()}'`)
    .replace("INSTALL_GROUP='root'", `INSTALL_GROUP='${process.getgid()}'`)
  assert.notEqual(instrumented, installer, 'test copy must redirect production targets')
  const script = path.join(fixture, 'install-metadata-firewall.sh')
  write(script, instrumented)
  return { fixture, sourceRoot, targetRoot, bin, operations, script }
}

function runInstaller(context, extraEnv = {}, sourceRoot = context.sourceRoot) {
  return spawnSync('/bin/sh', [context.script, sourceRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      KINVEST_TEST_OPERATIONS: context.operations
    }
  })
}

function operations(context) {
  return fs.readFileSync(context.operations, 'utf8')
}

function assertOriginalState(context, present) {
  for (const asset of assets) {
    const target = targetPath(context, asset)
    if (present.includes(asset.id)) {
      assert.equal(fs.readFileSync(target, 'utf8'), `old-${asset.id}\n`)
      assert.equal(fs.statSync(target).mode & 0o777, 0o600)
    } else {
      assert.equal(fs.existsSync(target), false, `${asset.id} should remain absent`)
    }
  }
}

function withFixture(context, callback) {
  try {
    callback()
  } finally {
    fs.rmSync(context.fixture, { recursive: true, force: true })
  }
}

async function run() {
  const installerPath = path.join(rootDir, 'deploy/server/install-metadata-firewall.sh')
  const installer = fs.readFileSync(installerPath, 'utf8')
  assert.notEqual(fs.statSync(installerPath).mode & 0o111, 0, 'installer must be executable')
  assert.match(installer, /^TARGET_ROOT=''$/m)
  assert.match(installer, /^SECURE_PATH='\/usr\/local\/sbin:.*\/usr\/bin:.*\/bin'$/m)
  assert.match(installer, /sha256sum -c/)
  assert.match(installer, /id -u/)
  assert.match(installer, /modprobe br_netfilter/)
  assert.match(installer, /sysctl --load/)
  assert.match(installer, /verify-bridge-netfilter/)
  assert.match(installer, /systemctl daemon-reload/)
  assert.doesNotMatch(installer, /systemctl\s+(?:start|restart|stop|enable)|docker\s|compose\s/)
  const runner = fs.readFileSync(path.join(rootDir, 'server/tests/run-tests.js'), 'utf8')
  assert.equal((runner.match(/require\('\.\/metadata-firewall-installer[.]test'\)/g) || []).length, 1)

  const success = createFixture(installer)
  withFixture(success, () => {
    const result = runInstaller(success)
    assert.equal(result.status, 0, result.stderr)
    for (const asset of assets) {
      assert.equal(
        fs.readFileSync(targetPath(success, asset), 'utf8'),
        fs.readFileSync(path.join(success.sourceRoot, asset.source), 'utf8')
      )
      assert.equal(fs.statSync(targetPath(success, asset)).mode & 0o777, asset.mode)
    }
    const log = operations(success)
    assert.match(log, /^modprobe:br_netfilter$/m)
    assert.match(log, new RegExp(`^sysctl:--load ${success.targetRoot}/etc/sysctl[.]d/90-kinvest-br-netfilter[.]conf$`, 'm'))
    assert.match(log, /^wrapper:verify-bridge-netfilter$/m)
    assert.match(log, /^systemctl:daemon-reload$/m)
    assert.doesNotMatch(log, /systemctl:(?:start|restart|stop|enable)|docker|compose/)
    assert.equal(backupDirectories(success).length, 1)
    const record = path.join(
      success.targetRoot,
      'var/backups/kinvest-metadata-firewall',
      backupDirectories(success)[0],
      'asset-state.tsv'
    )
    assert.equal(fs.statSync(record).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(record, 'utf8').trimEnd().split('\n').length, assets.length + 1)
  })

  const manifestMismatch = createFixture(installer)
  withFixture(manifestMismatch, () => {
    fs.appendFileSync(path.join(manifestMismatch.sourceRoot, assets[0].source), '# changed\n')
    const result = runInstaller(manifestMismatch)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=SOURCE_MANIFEST_INVALID backup=none/)
    assertOriginalState(manifestMismatch, assets.map((asset) => asset.id))
    assert.equal(backupDirectories(manifestMismatch).length, 0)
    assert.equal(operations(manifestMismatch), '')
  })

  const nonRoot = createFixture(installer)
  withFixture(nonRoot, () => {
    const result = runInstaller(nonRoot, { KINVEST_TEST_CALLER_UID: String(process.getuid() + 1) })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=ROOT_REQUIRED backup=none/)
    assertOriginalState(nonRoot, assets.map((asset) => asset.id))
    assert.equal(operations(nonRoot), '')
  })

  for (const failure of [
    { env: { KINVEST_TEST_FAIL_MODPROBE: '1' }, code: 'MODULE_LOAD_FAILED' },
    { env: { KINVEST_TEST_FAIL_SYSCTL: '1' }, code: 'SYSCTL_LOAD_FAILED' },
    { env: { KINVEST_TEST_FAIL_VERIFIER: '1' }, code: 'RUNTIME_VERIFY_FAILED' }
  ]) {
    const context = createFixture(installer)
    withFixture(context, () => {
      const result = runInstaller(context, failure.env)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=${failure.code} backup=`))
      assertOriginalState(context, assets.map((asset) => asset.id))
      assert.equal(backupDirectories(context).length, 1)
      assert.match(operations(context), /^systemctl:daemon-reload$/m)
      assert.doesNotMatch(operations(context), /systemctl:(?:start|restart|stop|enable)|docker|compose/)
    })
  }

  const mixedPresent = ['library', 'service', 'drop-in', 'sysctl']
  const rollback = createFixture(installer, { present: mixedPresent })
  withFixture(rollback, () => {
    const result = runInstaller(rollback, { KINVEST_TEST_FAIL_DAEMON_RELOAD: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=DAEMON_RELOAD_FAILED backup=/)
    assertOriginalState(rollback, mixedPresent)
    assert.equal(backupDirectories(rollback).length, 1)
    const record = path.join(
      rollback.targetRoot,
      'var/backups/kinvest-metadata-firewall',
      backupDirectories(rollback)[0],
      'asset-state.tsv'
    )
    const states = fs.readFileSync(record, 'utf8')
    for (const asset of assets) {
      assert.match(states, new RegExp(`^${asset.id}\\t${mixedPresent.includes(asset.id) ? 'present' : 'absent'}\\t`, 'm'))
    }
  })

  const sourceSymlink = createFixture(installer)
  withFixture(sourceSymlink, () => {
    const source = path.join(sourceSymlink.sourceRoot, assets[0].source)
    const real = `${source}.real`
    fs.renameSync(source, real)
    fs.symlinkSync(real, source)
    assert.notEqual(runInstaller(sourceSymlink).status, 0)
    assertOriginalState(sourceSymlink, assets.map((asset) => asset.id))
  })

  const targetSymlink = createFixture(installer, { present: assets.filter((asset) => asset.id !== 'wrapper').map((asset) => asset.id) })
  withFixture(targetSymlink, () => {
    const victim = path.join(targetSymlink.fixture, 'victim')
    const wrapperTarget = targetPath(targetSymlink, assets.find((asset) => asset.id === 'wrapper'))
    write(victim, 'do-not-touch\n', 0o600)
    fs.mkdirSync(path.dirname(wrapperTarget), { recursive: true })
    fs.symlinkSync(victim, wrapperTarget)
    assert.notEqual(runInstaller(targetSymlink).status, 0)
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-touch\n')
    assert.equal(fs.lstatSync(wrapperTarget).isSymbolicLink(), true)
  })
}

module.exports = { run }

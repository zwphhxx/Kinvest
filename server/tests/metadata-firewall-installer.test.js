const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const productionFdIdentitySupported = process.platform === 'linux' && fs.existsSync('/proc/self/fd')
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
    path.join(bin, 'stat'),
    `#!/bin/sh
if [ "\${1:-}" = '-Lc' ]; then
  printf 'stat-dereference:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
  if /usr/bin/stat -c '%d:%i' "$KINVEST_TEST_RUNTIME_SYSCTL" >/dev/null 2>&1; then
    exec /usr/bin/stat "$@"
  fi
  exec /usr/bin/stat -f '%d:%i' "$KINVEST_TEST_RUNTIME_SYSCTL"
fi
exec /usr/bin/stat "$@"
`
  )
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
  if [ -n "\${KINVEST_TEST_SWAP_AFTER_MANIFEST:-}" ]; then
    /bin/cp "$KINVEST_TEST_SWAP_CONTENT" "$KINVEST_TEST_SWAP_AFTER_MANIFEST"
  fi
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
counter_file="$KINVEST_TEST_OPERATIONS.sysctl-count"
count=0
[ ! -f "$counter_file" ] || count=$(cat "$counter_file")
count=$((count + 1))
printf '%s\\n' "$count" > "$counter_file"
if [ -n "\${KINVEST_TEST_RUNTIME_SYSCTL:-}" ]; then
  printf '1\\n' > "$KINVEST_TEST_RUNTIME_SYSCTL"
fi
if [ "\${KINVEST_TEST_REMOVE_MODULE_ON_SYSCTL_CALL:-0}" = "$count" ] && [ -n "\${KINVEST_TEST_RUNTIME_MODULE_PATH:-}" ]; then
  /bin/rm -rf "$KINVEST_TEST_RUNTIME_MODULE_PATH"
fi
[ "\${KINVEST_TEST_FAIL_SYSCTL:-0}" != '1' ]
`
  )
  write(
    path.join(bin, 'systemctl'),
    `#!/bin/sh
printf 'systemctl:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
if [ -n "\${KINVEST_TEST_INTERLOCK_PATH:-}" ]; then
  interlock_state=absent
  [ ! -f "$KINVEST_TEST_INTERLOCK_PATH" ] || interlock_state=present
  printf 'systemctl-interlock:%s\\n' "$interlock_state" >> "$KINVEST_TEST_OPERATIONS"
fi
counter_file="$KINVEST_TEST_OPERATIONS.systemctl-count"
count=0
[ ! -f "$counter_file" ] || count=$(cat "$counter_file")
count=$((count + 1))
printf '%s\\n' "$count" > "$counter_file"
[ -z "\${KINVEST_TEST_FAIL_DAEMON_RELOAD_ON:-}" ] || case ",$KINVEST_TEST_FAIL_DAEMON_RELOAD_ON," in
  *",$count,"*) exit 1 ;;
esac
[ "\${KINVEST_TEST_FAIL_DAEMON_RELOAD:-0}" != '1' ] || exit 1
[ "$count" -gt "\${KINVEST_TEST_FAIL_DAEMON_RELOAD_COUNT:-0}" ]
`
  )
  write(
    path.join(bin, 'mv'),
    `#!/bin/sh
set -eu
[ "\${1:-}" = '-fT' ] && shift
[ "\${1:-}" = '--' ] && shift
[ -z "\${KINVEST_TEST_FAIL_MV_MATCH:-}" ] || case "$*" in
  *"$KINVEST_TEST_FAIL_MV_MATCH"*) exit 1 ;;
esac
exec /bin/mv -f "$@"
`
  )
  write(path.join(bin, 'sync'), '#!/bin/sh\nexit 0\n')
  write(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
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

function originalAssetContents(asset) {
  if (asset.id === 'library') return '#!/bin/sh\nkinvest_original_library=1\n'
  if (asset.id === 'wrapper') {
    return `#!/bin/sh
printf 'original-wrapper:%s\\n' "$*" >> "$KINVEST_TEST_OPERATIONS"
[ "$#" -eq 1 ] && [ "$1" = 'verify-bridge-netfilter' ] || exit 92
[ "$(cat "$KINVEST_TEST_RUNTIME_SYSCTL")" = '1' ]
`
  }
  if (asset.id === 'sysctl') return 'net.bridge.bridge-nf-call-iptables = 1\n'
  return `old-${asset.id}\n`
}

function createFixture(installer, {
  present = assets.map((asset) => asset.id),
  productionFdIdentity = productionFdIdentitySupported
} = {}) {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-metadata-installer-')))
  const sourceRoot = path.join(fixture, 'verified-source')
  const targetRoot = path.join(fixture, 'target-root')
  const bin = path.join(fixture, 'bin')
  const lockRoot = path.join(fixture, 'run-lock')
  const operations = path.join(fixture, 'operations.log')
  const runtimeSysctl = path.join(targetRoot, 'proc/sys/net/bridge/bridge-nf-call-iptables')
  const runtimeModule = path.join(targetRoot, 'sys/module/br_netfilter')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(targetRoot)
  fs.mkdirSync(bin)
  fs.mkdirSync(lockRoot)
  fs.chmodSync(sourceRoot, 0o755)
  fs.chmodSync(targetRoot, 0o755)
  fs.writeFileSync(operations, '')
  fakeCommands(bin)

  for (const asset of assets) {
    const contents = fixtureAssetContents(asset)
    write(path.join(sourceRoot, asset.source), contents, asset.mode)
    if (present.includes(asset.id)) {
      write(targetPath({ targetRoot }, asset), originalAssetContents(asset), asset.mode)
    }
  }
  write(runtimeSysctl, '1\n', 0o644)
  fs.mkdirSync(runtimeModule, { recursive: true })
  const manifest = assets
    .map((asset) => {
      const contents = fs.readFileSync(path.join(sourceRoot, asset.source))
      return `${sha256(contents)}  ${asset.source}`
    })
    .join('\n') + '\n'
  write(path.join(sourceRoot, manifestRelativePath), manifest, 0o644)

  const securePath = `${bin}:${process.env.PATH}`
  let instrumented = installer
    .replace("TARGET_ROOT=''", `TARGET_ROOT='${targetRoot}'`)
    .replace("SECURITY_ROOT='/'", `SECURITY_ROOT='${fixture}'`)
    .replace("TRUSTED_UID='0'", `TRUSTED_UID='${process.getuid()}'`)
    .replace("TRUSTED_GID='0'", `TRUSTED_GID='${process.getgid()}'`)
    .replace("LOCK_ROOT='/run/lock'", `LOCK_ROOT='${lockRoot}'`)
    .replace(
      "RUNTIME_SYSCTL_PATH='/proc/sys/net/bridge/bridge-nf-call-iptables'",
      `RUNTIME_SYSCTL_PATH='${runtimeSysctl}'`
    )
    .replace("RUNTIME_MODULE_PATH='/sys/module/br_netfilter'", `RUNTIME_MODULE_PATH='${runtimeModule}'`)
    .replace("REQUIRED_UID='0'", `REQUIRED_UID='${process.getuid()}'`)
    .replace(
      "SECURE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
      `SECURE_PATH='${securePath}'`
    )
    .replace("INSTALL_OWNER='root'", `INSTALL_OWNER='${process.getuid()}'`)
    .replace("INSTALL_GROUP='root'", `INSTALL_GROUP='${process.getgid()}'`)
  if (!productionFdIdentity) {
    instrumented = instrumented
      .replace("RUNTIME_FD_ROOT='/proc/self/fd'", "RUNTIME_FD_ROOT='/dev/fd'")
      .replace("RUNTIME_FD_IDENTITY_MODE='device-inode'", "RUNTIME_FD_IDENTITY_MODE='inode-only'")
  }
  assert.notEqual(instrumented, installer, 'test copy must redirect production targets')
  const script = path.join(fixture, 'install-metadata-firewall.sh')
  write(script, instrumented)
  return { fixture, sourceRoot, targetRoot, bin, lockRoot, operations, runtimeSysctl, runtimeModule, script }
}

function runInstaller(context, extraEnv = {}, sourceRoot = context.sourceRoot) {
  return spawnSync('/bin/sh', [context.script, sourceRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      KINVEST_TEST_OPERATIONS: context.operations,
      KINVEST_TEST_INTERLOCK_PATH: interlockPath(context),
      KINVEST_TEST_RUNTIME_SYSCTL: context.runtimeSysctl,
      KINVEST_TEST_RUNTIME_MODULE_PATH: context.runtimeModule
    }
  })
}

function operations(context) {
  return fs.readFileSync(context.operations, 'utf8')
}

function interlockPath(context) {
  return path.join(
    context.targetRoot,
    'etc/systemd/system/docker.service.d/00-kinvest-metadata-recovery-interlock.conf'
  )
}

function assertInterlock(context) {
  const interlock = interlockPath(context)
  assert.equal(fs.readFileSync(interlock, 'utf8'), '[Service]\nExecStartPre=/bin/false\n')
  assert.equal(fs.statSync(interlock).mode & 0o777, 0o644)
  const command = fs.readFileSync(interlock, 'utf8').match(/^ExecStartPre=(.+)$/m)[1]
  const blocked = spawnSync(command, [], { encoding: 'utf8' })
  assert.notEqual(blocked.status, 0)
}

function transactionPhases(context) {
  return backupDirectories(context)
    .map((entry) => path.join(context.targetRoot, 'var/backups/kinvest-metadata-firewall', entry, 'phase'))
    .filter((entry) => fs.existsSync(entry))
    .map((entry) => fs.readFileSync(entry, 'utf8').trim())
}

function assertOriginalState(context, present) {
  for (const asset of assets) {
    const target = targetPath(context, asset)
    if (present.includes(asset.id)) {
      assert.equal(fs.readFileSync(target, 'utf8'), originalAssetContents(asset))
      assert.equal(fs.statSync(target).mode & 0o777, asset.mode)
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
  assert.match(installer, /# TEST_FAULT_POINT_BEFORE_FIRST_RUNTIME_REPLACE/)
  assert.doesNotMatch(installer, /systemctl\s+(?:start|restart|stop|enable)|docker\s|compose\s/)
  const runner = fs.readFileSync(path.join(rootDir, 'server/tests/run-tests.js'), 'utf8')
  assert.equal((runner.match(/require\('\.\/metadata-firewall-installer[.]test'\)/g) || []).length, 1)
  assert.match(runner, /process[.]env[.]PYTHONDONTWRITEBYTECODE = '1'/)
  assert.match(runner, /deploy\/server\/__pycache__/)
  assert.match(runner, /fs[.]rmSync\(pythonBytecodeCachePath, \{ recursive: true, force: true \}\)/)

  const success = createFixture(installer)
  const successScript = fs.readFileSync(success.script, 'utf8')
  if (productionFdIdentitySupported) {
    assert.match(successScript, /^RUNTIME_FD_ROOT='\/proc\/self\/fd'$/m)
    assert.match(successScript, /^RUNTIME_FD_IDENTITY_MODE='device-inode'$/m)
  } else {
    assert.match(successScript, /^RUNTIME_FD_ROOT='\/dev\/fd'$/m)
    assert.match(successScript, /^RUNTIME_FD_IDENTITY_MODE='inode-only'$/m)
  }
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
    assert.deepEqual(
      [...log.matchAll(/^systemctl-interlock:(present|absent)$/gm)].map((match) => match[1]),
      ['present', 'present', 'absent']
    )
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
      assertInterlock(context)
      assert.deepEqual(transactionPhases(context), ['operator-required'])
      if (failure.code !== 'MODULE_LOAD_FAILED') {
        assert.doesNotMatch(operations(context), /^original-wrapper:verify-bridge-netfilter$/m)
        assert.equal(fs.readFileSync(context.runtimeSysctl, 'utf8'), '1\n')
      }
      assert.doesNotMatch(operations(context), /systemctl:(?:start|restart|stop|enable)|docker|compose/)
    })
  }

  const unsafePriorRuntime = createFixture(installer)
  withFixture(unsafePriorRuntime, () => {
    fs.writeFileSync(unsafePriorRuntime.runtimeSysctl, '0\n')
    const result = runInstaller(unsafePriorRuntime, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=PRIOR_RUNTIME_UNSAFE preserved=1/
    )
    assert.equal(fs.readFileSync(unsafePriorRuntime.runtimeSysctl, 'utf8'), '1\n')
    assert.doesNotMatch(operations(unsafePriorRuntime), /^original-wrapper:verify-bridge-netfilter$/m)
    assertOriginalState(unsafePriorRuntime, assets.map((asset) => asset.id))
    assertInterlock(unsafePriorRuntime)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=operator-required daemon_reload=ok phase=operator-required/
    )
    assert.match(result.stderr, /rollback=failed:RECOVERY_OPERATOR_REQUIRED/)
    assert.deepEqual(transactionPhases(unsafePriorRuntime), ['operator-required'])
  })

  const productionFdIdentity = createFixture(installer, { productionFdIdentity: true })
  withFixture(productionFdIdentity, () => {
    const result = runInstaller(productionFdIdentity, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(result.status, 0)
    assert.match(
      operations(productionFdIdentity),
      /^stat-dereference:-Lc %d:%i \/proc\/self\/fd\/8$/m
    )
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=ok daemon_reload=ok phase=operator-required/
    )
    assertInterlock(productionFdIdentity)
  })

  const interlockDaemonReloadFailure = createFixture(installer)
  withFixture(interlockDaemonReloadFailure, () => {
    const result = runInstaller(interlockDaemonReloadFailure, {
      KINVEST_TEST_FAIL_DAEMON_RELOAD_ON: '1'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=INTERLOCK_DAEMON_RELOAD_FAILED/)
    assertInterlock(interlockDaemonReloadFailure)
    assertOriginalState(interlockDaemonReloadFailure, assets.map((asset) => asset.id))
    assert.doesNotMatch(operations(interlockDaemonReloadFailure), /^(?:modprobe|sysctl|wrapper):/m)
    assert.deepEqual(transactionPhases(interlockDaemonReloadFailure), [])
  })

  const absentPriorSysctl = createFixture(installer, {
    present: assets.filter((asset) => !['wrapper', 'sysctl'].includes(asset.id)).map((asset) => asset.id)
  })
  withFixture(absentPriorSysctl, () => {
    const result = runInstaller(absentPriorSysctl, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=PRIOR_CONFIG_ABSENT preserved=1/
    )
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=operator-required daemon_reload=ok phase=operator-required/
    )
    assert.match(result.stderr, /rollback=failed:RECOVERY_OPERATOR_REQUIRED/)
    assert.equal(fs.readFileSync(absentPriorSysctl.runtimeSysctl, 'utf8'), '1\n')
    assert.equal(fs.existsSync(targetPath(absentPriorSysctl, assets.find((asset) => asset.id === 'sysctl'))), false)
    assert.equal(fs.existsSync(targetPath(absentPriorSysctl, assets.find((asset) => asset.id === 'wrapper'))), false)
    assert.equal((operations(absentPriorSysctl).match(/^systemctl:daemon-reload$/gm) || []).length, 2)
    assertInterlock(absentPriorSysctl)
    assert.deepEqual(transactionPhases(absentPriorSysctl), ['operator-required'])
  })

  const unsafePriorSysctl = createFixture(installer)
  withFixture(unsafePriorSysctl, () => {
    const sysctlTarget = targetPath(unsafePriorSysctl, assets.find((asset) => asset.id === 'sysctl'))
    const wrapperTarget = targetPath(unsafePriorSysctl, assets.find((asset) => asset.id === 'wrapper'))
    fs.writeFileSync(sysctlTarget, 'net.bridge.bridge-nf-call-iptables = 0\n')
    write(wrapperTarget, '#!/bin/sh\nexit 99\n', 0o755)
    const result = runInstaller(unsafePriorSysctl, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=PRIOR_CONFIG_UNSAFE preserved=1/
    )
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=operator-required daemon_reload=ok phase=operator-required/
    )
    assert.match(result.stderr, /rollback=failed:RECOVERY_OPERATOR_REQUIRED/)
    assert.equal(fs.readFileSync(unsafePriorSysctl.runtimeSysctl, 'utf8'), '1\n')
    assert.equal(fs.readFileSync(sysctlTarget, 'utf8'), 'net.bridge.bridge-nf-call-iptables = 0\n')
    assert.equal(fs.readFileSync(wrapperTarget, 'utf8'), '#!/bin/sh\nexit 99\n')
    assertInterlock(unsafePriorSysctl)
    assert.deepEqual(transactionPhases(unsafePriorSysctl), ['operator-required'])
  })

  const reloadFailedPriorSysctl = createFixture(installer)
  withFixture(reloadFailedPriorSysctl, () => {
    const result = runInstaller(reloadFailedPriorSysctl, { KINVEST_TEST_FAIL_SYSCTL: '1' })
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=PRIOR_CONFIG_RELOAD_FAILED preserved=1/
    )
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=operator-required daemon_reload=ok phase=operator-required/
    )
    assert.equal(fs.readFileSync(reloadFailedPriorSysctl.runtimeSysctl, 'utf8'), '1\n')
    assertInterlock(reloadFailedPriorSysctl)
    assert.deepEqual(transactionPhases(reloadFailedPriorSysctl), ['operator-required'])
  })

  const operatorRecoveryDaemonFailure = createFixture(installer, {
    present: assets.filter((asset) => !['wrapper', 'sysctl'].includes(asset.id)).map((asset) => asset.id)
  })
  withFixture(operatorRecoveryDaemonFailure, () => {
    const result = runInstaller(operatorRecoveryDaemonFailure, {
      KINVEST_TEST_FAIL_VERIFIER: '1',
      KINVEST_TEST_FAIL_DAEMON_RELOAD_ON: '2,3'
    })
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=operator-required daemon_reload=failed phase=operator-required/
    )
    assert.match(result.stderr, /rollback=failed:RECOVERY_INCOMPLETE/)
    assertInterlock(operatorRecoveryDaemonFailure)
    assert.deepEqual(transactionPhases(operatorRecoveryDaemonFailure), ['operator-required'])
  })

  const aggregatedRecoveryFailure = createFixture(installer)
  withFixture(aggregatedRecoveryFailure, () => {
    const result = runInstaller(aggregatedRecoveryFailure, {
      KINVEST_TEST_FAIL_DAEMON_RELOAD_ON: '2,3',
      KINVEST_TEST_REMOVE_MODULE_ON_SYSCTL_CALL: '2'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=DAEMON_RELOAD_FAILED/)
    assert.match(
      result.stderr,
      /KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=ok runtime=failed daemon_reload=failed phase=operator-required/
    )
    assert.match(result.stderr, /rollback=failed:RECOVERY_INCOMPLETE/)
    assert.equal((operations(aggregatedRecoveryFailure).match(/^systemctl:daemon-reload$/gm) || []).length, 3)
    assertOriginalState(aggregatedRecoveryFailure, assets.map((asset) => asset.id))
    assert.equal(fs.readFileSync(aggregatedRecoveryFailure.runtimeSysctl, 'utf8'), '1\n')
    assertInterlock(aggregatedRecoveryFailure)
  })

  const laterSafeRerun = createFixture(installer, {
    present: assets.filter((asset) => !['wrapper', 'sysctl'].includes(asset.id)).map((asset) => asset.id)
  })
  withFixture(laterSafeRerun, () => {
    const first = runInstaller(laterSafeRerun, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(first.status, 0)
    assertInterlock(laterSafeRerun)
    const second = runInstaller(laterSafeRerun)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(fs.existsSync(interlockPath(laterSafeRerun)), false)
    assert.deepEqual(transactionPhases(laterSafeRerun).sort(), ['committed', 'superseded'])
    assert.deepEqual(
      [...operations(laterSafeRerun).matchAll(/^systemctl-interlock:(present|absent)$/gm)].map((match) => match[1]),
      ['present', 'present', 'present', 'present', 'absent']
    )
  })

  const safeRetryIndependentVerifier = createFixture(installer, {
    present: assets.filter((asset) => !['wrapper', 'sysctl'].includes(asset.id)).map((asset) => asset.id)
  })
  withFixture(safeRetryIndependentVerifier, () => {
    const first = runInstaller(safeRetryIndependentVerifier, { KINVEST_TEST_FAIL_VERIFIER: '1' })
    assert.notEqual(first.status, 0)
    assertInterlock(safeRetryIndependentVerifier)
    fs.mkdirSync(safeRetryIndependentVerifier.runtimeModule, { recursive: true })
    fs.writeFileSync(`${safeRetryIndependentVerifier.operations}.sysctl-count`, '0\n')
    const second = runInstaller(safeRetryIndependentVerifier, {
      KINVEST_TEST_REMOVE_MODULE_ON_SYSCTL_CALL: '1'
    })
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /code=RUNTIME_VERIFY_FAILED/)
    assert.match(operations(safeRetryIndependentVerifier), /^wrapper:verify-bridge-netfilter$/m)
    assertInterlock(safeRetryIndependentVerifier)
    assert.ok(transactionPhases(safeRetryIndependentVerifier).includes('operator-required'))
  })

  const sourceRace = createFixture(installer)
  withFixture(sourceRace, () => {
    const source = path.join(sourceRace.sourceRoot, assets[0].source)
    const replacement = path.join(sourceRace.fixture, 'replacement-library')
    write(replacement, '#!/bin/sh\nprintf changed\\n\n')
    const result = runInstaller(sourceRace, {
      KINVEST_TEST_SWAP_AFTER_MANIFEST: source,
      KINVEST_TEST_SWAP_CONTENT: replacement
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=SOURCE_SNAPSHOT_HASH_MISMATCH/)
    assertOriginalState(sourceRace, assets.map((asset) => asset.id))
  })

  const writableSource = createFixture(installer)
  withFixture(writableSource, () => {
    fs.chmodSync(writableSource.sourceRoot, 0o775)
    const result = runInstaller(writableSource)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=SOURCE_PATH_UNSAFE/)
    assertOriginalState(writableSource, assets.map((asset) => asset.id))
  })

  const hardlinkedSource = createFixture(installer)
  withFixture(hardlinkedSource, () => {
    const source = path.join(hardlinkedSource.sourceRoot, assets[2].source)
    fs.linkSync(source, `${source}.unexpected-hardlink`)
    const result = runInstaller(hardlinkedSource)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=SOURCE_ASSET_UNSAFE/)
    assertOriginalState(hardlinkedSource, assets.map((asset) => asset.id))
  })

  const writableParent = createFixture(installer)
  withFixture(writableParent, () => {
    const unsafeParent = path.join(writableParent.targetRoot, 'etc/systemd')
    fs.chmodSync(unsafeParent, 0o777)
    const result = runInstaller(writableParent)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=TARGET_PATH_UNSAFE/)
    assertOriginalState(writableParent, assets.map((asset) => asset.id))
  })

  const mixedPresent = ['library', 'service', 'drop-in', 'sysctl']
  const rollback = createFixture(installer, { present: mixedPresent })
  withFixture(rollback, () => {
    const result = runInstaller(rollback, { KINVEST_TEST_FAIL_DAEMON_RELOAD_ON: '2' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=DAEMON_RELOAD_FAILED backup=/)
    assertOriginalState(rollback, mixedPresent)
    assert.equal(backupDirectories(rollback).length, 1)
    assertInterlock(rollback)
    assert.deepEqual(transactionPhases(rollback), ['operator-required'])
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

  const restoreFailure = createFixture(installer)
  withFixture(restoreFailure, () => {
    const result = runInstaller(restoreFailure, {
      KINVEST_TEST_FAIL_VERIFIER: '1',
      KINVEST_TEST_FAIL_MV_MATCH: '.kinvest-metadata-restore-library'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /rollback=failed:RECOVERY_INCOMPLETE/)
    assertInterlock(restoreFailure)
    assert.deepEqual(transactionPhases(restoreFailure), ['operator-required'])
  })

  const finalReloadFailure = createFixture(installer)
  withFixture(finalReloadFailure, () => {
    const result = runInstaller(finalReloadFailure, {
      KINVEST_TEST_FAIL_DAEMON_RELOAD_ON: '3,4'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=INTERLOCK_RELEASE_DAEMON_RELOAD_FAILED/)
    assertInterlock(finalReloadFailure)
    assert.ok(transactionPhases(finalReloadFailure).includes('operator-required'))
    const states = [...operations(finalReloadFailure).matchAll(/^systemctl-interlock:(present|absent)$/gm)]
      .map((match) => match[1])
    assert.deepEqual(states.slice(0, 4), ['present', 'present', 'absent', 'present'])
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

  const replacementOrder = ['drop-in', 'library', 'wrapper', 'service', 'timer', 'modules-load', 'sysctl']

  const beforeFirstReplacement = createFixture(installer)
  withFixture(beforeFirstReplacement, () => {
    const marker = '# TEST_FAULT_POINT_BEFORE_FIRST_RUNTIME_REPLACE'
    const faultScript = path.join(beforeFirstReplacement.fixture, 'crash-before-first-runtime-replace.sh')
    const baseScript = fs.readFileSync(beforeFirstReplacement.script, 'utf8')
    assert.match(baseScript, new RegExp(marker))
    write(faultScript, baseScript.replace(marker, () => 'kill -KILL $$'))
    assert.notEqual(runInstaller({ ...beforeFirstReplacement, script: faultScript }).status, 0)
    assertInterlock(beforeFirstReplacement)
    fs.appendFileSync(path.join(beforeFirstReplacement.sourceRoot, assets[0].source), '# stop after recovery\n')
    const recovered = runInstaller(beforeFirstReplacement)
    assert.notEqual(recovered.status, 0)
    assert.match(recovered.stderr, /code=SOURCE_MANIFEST_INVALID/)
    assertOriginalState(beforeFirstReplacement, assets.map((asset) => asset.id))
    assertInterlock(beforeFirstReplacement)
    assert.ok(transactionPhases(beforeFirstReplacement).includes('operator-required'))
  })

  for (const faultAsset of replacementOrder) {
    const crash = createFixture(installer)
    withFixture(crash, () => {
      const marker = `# TEST_FAULT_POINT_AFTER_REPLACE_${faultAsset}`
      const faultScript = path.join(crash.fixture, `crash-after-${faultAsset}.sh`)
      const baseScript = fs.readFileSync(crash.script, 'utf8')
      assert.match(baseScript, new RegExp(marker.replaceAll('-', '[-]')))
      write(faultScript, baseScript.replace(marker, () => 'kill -KILL $$'))
      const crashed = runInstaller({ ...crash, script: faultScript })
      assert.notEqual(crashed.status, 0)
      fs.appendFileSync(path.join(crash.sourceRoot, assets[0].source), '# force next install to stop after recovery\n')
      const recovered = runInstaller(crash)
      assert.notEqual(recovered.status, 0)
      assert.match(recovered.stderr, /code=SOURCE_MANIFEST_INVALID/)
      assertOriginalState(crash, assets.map((asset) => asset.id))
      assertInterlock(crash)
      const recoveredPhases = backupDirectories(crash)
        .map((entry) => path.join(crash.targetRoot, 'var/backups/kinvest-metadata-firewall', entry, 'phase'))
        .filter((entry) => fs.existsSync(entry))
        .map((entry) => fs.readFileSync(entry, 'utf8').trim())
      assert.ok(recoveredPhases.includes('operator-required'), `missing operator-required phase after ${faultAsset}`)
    })
  }

  const interlockCrash = createFixture(installer, {
    present: assets.filter((asset) => !['wrapper', 'sysctl'].includes(asset.id)).map((asset) => asset.id)
  })
  withFixture(interlockCrash, () => {
    assert.notEqual(runInstaller(interlockCrash, { KINVEST_TEST_FAIL_VERIFIER: '1' }).status, 0)
    assertInterlock(interlockCrash)
    const marker = '# TEST_FAULT_POINT_AFTER_SAFE_COMMIT_BEFORE_INTERLOCK_REMOVE'
    const faultScript = path.join(interlockCrash.fixture, 'crash-before-interlock-release.sh')
    const baseScript = fs.readFileSync(interlockCrash.script, 'utf8')
    assert.match(baseScript, new RegExp(marker))
    write(faultScript, baseScript.replace(marker, () => 'kill -KILL $$'))
    assert.notEqual(runInstaller({ ...interlockCrash, script: faultScript }).status, 0)
    assertInterlock(interlockCrash)
    assert.ok(transactionPhases(interlockCrash).includes('safe-committed'))
    const recovered = runInstaller(interlockCrash)
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.equal(fs.existsSync(interlockPath(interlockCrash)), false)
    assert.deepEqual(transactionPhases(interlockCrash).sort(), ['committed', 'superseded'])
  })

  const replacedParent = createFixture(installer)
  withFixture(replacedParent, () => {
    const marker = '# TEST_FAULT_POINT_AFTER_REPLACE_drop-in'
    const faultScript = path.join(replacedParent.fixture, 'crash-before-parent-swap.sh')
    const baseScript = fs.readFileSync(replacedParent.script, 'utf8')
    assert.match(baseScript, new RegExp(marker.replaceAll('-', '[-]')))
    write(faultScript, baseScript.replace(marker, () => 'kill -KILL $$'))
    assert.notEqual(runInstaller({ ...replacedParent, script: faultScript }).status, 0)
    const parent = path.dirname(targetPath(replacedParent, assets.find((asset) => asset.id === 'drop-in')))
    const displaced = `${parent}.displaced`
    fs.renameSync(parent, displaced)
    fs.mkdirSync(parent, { mode: 0o755 })
    const result = runInstaller(replacedParent)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /code=TARGET_PARENT_IDENTITY_CHANGED/)
    assert.equal(fs.existsSync(path.join(parent, 'kinvest-metadata-firewall.conf')), false)
  })
}

module.exports = { run }

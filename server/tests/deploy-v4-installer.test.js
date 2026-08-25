const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const sourceDir = path.join(rootDir, 'deploy/server')
const installerSource = fs.readFileSync(path.join(sourceDir, 'install-deploy-v4.sh'), 'utf8')
const gateSource = fs.readFileSync(path.join(sourceDir, 'kinvest-ssh-command-v3'), 'utf8')
const targetCount = 10

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture({ existing = true, replaceFailure = null, postFailure = false, rollbackPause = false, pauseBeforeGate = false, killAfterReplacement = null, killStage = '', failGateTemp = '', killGateTemp = '', killGateTempStage = '', killIdentityTempStage = '', failIdentityTempStage = '' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-installer-'))
  const sbin = path.join(base, 'sbin')
  const libexec = path.join(base, 'libexec')
  const serverRoot = path.join(base, 'server')
  const sudoers = path.join(base, 'sudoers')
  const runRoot = path.join(base, 'run')
  const bin = path.join(base, 'bin')
  const eventLog = path.join(base, 'events.log')
  const installerLockDir = path.join(base, 'installer.lock.held')
  const deployLockDir = path.join(base, 'deploy.lock.held')
  const lockRelease = path.join(base, 'lock.release')
  const locksHeldMarker = path.join(base, 'locks.held')
  const rollbackMarker = path.join(base, 'rollback.started')
  const rollbackRelease = path.join(base, 'rollback.release')
  const killMarker = path.join(base, 'kill.once')
  const fsyncTrace = path.join(base, 'fsync.trace')
  const gateStateDir = path.join(base, 'gate-state')
  for (const directory of [sbin, libexec, serverRoot, path.join(serverRoot, 'state'), sudoers, runRoot, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
kind='gate'
case "\${*: -1}" in 8) kind='install';; 9) kind='deploy';; esac
if [[ "$kind" == install ]]; then lock_dir="\${INSTALLER_LOCK_DIR:-}"; else lock_dir="\${DEPLOY_LOCK_DIR:-}"; fi
if [[ -z "$lock_dir" ]]; then exit 0; fi
if [[ "$kind" == deploy && "\${BLOCK_DEPLOY_LOCK:-}" == 1 ]]; then
  printf '%s:deploy-contended\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
  exit 1
fi
if [[ "$kind" == gate ]]; then
  if [[ -d "$INSTALLER_LOCK_DIR" ]]; then
    printf '%s:gate-contended\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
    exit 1
  fi
  exit 0
fi
if mkdir "$lock_dir" 2>/dev/null; then
  printf '%s:%s-lock\\n' "$INSTALLER_ID" "$kind" >>"$INSTALL_EVENTS"
  if [[ "\${HOLD_LOCK_KIND:-}" == "$kind" ]]; then
    while [[ ! -e "$INSTALL_LOCK_RELEASE" ]]; do sleep 0.01; done
  fi
  exit 0
fi
printf '%s:%s-contended\\n' "$INSTALLER_ID" "$kind" >>"$INSTALL_EVENTS"
exit 1
`)
  writeExecutable(path.join(bin, 'gate-flock'), `#!/usr/bin/env bash
[[ ! -d "\${INSTALLER_LOCK_DIR:-}" ]]
`)
  writeExecutable(path.join(bin, 'getent'), `#!/usr/bin/env bash
case "$1:$2:\${FAKE_IDENTITY_MODE:-}" in
  passwd:lighthouse:missing-user) exit 2 ;;
  group:lighthouse:missing-group) exit 2 ;;
  passwd:lighthouse:*|passwd:alternate:*) printf '%s:x:%s:%s:Deploy:/nonexistent:/usr/sbin/nologin\n' "$2" "${Math.max(process.getuid(), 1)}" "${process.getgid()}" ;;
  group:lighthouse:*) printf '%s:x:%s:\n' "$2" "${process.getgid()}" ;;
  group:alternate:*) printf '%s:x:%s:\n' "$2" "${process.getgid() + 1}" ;;
  *) exit 2 ;;
esac
`)
  writeExecutable(path.join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == -G && ( "$2" == lighthouse || "$2" == alternate ) ]]; then
  if [[ "\${FAKE_IDENTITY_MODE:-}" == membership-mismatch ]]; then printf '99999\n'; elif [[ "$2" == alternate ]]; then printf '%s\n' "${process.getgid() + 1}"; else printf '%s\n' "${process.getgid()}"; fi
  exit 0
fi
exec /usr/bin/id "$@"
`)
  writeExecutable(path.join(bin, 'sha256sum'), `#!/usr/bin/env bash
for argument in "$@"; do
  if [[ -n "\${INSTALL_TARGET_ROOT:-}" && "$argument" == "$INSTALL_TARGET_ROOT"* ]]; then
    printf '%s:target-read\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
  fi
done
exec "$REAL_SHA256SUM" "$@"
`)
  writeExecutable(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'visudo'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'realpath'), '#!/bin/sh\n[ "${1:-}" = -e ] && shift\nprintf \'%s\\n\' "$1"\n')
  writeExecutable(path.join(bin, 'mv'), `#!/usr/bin/env bash
args=()
for arg in "$@"; do [[ "$arg" == -fT || "$arg" == -f ]] || args+=("$arg"); done
count="\${#args[@]}"
source="\${args[$((count - 2))]}"
target="\${args[$((count - 1))]}"
[[ -z "\${FSYNC_TRACE:-}" ]] || printf 'rename:%s:%s\\n' "$source" "$target" >>"$FSYNC_TRACE"
exec /bin/mv -f "\${args[@]}"
`)

  const gate = path.join(sbin, 'kinvest-ssh-command')
  const targets = [
    path.join(sbin, 'deploy-kinvest-v4'),
    path.join(sbin, 'deploy-kinvest-v3'),
    path.join(libexec, 'kinvest-deploy-v4-contract'),
    path.join(libexec, 'kinvest-deploy-v3-contract'),
    path.join(serverRoot, 'docker-compose-v4.yml'),
    path.join(sudoers, 'kinvest-deploy-v4'),
    path.join(serverRoot, 'access-control-network.conf.example'),
    path.join(sbin, 'kinvest-nginx-fixed-ip-gate'),
    path.join(serverRoot, 'docker-compose.nginx-fixed-ip.yml'),
    path.join(sbin, 'kinvest-nginx-config-installer-v1')
  ]
  if (existing) {
    for (let index = 0; index < targets.length; index += 1) {
      fs.writeFileSync(targets[index], `old-${index}\n`, { mode: 0o700 })
    }
    writeExecutable(gate, '#!/bin/sh\n[ -e "' + path.join(serverRoot, 'state/install-v4.journal') + '" ] && exit 76\nexec sudo -n /usr/local/sbin/deploy-kinvest-v3\n')
  }

  let instrumented = installerSource
    .replace("LOCAL_SBIN='/usr/local/sbin'", `LOCAL_SBIN='${sbin}'`)
    .replace("LOCAL_LIBEXEC='/usr/local/libexec'", `LOCAL_LIBEXEC='${libexec}'`)
    .replace("SERVER_ROOT='/root/docker/kinvest'", `SERVER_ROOT='${serverRoot}'`)
    .replace("SUDOERS_DIR='/etc/sudoers.d'", `SUDOERS_DIR='${sudoers}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${gateStateDir}'`)
    .replace("GATE_ROOT_OWNER='0:0'", `GATE_ROOT_OWNER='${process.getuid()}:${process.getgid()}'`)
    .replace('[[ "$(id -u)" -eq 0 ]]', '[[ "${KINVEST_INSTALL_V4_TEST_ROOT:-}" == 1 ]]')
    .replaceAll('-o root -g root', `-o ${process.getuid()} -g ${process.getgid()}`)
    .replaceAll('chown root:root', `chown ${process.getuid()}:${process.getgid()}`)
    .replaceAll('-o root -g "$GATE_GROUP"', `-o ${process.getuid()} -g ${process.getgid()}`)
    .replaceAll('chown root:"$GATE_GROUP"', `chown ${process.getuid()}:${process.getgid()}`)
    .replace('fsync_file() {', `fsync_file() {
  printf 'file:%s\\n' "$1" >>'${fsyncTrace}'`)
    .replace('file_attributes() {', `file_attributes() {
  if [[ -n "\${FAKE_BAD_OWNER_PATH:-}" && "$1" == "$FAKE_BAD_OWNER_PATH" ]]; then printf '99999:99999:640\\n'; return; fi`)
    .replace('gate_inode_identity() {', `gate_inode_identity() {
  if [[ -n "\${FAKE_BAD_OWNER_PATH:-}" && "$1" == "$FAKE_BAD_OWNER_PATH" ]]; then printf '1:1:99999:1:1\\n'; return; fi`)
    .replace('fsync_directory() {', `fsync_directory() {
  printf 'dir:%s\\n' "$1" >>'${fsyncTrace}'`)
    .replace('publish_install_journal() {', `publish_install_journal() {
  printf 'publish\\n' >>'${fsyncTrace}'`)
    .replace('clear_install_journal() {', `clear_install_journal() {
  printf 'clear\\n' >>'${fsyncTrace}'`)
    .replace('clear_public_marker() {', `clear_public_marker() {
  printf 'public-clear\\n' >>'${fsyncTrace}'`)
  if (replaceFailure !== null) {
    instrumented = instrumented.replace(
      '  mv -fT "$temporary" "${TARGETS[$index]}"',
      `  if [[ "$index" == '${replaceFailure}' ]]; then false; fi\n  mv -fT "$temporary" "\${TARGETS[$index]}"`
    )
  }
  if (killAfterReplacement !== null) {
    instrumented = instrumented.replace(
      '  mv -fT "$temporary" "${TARGETS[$index]}"',
      () => `  mv -fT "$temporary" "\${TARGETS[$index]}"
  if [[ "$index" == '${killAfterReplacement}' && ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`
    )
  }
  if (killStage) {
    const points = {
      'before-gate': ['install_forced_command_gate # stable-gate-commit', `if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi
install_forced_command_gate # stable-gate-commit`],
      'after-gate': ['install_forced_command_gate # stable-gate-commit', `install_forced_command_gate # stable-gate-commit
if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`],
      'after-journal': ['publish_install_journal # install-journal-commit', `publish_install_journal # install-journal-commit
if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`]
    }
    const [point, replacement] = points[killStage]
    instrumented = instrumented.replace(point, () => replacement)
  }
  if (failGateTemp === 'marker') {
    const point = '# gate-marker-temp-created'
    instrumented = instrumented.replace(point, `${point}\n  return 1 # injected gate temp failure`)
  }
  if (killGateTemp === 'marker') {
    const point = '# gate-marker-temp-created'
    instrumented = instrumented.replace(point, () => `${point}\n  if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`)
  }
  if (killGateTempStage) {
    const points = {
      created: '# gate-marker-temp-created',
      written: '  printf \'%s\\n\' ACTIVE >"$gate_marker_temporary"',
      owned: `  chown ${process.getuid()}:${process.getgid()} "$gate_marker_temporary"`,
      mode: '  chmod 0640 "$gate_marker_temporary"',
      durable: '  fsync_file "$gate_marker_temporary"'
    }
    const point = points[killGateTempStage]
    instrumented = instrumented.replace(point, () => `${point}\n  if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`)
  }
  if (killIdentityTempStage) {
    const point = `# gate-identity-temp-${killIdentityTempStage}`
    instrumented = instrumented.replace(point, () => `${point}\n    if [[ ! -e '${killMarker}' ]]; then : >'${killMarker}'; kill -KILL $$; fi`)
  }
  if (failIdentityTempStage) {
    const point = `# gate-identity-temp-${failIdentityTempStage}`
    instrumented = instrumented.replace(point, `${point}\n    return 1 # injected identity temp failure`)
  }
  if (postFailure) {
    instrumented = instrumented.replace(
      'visudo -cf "$SUDOERS_DIR/kinvest-deploy-v4" >/dev/null',
      'false # injected post-check failure'
    )
  }
  if (rollbackPause) {
    instrumented = instrumented.replace(
      'rollback_targets() {',
      `rollback_targets() {
  : >'${rollbackMarker}'
  while [[ ! -e '${rollbackRelease}' ]]; do sleep 0.01; done`
    )
  }
  if (pauseBeforeGate) {
    instrumented = instrumented.replace(
      "flock -n 9 || fail 'another Kinvest deployment is already running'",
      `flock -n 9 || fail 'another Kinvest deployment is already running'
  : >'${locksHeldMarker}'
  while [[ ! -e '${lockRelease}' ]]; do sleep 0.01; done`
    )
  }
  const script = path.join(base, 'installer.sh')
  writeExecutable(script, instrumented)
  return { base, bin, eventLog, fsyncTrace, gate, gateStateDir, installerLockDir, deployLockDir, lockRelease, locksHeldMarker, rollbackMarker, rollbackRelease, script, serverRoot, targets }
}

function installerEnvironment(context, overrides = {}) {
  return {
    ...process.env,
    KINVEST_INSTALL_V4_TEST_ROOT: '1',
    KINVEST_DEPLOY_GATE_USER: 'lighthouse',
    KINVEST_DEPLOY_GATE_GROUP: 'lighthouse',
    PATH: `${context.bin}:${process.env.PATH}`,
    REAL_SHA256SUM: spawnSync('which', ['sha256sum'], { encoding: 'utf8' }).stdout.trim(),
    FSYNC_TRACE: context.fsyncTrace,
    ...overrides
  }
}

function execute(context, overrides = {}) {
  return spawnSync('bash', [context.script, sourceDir], {
    encoding: 'utf8',
    env: installerEnvironment(context, overrides)
  })
}

function fixtureGateSource(context, source) {
  return source
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${context.gateStateDir}'`)
    .replace('/usr/bin/flock', path.join(context.bin, 'gate-flock'))
    .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
    .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
}

function waitFor(check, timeoutMs = 10000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for installer event'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

const childClosures = new WeakMap()

function trackChild(child) {
  childClosures.set(child, new Promise((resolve) => {
    child.once('close', (status, signal) => resolve({ signal, status }))
  }))
  return child
}

function waitForExit(child, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    childClosures.get(child).then(({ status, signal }) => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error(`${label}: installer child did not exit within ${timeoutMs}ms`))
      resolve({ signal, status })
    })
  })
}

async function terminateAndWait(child, label) {
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await waitForExit(child, `${label} cleanup`)
}

function assertOld(context, existing) {
  for (let index = 0; index < context.targets.length; index += 1) {
    if (existing) {
      assert.equal(fs.readFileSync(context.targets[index], 'utf8'), `old-${index}\n`)
      assert.equal(fs.statSync(context.targets[index]).mode & 0o777, 0o700)
    } else {
      assert.equal(fs.existsSync(context.targets[index]), false)
    }
  }
}

function assertDurableRenames(trace, fragment) {
  const renames = trace
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.startsWith('rename:') && event.includes(fragment))
  assert.equal(renames.length, targetCount, fragment)
  for (let position = 0; position < renames.length; position += 1) {
    const { event, index } = renames[position]
    const [, temporary, target] = event.split(':')
    const nextRename = renames[position + 1]?.index ?? trace.length
    assert.ok(trace.lastIndexOf(`file:${temporary}`, index) >= 0, `missing temp fsync for ${target}`)
    assert.ok(trace.slice(index + 1, nextRename).includes(`dir:${path.dirname(target)}`), `missing immediate parent fsync for ${target}`)
  }
}

function canWriteAs(info, uid, gid) {
  if (uid === info.uid) return (info.mode & 0o200) !== 0
  if (gid === info.gid) return (info.mode & 0o020) !== 0
  return (info.mode & 0o002) !== 0
}

async function run() {
  assert.match(installerSource, /bash -n "\$LOCAL_SBIN\/kinvest-nginx-fixed-ip-gate"/)
  assert.doesNotMatch(installerSource, /systemctl restart|docker compose|DEPLOY_V4_ENABLED/)
  assert.doesNotMatch(installerSource, /install\.lock|\.install-lock\./)
  assert.doesNotMatch(installerSource, /DEPLOY_USER='kinvest-deploy'/)
  assert.match(installerSource, /KINVEST_DEPLOY_GATE_USER:-/)
  assert.match(installerSource, /KINVEST_DEPLOY_GATE_GROUP:-/)
  assert.equal(fs.existsSync(path.join(sourceDir, 'kinvest-deploy-v4.sudoers.in')), true)
  assert.match(fs.readFileSync(path.join(sourceDir, 'kinvest-deploy-v4.sudoers.in'), 'utf8'), /@KINVEST_DEPLOY_GATE_USER@/)
  assert.doesNotMatch(fs.readFileSync(path.join(sourceDir, 'kinvest-deploy-v4.sudoers.in'), 'utf8'), /kinvest-deploy/)
  assert.doesNotMatch(gateSource, /\/root\/docker\/kinvest/)
  assert.match(gateSource, /\/var\/lib\/kinvest-deploy-gate/)
  assert.doesNotMatch(gateSource, /timeout|sleep|retry/i)
  assert.match(gateSource, /\.identity\./)

  const timeoutChild = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  let timeoutChildClosed = false
  timeoutChild.once('close', () => { timeoutChildClosed = true })
  try {
    await assert.rejects(
      waitForExit(timeoutChild, 'timeout regression', 25),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /timeout regression/)
        assert.equal(timeoutChildClosed, true)
        return true
      }
    )
    assert.equal(timeoutChild.signalCode, 'SIGKILL')
  } finally {
    if (!timeoutChildClosed) {
      timeoutChild.kill('SIGKILL')
      await new Promise((resolve) => timeoutChild.once('close', resolve))
    }
  }

  const missingIdentity = fixture()
  try {
    const env = installerEnvironment(missingIdentity)
    delete env.KINVEST_DEPLOY_GATE_USER
    delete env.KINVEST_DEPLOY_GATE_GROUP
    const result = spawnSync('bash', [missingIdentity.script, sourceDir], { encoding: 'utf8', env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DEPLOY_V4_GATE_IDENTITY_REQUIRED/)
  } finally {
    fs.rmSync(missingIdentity.base, { recursive: true, force: true })
  }

  for (const mode of ['missing-user', 'missing-group', 'membership-mismatch']) {
    const invalidIdentity = fixture()
    try {
      const result = execute(invalidIdentity, { FAKE_IDENTITY_MODE: mode })
      assert.notEqual(result.status, 0, mode)
      assert.match(result.stderr, /DEPLOY_V4_GATE_IDENTITY_INVALID/, mode)
    } finally {
      fs.rmSync(invalidIdentity.base, { recursive: true, force: true })
    }
  }

  const injectedIdentity = fixture()
  try {
    const result = execute(injectedIdentity, { KINVEST_DEPLOY_GATE_USER: 'lighthouse ALL=(ALL) NOPASSWD: ALL' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DEPLOY_V4_GATE_IDENTITY_INVALID/)
  } finally {
    fs.rmSync(injectedIdentity.base, { recursive: true, force: true })
  }

  const gatePermissionBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-gate-'))
  let holder
  try {
    const publicState = path.join(gatePermissionBase, 'public')
    const privateState = path.join(gatePermissionBase, 'private')
    const marker = path.join(publicState, 'install-incomplete')
    const ready = path.join(gatePermissionBase, 'exclusive.ready')
    const bin = path.join(gatePermissionBase, 'bin')
    fs.mkdirSync(publicState, { mode: 0o750 })
    fs.mkdirSync(privateState, { mode: 0o700 })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(privateState, 'install-v4.journal'), 'private\n', { mode: 0o600 })
    fs.chmodSync(privateState, 0o000)
    writeExecutable(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n')
    writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
[[ -z "\${FLOCK_LOG:-}" ]] || printf 'flock\\n' >>"$FLOCK_LOG"
exec python3 - "$@" <<'PY'
import fcntl, sys
fd = int(sys.argv[-1])
operation = fcntl.LOCK_NB | (fcntl.LOCK_SH if "-s" in sys.argv else fcntl.LOCK_EX)
try: fcntl.flock(fd, operation)
except BlockingIOError: raise SystemExit(1)
PY
`)
    const gate = path.join(gatePermissionBase, 'gate')
    const noGroupGate = path.join(gatePermissionBase, 'gate-no-group')
    const flockLog = path.join(gatePermissionBase, 'flock.log')
    const uid = process.getuid()
    const gid = process.getgid()
    writeExecutable(gate, gateSource
      .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${publicState}'`)
      .replace('/usr/bin/flock', path.join(bin, 'flock'))
      .replaceAll('info.st_uid != 0', `info.st_uid != ${uid}`)
      .replaceAll('info.st_gid != 0', `info.st_gid != ${gid}`))
    writeExecutable(noGroupGate, fs.readFileSync(gate, 'utf8')
      .replace('effective_groups = {os.getegid(), *os.getgroups()}', 'effective_groups = set()'))
    const gateEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLOCK_LOG: flockLog, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
    const unrelated = spawnSync(noGroupGate, [], { encoding: 'utf8', env: gateEnv })
    assert.equal(unrelated.status, 76)
    assert.equal(fs.existsSync(flockLog), false)
    const idle = spawnSync(gate, [], { encoding: 'utf8', env: gateEnv })
    assert.equal(idle.status, 0, idle.stderr)

    holder = trackChild(spawn('python3', ['-c', [
      'import fcntl,os,sys,time',
      'fd=os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)',
      'fcntl.flock(fd, fcntl.LOCK_EX)',
      'open(sys.argv[2], "w").close()',
      'time.sleep(30)'
    ].join(';'), publicState, ready], { stdio: 'ignore' }))
    await waitFor(() => fs.existsSync(ready))
    const busy = spawnSync(gate, [], { encoding: 'utf8', env: gateEnv })
    assert.equal(busy.status, 76)
    assert.equal(busy.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')
    fs.writeFileSync(marker, 'ACTIVE\n', { mode: 0o640 })
    holder.kill('SIGKILL')
    await waitForExit(holder, 'exclusive gate lock holder')
    const stale = spawnSync(gate, [], { encoding: 'utf8', env: gateEnv })
    assert.equal(stale.status, 76)
    assert.equal(stale.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')

    const directoryInfo = fs.statSync(publicState)
    const markerInfo = fs.statSync(marker)
    assert.equal(canWriteAs(directoryInfo, uid + 1, gid + 1), false)
    assert.equal(canWriteAs(markerInfo, uid + 1, gid + 1), false)
    fs.chmodSync(publicState, 0o755)
    assert.equal(spawnSync(gate, [], { encoding: 'utf8', env: gateEnv }).status, 76)
    fs.chmodSync(publicState, 0o750)
    fs.rmSync(marker)
    const orphan = path.join(publicState, '.install-incomplete.AbC123')
    fs.writeFileSync(orphan, 'partial', { mode: 0o600 })
    assert.equal(spawnSync(gate, [], { encoding: 'utf8', env: gateEnv }).status, 76)
    fs.rmSync(orphan)
    const reconciled = spawnSync(gate, [], { encoding: 'utf8', env: gateEnv })
    assert.equal(reconciled.status, 0, reconciled.stderr)
  } finally {
    await terminateAndWait(holder, 'exclusive gate lock holder')
    fs.chmodSync(path.join(gatePermissionBase, 'private'), 0o700)
    fs.rmSync(gatePermissionBase, { recursive: true, force: true })
  }

  const legalTemps = fixture()
  try {
    fs.mkdirSync(legalTemps.gateStateDir, { mode: 0o750 })
    const legalMarkerTemp = path.join(legalTemps.gateStateDir, '.install-incomplete.XyZ789')
    fs.writeFileSync(legalMarkerTemp, 'partial', { mode: 0o600 })
    const result = execute(legalTemps)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(legalMarkerTemp), false)
  } finally {
    fs.rmSync(legalTemps.base, { recursive: true, force: true })
  }

  for (const fault of ['symlink', 'wrong-owner', 'hardlink', 'malformed-name']) {
    const malicious = fixture()
    try {
      fs.mkdirSync(malicious.gateStateDir, { mode: 0o750 })
      const candidate = path.join(malicious.gateStateDir, fault === 'malformed-name' ? '.install-incomplete.bad!' : '.install-incomplete.Bad123')
      const overrides = {}
      if (fault === 'symlink') {
        fs.symlinkSync('/dev/null', candidate)
      } else {
        fs.writeFileSync(candidate, '', { mode: 0o600 })
        if (fault === 'wrong-owner') overrides.FAKE_BAD_OWNER_PATH = candidate
        if (fault === 'hardlink') fs.linkSync(candidate, path.join(malicious.base, 'extra-hardlink'))
      }
      const result = execute(malicious, overrides)
      assert.notEqual(result.status, 0, fault)
      assert.match(result.stderr, /DEPLOY_V4_GATE_TEMP_INVALID/, fault)
      assert.equal(fs.existsSync(candidate), true, fault)
    } finally {
      fs.rmSync(malicious.base, { recursive: true, force: true })
    }
  }

  const legalIdentityTemp = fixture()
  try {
    fs.mkdirSync(legalIdentityTemp.gateStateDir, { mode: 0o750 })
    const candidate = path.join(legalIdentityTemp.gateStateDir, '.identity.AbC123')
    fs.writeFileSync(candidate, 'user=light', { mode: 0o600 })
    const result = execute(legalIdentityTemp)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(candidate), false)
  } finally {
    fs.rmSync(legalIdentityTemp.base, { recursive: true, force: true })
  }

  for (const fault of ['symlink', 'wrong-owner', 'hardlink', 'malformed-name']) {
    const maliciousIdentity = fixture()
    try {
      fs.mkdirSync(maliciousIdentity.gateStateDir, { mode: 0o750 })
      const candidate = path.join(maliciousIdentity.gateStateDir, fault === 'malformed-name' ? '.identity.bad!' : '.identity.Bad123')
      const overrides = {}
      if (fault === 'symlink') fs.symlinkSync('/dev/null', candidate)
      else {
        fs.writeFileSync(candidate, 'partial', { mode: 0o600 })
        if (fault === 'wrong-owner') overrides.FAKE_BAD_OWNER_PATH = candidate
        if (fault === 'hardlink') fs.linkSync(candidate, path.join(maliciousIdentity.base, 'identity-hardlink'))
      }
      const result = execute(maliciousIdentity, overrides)
      assert.notEqual(result.status, 0, fault)
      assert.match(result.stderr, /DEPLOY_V4_GATE_TEMP_INVALID/, fault)
      assert.equal(fs.existsSync(candidate), true, fault)
    } finally {
      fs.rmSync(maliciousIdentity.base, { recursive: true, force: true })
    }
  }

  const failedIdentity = fixture({ failIdentityTempStage: 'mode' })
  try {
    const result = execute(failedIdentity)
    assert.notEqual(result.status, 0)
    assert.deepEqual(fs.readdirSync(failedIdentity.gateStateDir).filter((name) => name.startsWith('.identity.')), [])
    assert.ok(fs.readFileSync(failedIdentity.fsyncTrace, 'utf8').includes(`dir:${failedIdentity.gateStateDir}\n`))
  } finally {
    fs.rmSync(failedIdentity.base, { recursive: true, force: true })
  }

  for (const stage of ['created', 'written', 'owned', 'mode', 'durable', 'renamed']) {
    const interrupted = fixture({ killIdentityTempStage: stage })
    try {
      const killed = execute(interrupted)
      assert.equal(killed.signal, 'SIGKILL', stage)
      const identityTemps = fs.readdirSync(interrupted.gateStateDir).filter((name) => name.startsWith('.identity.'))
      assert.equal(identityTemps.length, stage === 'renamed' ? 0 : 1, stage)
      const gateHarness = path.join(interrupted.base, `identity-gate-${stage}`)
      writeExecutable(gateHarness, fixtureGateSource(interrupted, gateSource))
      const beforeResume = spawnSync(gateHarness, [], {
        encoding: 'utf8', env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
      })
      assert.equal(beforeResume.status, stage === 'renamed' ? 0 : 76, stage)
      const resumed = execute(interrupted)
      assert.equal(resumed.status, 0, resumed.stderr)
      const afterResume = spawnSync(gateHarness, [], {
        encoding: 'utf8', env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
      })
      assert.equal(afterResume.status, 0, stage)
    } finally {
      fs.rmSync(interrupted.base, { recursive: true, force: true })
    }
  }

  for (const kind of ['marker']) {
    const failedTemp = fixture({ failGateTemp: kind })
    try {
      const result = execute(failedTemp)
      assert.notEqual(result.status, 0, kind)
      const leftovers = fs.readdirSync(failedTemp.gateStateDir).filter((name) => name.startsWith('.install-'))
      assert.deepEqual(leftovers, [], kind)
      assert.ok(fs.readFileSync(failedTemp.fsyncTrace, 'utf8').includes(`dir:${failedTemp.gateStateDir}\n`), kind)
    } finally {
      fs.rmSync(failedTemp.base, { recursive: true, force: true })
    }

    const killedTemp = fixture({ killGateTemp: kind })
    try {
      const killed = execute(killedTemp)
      assert.equal(killed.signal, 'SIGKILL', `${kind}: status=${killed.status} stderr=${killed.stderr}`)
      assert.ok(fs.readdirSync(killedTemp.gateStateDir).some((name) => name.startsWith('.install-incomplete.')), kind)
      const resumed = execute(killedTemp)
      assert.equal(resumed.status, 0, resumed.stderr)
      assert.deepEqual(fs.readdirSync(killedTemp.gateStateDir).filter((name) => name.startsWith('.install-')), [], kind)
    } finally {
      fs.rmSync(killedTemp.base, { recursive: true, force: true })
    }
  }

  for (const stage of ['created', 'written', 'owned', 'mode', 'durable']) {
    const interrupted = fixture({ killGateTempStage: stage })
    try {
      const killed = execute(interrupted)
      assert.equal(killed.signal, 'SIGKILL', stage)
      assert.ok(fs.readdirSync(interrupted.gateStateDir).some((name) => name.startsWith('.install-incomplete.')), stage)
      const gateHarness = path.join(interrupted.base, `temp-gate-${stage}`)
      writeExecutable(gateHarness, fixtureGateSource(interrupted, fs.readFileSync(interrupted.gate, 'utf8')))
      const blocked = spawnSync(gateHarness, [], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
      })
      assert.equal(blocked.status, 76, stage)
      assert.equal(blocked.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n', stage)
      const resumed = execute(interrupted)
      assert.equal(resumed.status, 0, resumed.stderr)
      assert.deepEqual(fs.readdirSync(interrupted.gateStateDir).filter((name) => name.startsWith('.install-incomplete.')), [], stage)
    } finally {
      fs.rmSync(interrupted.base, { recursive: true, force: true })
    }
  }

  const deploymentBusy = fixture()
  try {
    const result = execute(deploymentBusy, {
      INSTALL_EVENTS: deploymentBusy.eventLog,
      INSTALLER_LOCK_DIR: deploymentBusy.installerLockDir,
      DEPLOY_LOCK_DIR: deploymentBusy.deployLockDir,
      INSTALL_TARGET_ROOT: deploymentBusy.base,
      INSTALLER_ID: 'installer',
      BLOCK_DEPLOY_LOCK: '1'
    })
    assert.notEqual(result.status, 0)
    const events = fs.readFileSync(deploymentBusy.eventLog, 'utf8').trim().split('\n')
    assert.deepEqual(events.slice(0, 2), ['installer:install-lock', 'installer:deploy-contended'])
    assert.equal(events.some((event) => event.endsWith(':target-read')), false)
    assertOld(deploymentBusy, true)
  } finally {
    fs.rmSync(deploymentBusy.base, { recursive: true, force: true })
  }

  const concurrent = fixture()
  let first
  try {
    const sharedEnvironment = {
      INSTALL_EVENTS: concurrent.eventLog,
      INSTALLER_LOCK_DIR: concurrent.installerLockDir,
      DEPLOY_LOCK_DIR: concurrent.deployLockDir,
      INSTALL_LOCK_RELEASE: concurrent.lockRelease,
      INSTALL_TARGET_ROOT: concurrent.base
    }
    first = trackChild(spawn('bash', [concurrent.script, sourceDir], {
      env: installerEnvironment(concurrent, { ...sharedEnvironment, HOLD_LOCK_KIND: 'install', INSTALLER_ID: 'first' }),
      stdio: 'ignore'
    }))
    await waitFor(() => fs.existsSync(concurrent.eventLog) && fs.readFileSync(concurrent.eventLog, 'utf8').includes('first:install-lock'))
    const second = execute(concurrent, { ...sharedEnvironment, INSTALLER_ID: 'second' })
    assert.notEqual(second.status, 0)
    const whileLocked = fs.readFileSync(concurrent.eventLog, 'utf8').trim().split('\n')
    assert.equal(whileLocked.includes('second:target-read'), false)
    fs.writeFileSync(concurrent.lockRelease, '')
    const firstExit = await waitForExit(first, 'concurrent primary installer')
    assert.equal(firstExit.status, 0)
    const events = fs.readFileSync(concurrent.eventLog, 'utf8').trim().split('\n')
    assert.ok(events.indexOf('first:install-lock') < events.indexOf('first:deploy-lock'))
    assert.ok(events.indexOf('first:deploy-lock') < events.indexOf('first:target-read'))
  } finally {
    await terminateAndWait(first, 'concurrent primary installer')
    fs.rmSync(concurrent.base, { recursive: true, force: true })
  }

  const gateWindow = fixture({ pauseBeforeGate: true })
  let gateWindowChild
  try {
    const lockEnvironment = {
      INSTALL_EVENTS: gateWindow.eventLog,
      INSTALLER_LOCK_DIR: gateWindow.installerLockDir,
      DEPLOY_LOCK_DIR: gateWindow.deployLockDir,
      INSTALL_LOCK_RELEASE: gateWindow.lockRelease,
      INSTALLER_ID: 'installer'
    }
    gateWindowChild = trackChild(spawn('bash', [gateWindow.script, sourceDir], {
      env: installerEnvironment(gateWindow, lockEnvironment), stdio: 'ignore'
    }))
    await waitFor(() => fs.existsSync(gateWindow.locksHeldMarker))
    const journal = path.join(gateWindow.serverRoot, 'state/install-v4.journal')
    assert.equal(fs.existsSync(journal), false)
    const gateHarness = path.join(gateWindow.base, 'gate-harness')
    writeExecutable(gateHarness, fixtureGateSource(gateWindow, fs.readFileSync(path.join(sourceDir, 'kinvest-ssh-command-v3'), 'utf8')))
    const blocked = spawnSync(gateHarness, [], {
      encoding: 'utf8', env: { ...process.env, ...lockEnvironment, PATH: `${gateWindow.bin}:${process.env.PATH}`, INSTALLER_ID: 'gate', SSH_ORIGINAL_COMMAND: 'deploy-v3' }
    })
    assert.equal(blocked.status, 76)
    assert.equal(blocked.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')
    fs.writeFileSync(gateWindow.lockRelease, '')
    assert.equal((await waitForExit(gateWindowChild, 'gate publication window installer')).status, 0)
    fs.rmSync(gateWindow.installerLockDir, { recursive: true, force: true })
    fs.rmSync(gateWindow.deployLockDir, { recursive: true, force: true })
    const installedGate = path.join(gateWindow.base, 'installed-gate')
    let installedSource = fixtureGateSource(gateWindow, fs.readFileSync(gateWindow.gate, 'utf8'))
    const productionAssets = [
      '/usr/local/sbin/deploy-kinvest-v4', '/usr/local/sbin/deploy-kinvest-v3',
      '/usr/local/libexec/kinvest-deploy-v4-contract', '/usr/local/libexec/kinvest-deploy-v3-contract'
    ]
    for (let index = 0; index < productionAssets.length; index += 1) installedSource = installedSource.replaceAll(productionAssets[index], gateWindow.targets[index])
    for (let index = 0; index < 4; index += 1) assert.equal(fs.accessSync(gateWindow.targets[index], fs.constants.X_OK), undefined, `asset ${index}`)
    writeExecutable(installedGate, installedSource)
    const delegated = spawnSync(installedGate, [], {
      encoding: 'utf8', env: { ...process.env, ...lockEnvironment, PATH: `${gateWindow.bin}:${process.env.PATH}`, INSTALLER_ID: 'gate', SSH_ORIGINAL_COMMAND: 'deploy-v4' }
    })
    assert.equal(delegated.status, 0, delegated.stderr)
    for (const target of gateWindow.targets) assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /^old-/)
  } finally {
    await terminateAndWait(gateWindowChild, 'gate publication window installer')
    fs.rmSync(gateWindow.base, { recursive: true, force: true })
  }

  const signalled = fixture({ replaceFailure: 3, rollbackPause: true })
  let signalledChild
  try {
    signalledChild = trackChild(spawn('bash', [signalled.script, sourceDir], {
      env: installerEnvironment(signalled),
      stdio: 'ignore'
    }))
    await waitFor(() => fs.existsSync(signalled.rollbackMarker))
    signalledChild.kill('SIGTERM')
    signalledChild.kill('SIGTERM')
    fs.writeFileSync(signalled.rollbackRelease, '')
    const childExit = await waitForExit(signalledChild, 'signalled rollback installer')
    assert.notEqual(childExit.status, 0)
    assert.equal(childExit.signal, null)
    assertOld(signalled, true)
  } finally {
    await terminateAndWait(signalledChild, 'signalled rollback installer')
    fs.rmSync(signalled.base, { recursive: true, force: true })
  }

  const markerOnly = fixture()
  try {
    const marker = path.join(markerOnly.gateStateDir, 'install-incomplete')
    fs.mkdirSync(markerOnly.gateStateDir, { mode: 0o750 })
    fs.writeFileSync(marker, 'ACTIVE\n', { mode: 0o640 })
    const resumed = execute(markerOnly)
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.equal(fs.existsSync(marker), false)
    for (const target of markerOnly.targets) assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /^old-/)
  } finally {
    fs.rmSync(markerOnly.base, { recursive: true, force: true })
  }

  for (const killStage of ['before-gate', 'after-gate', 'after-journal']) {
    const interrupted = fixture({ killStage })
    try {
      const killed = execute(interrupted)
      assert.equal(killed.signal, 'SIGKILL', killStage)
      const journal = path.join(interrupted.serverRoot, 'state/install-v4.journal')
      assert.equal(fs.existsSync(journal), killStage === 'after-journal', killStage)
      if (killStage === 'after-gate') {
        const wrapperHarness = path.join(interrupted.base, 'after-gate-wrapper')
        writeExecutable(wrapperHarness, fixtureGateSource(interrupted, fs.readFileSync(interrupted.gate, 'utf8')))
        const delegated = spawnSync(wrapperHarness, [], {
          encoding: 'utf8', env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
        })
        assert.equal(delegated.status, 0, delegated.stderr)
      }
      const resumed = execute(interrupted)
      assert.equal(resumed.status, 0, resumed.stderr)
      assert.equal(fs.existsSync(journal), false)
      assert.equal(fs.existsSync(path.join(interrupted.gateStateDir, 'install-incomplete')), false)
    } finally {
      fs.rmSync(interrupted.base, { recursive: true, force: true })
    }
  }

  for (let index = 0; index < targetCount; index += 1) {
    const interrupted = fixture({ killAfterReplacement: index })
    try {
      const killed = execute(interrupted)
      assert.equal(killed.signal, 'SIGKILL', `replacement ${index}`)
      const journal = path.join(interrupted.serverRoot, 'state/install-v4.journal')
      assert.equal(fs.existsSync(journal), true, `replacement ${index}`)
      if ((fs.statSync(interrupted.gate).mode & 0o111) === 0) {
        const blocked = spawnSync(interrupted.gate, [], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: 'deploy-v4' } })
        assert.notEqual(blocked.status, 0, `replacement ${index}`)
      } else {
        const wrapperHarness = path.join(interrupted.base, 'wrapper-harness')
        writeExecutable(wrapperHarness, fixtureGateSource(interrupted, fs.readFileSync(interrupted.gate, 'utf8')))
        const blocked = spawnSync(wrapperHarness, [], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v4' }
        })
        assert.notEqual(blocked.status, 0, `replacement ${index}`)
        assert.match(blocked.stderr, /DEPLOY_INSTALL_INCOMPLETE/)
      }

      const resumed = execute(interrupted)
      assert.equal(resumed.status, 0, resumed.stderr)
      assert.equal(fs.existsSync(journal), false)
      for (const target of interrupted.targets) assert.equal(fs.existsSync(target), true)
      assert.doesNotMatch(resumed.stdout + resumed.stderr, /systemctl|docker compose|compose up/i)
    } finally {
      fs.rmSync(interrupted.base, { recursive: true, force: true })
    }
  }

  for (let index = 0; index < targetCount; index += 1) {
    const context = fixture({ replaceFailure: index })
    try {
      const result = execute(context)
      assert.notEqual(result.status, 0, `replacement ${index} unexpectedly succeeded`)
      assertOld(context, true)
    } finally {
      fs.rmSync(context.base, { recursive: true, force: true })
    }
  }

  const post = fixture({ postFailure: true })
  try {
    assert.notEqual(execute(post).status, 0)
    assertOld(post, true)
    assertDurableRenames(fs.readFileSync(post.fsyncTrace, 'utf8').trim().split('\n'), '.kinvest-v4-restore.')
  } finally {
    fs.rmSync(post.base, { recursive: true, force: true })
  }

  const absent = fixture({ existing: false, replaceFailure: 4 })
  try {
    assert.notEqual(execute(absent).status, 0)
    assertOld(absent, false)
  } finally {
    fs.rmSync(absent.base, { recursive: true, force: true })
  }

  const success = fixture()
  try {
    const result = execute(success)
    assert.equal(result.status, 0, result.stderr)
    for (const target of success.targets) assert.equal(fs.existsSync(target), true)
    assert.equal(fs.readFileSync(success.targets[2], 'utf8'), fs.readFileSync(success.targets[3], 'utf8'))
    assert.equal(fs.readFileSync(success.targets[7], 'utf8'), fs.readFileSync(path.join(sourceDir, 'kinvest-nginx-fixed-ip-gate'), 'utf8'))
    assert.equal(fs.readFileSync(success.targets[8], 'utf8'), fs.readFileSync(path.join(sourceDir, 'docker-compose.nginx-fixed-ip.yml'), 'utf8'))
    assert.equal(fs.readFileSync(success.targets[9], 'utf8'), fs.readFileSync(path.join(sourceDir, 'kinvest-nginx-config-installer-v1'), 'utf8'))
    assert.equal(fs.readFileSync(success.targets[5], 'utf8'),
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest ""\n' +
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 ""\n' +
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v4 ""\n')
    assert.equal(fs.readFileSync(path.join(success.gateStateDir, 'identity'), 'utf8'), `user=lighthouse\ngroup=lighthouse\ngid=${process.getgid()}\n`)
    assert.equal(fs.existsSync(path.join(success.gateStateDir, 'install.lock')), false)
    for (const command of ['deploy-kinvest', 'deploy-kinvest-v3', 'deploy-kinvest-v4']) {
      assert.match(installerSource, new RegExp(`sudo -n -U "\\$GATE_USER" -l "\\$LOCAL_SBIN/${command}"`))
    }
    const trace = fs.readFileSync(success.fsyncTrace, 'utf8').trim().split('\n')
    assertDurableRenames(trace, '.kinvest-v4-install.')
    const publish = trace.indexOf('publish')
    const clear = trace.lastIndexOf('clear')
    const publicMarker = path.join(success.gateStateDir, 'install-incomplete')
    const privateJournal = path.join(success.serverRoot, 'state/install-v4.journal')
    const publicRename = trace.findIndex((line) => line.endsWith(`:${publicMarker}`))
    const privateRename = trace.findIndex((line) => line.endsWith(`:${privateJournal}`))
    const publicTemporary = trace[publicRename].split(':')[1]
    const publicClear = trace.lastIndexOf('public-clear')
    assert.ok(publish > 0 && clear > publish)
    assert.ok(publicRename > publish && privateRename > publicRename)
    assert.ok(trace.lastIndexOf(`file:${publicTemporary}`, publicRename) >= 0)
    assert.ok(trace.slice(publicRename + 1, privateRename).includes(`dir:${success.gateStateDir}`))
    assert.ok(trace.lastIndexOf(`dir:${path.dirname(privateJournal)}`, publicClear) > clear)
    assert.ok(trace.slice(publicClear + 1).includes(`dir:${success.gateStateDir}`))
    assert.ok(trace.slice(0, publish).some((line) => /file:.*manifest\.txt$/.test(line)))
    assert.ok(trace.slice(0, publish).some((line) => /dir:.*kinvest-deploy-v4-backup\./.test(line)))
    for (const directory of new Set(success.targets.map((target) => path.dirname(target)))) {
      assert.ok(trace.slice(publish + 1, clear).includes(`dir:${directory}`), directory)
    }
    assert.doesNotMatch(result.stdout + result.stderr, /systemctl|docker compose|compose up/i)
  } finally {
    fs.rmSync(success.base, { recursive: true, force: true })
  }

  const identityReentry = fixture()
  try {
    assert.equal(execute(identityReentry).status, 0)
    const mismatch = execute(identityReentry, {
      KINVEST_DEPLOY_GATE_USER: 'alternate',
      KINVEST_DEPLOY_GATE_GROUP: 'alternate'
    })
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /DEPLOY_V4_GATE_IDENTITY_MISMATCH/)
  } finally {
    fs.rmSync(identityReentry.base, { recursive: true, force: true })
  }

  const v3Journal = fixture()
  try {
    const journal = path.join(v3Journal.serverRoot, 'state/install-v3.journal')
    fs.writeFileSync(journal, 'private-v3\n', { mode: 0o600 })
    const result = execute(v3Journal)
    assert.equal(result.status, 76)
    assert.match(result.stderr, /DEPLOY_INSTALL_INCOMPLETE/)
    assert.equal(fs.existsSync(journal), true)
    assertOld(v3Journal, true)
  } finally {
    fs.rmSync(v3Journal.base, { recursive: true, force: true })
  }
}

module.exports = { run }

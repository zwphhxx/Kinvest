const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const sourcePath = path.join(rootDir, 'deploy/server/migrate-deploy-gate-identity.sh')
const gateSource = fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-ssh-command-v3'), 'utf8')

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture({ distinctGids = false, realFlock = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-gate-identity-migration-'))
  const gateDir = path.join(base, 'gate')
  const serverRoot = path.join(base, 'server')
  const stateDir = path.join(serverRoot, 'state')
  const bin = path.join(base, 'bin')
  const lockLog = path.join(base, 'locks.log')
  const availableGids = [...new Set([process.getgid(), ...process.getgroups()])]
  const currentGid = distinctGids && availableGids.length > 1 ? availableGids[0] : process.getgid()
  const targetGid = distinctGids && availableGids.length > 1
    ? availableGids.find((gid) => gid !== currentGid)
    : distinctGids && process.getuid() === 0 ? currentGid + 1 : process.getgid()
  if (distinctGids && currentGid === targetGid) throw new Error('distinct gid test path unavailable')

  fs.mkdirSync(gateDir, { mode: 0o750 })
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin)
  fs.chmodSync(gateDir, 0o750)
  fs.writeFileSync(
    path.join(gateDir, 'identity'),
    `user=current-user\ngroup=current-group\ngid=${currentGid}\n`,
    { mode: 0o640 }
  )
  fs.chownSync(gateDir, process.getuid(), currentGid)
  fs.chownSync(path.join(gateDir, 'identity'), process.getuid(), currentGid)
  fs.chmodSync(path.join(gateDir, 'identity'), 0o640)
  fs.writeFileSync(path.join(stateDir, 'deploy.lock'), '', { mode: 0o600 })

  writeExecutable(path.join(bin, 'getent'), `#!/usr/bin/env bash
case "$1:$2:\${FAKE_IDENTITY_MODE:-}" in
  passwd:current-user:missing-current-user|passwd:target-user:missing-target-user) exit 2 ;;
  group:current-group:missing-current-group|group:target-group:missing-target-group) exit 2 ;;
  passwd:current-user:*|passwd:target-user:*) printf '%s:x:1001:${currentGid}:Deploy:/nonexistent:/usr/sbin/nologin\\n' "$2" ;;
  group:current-group:*) printf '%s:x:${currentGid}:\\n' "$2" ;;
  group:target-group:*) printf '%s:x:${targetGid}:\\n' "$2" ;;
  *) exit 2 ;;
esac
`)
  writeExecutable(path.join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == -G && ( "$2" == current-user || "$2" == target-user ) ]]; then
  if [[ "\${FAKE_IDENTITY_MODE:-}" == target-membership-mismatch && "$2" == target-user ]]; then
    printf '99999\\n'
  else
    printf '${currentGid} ${targetGid}\\n'
  fi
  exit 0
fi
exec /usr/bin/id "$@"
`)
  if (!realFlock) writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
fd="\${*: -1}"
printf '%s\\n' "$fd" >>"$MIGRATION_LOCK_LOG"
if [[ "$fd" == 8 && "\${MIGRATION_BUSY_GATE:-}" == 1 ]]; then exit 1; fi
if [[ "$fd" == 9 && "\${MIGRATION_BUSY_DEPLOY:-}" == 1 ]]; then exit 1; fi
exit 0
`)
  writeExecutable(path.join(bin, 'mv'), `#!/usr/bin/env bash
args=()
for argument in "$@"; do [[ "$argument" == -fT || "$argument" == -f ]] || args+=("$argument"); done
exec /bin/mv -f "\${args[@]}"
`)

  const source = fs.readFileSync(sourcePath, 'utf8')
  const instrumented = source
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${gateDir}'`)
    .replace("SERVER_ROOT='/root/docker/kinvest'", `SERVER_ROOT='${serverRoot}'`)
    .replace("ROOT_UID='0'", `ROOT_UID='${process.getuid()}'`)
    .replace('[[ "$(id -u)" -eq 0 ]]', '[[ "${KINVEST_GATE_MIGRATION_TEST_ROOT:-}" == 1 ]]')
  const script = path.join(base, 'migrate.sh')
  writeExecutable(script, instrumented)

  return { base, bin, currentGid, gateDir, lockLog, script, serverRoot, stateDir, targetGid }
}

function environment(context, overrides = {}) {
  return {
    ...process.env,
    KINVEST_GATE_MIGRATION_TEST_ROOT: '1',
    MIGRATION_LOCK_LOG: context.lockLog,
    PATH: `${context.bin}:${process.env.PATH}`,
    ...overrides
  }
}

function execute(context, overrides = {}, args = ['current-user', 'current-group', 'target-user', 'target-group']) {
  return spawnSync('bash', [context.script, ...args], {
    encoding: 'utf8',
    env: environment(context, overrides)
  })
}

function assertCurrent(context) {
  const identity = path.join(context.gateDir, 'identity')
  assert.equal(
    fs.readFileSync(identity, 'utf8'),
    `user=current-user\ngroup=current-group\ngid=${context.currentGid}\n`
  )
  assert.equal(fs.statSync(context.gateDir).mode & 0o777, 0o750)
  assert.equal(fs.statSync(identity).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(context.gateDir), ['identity'])
}

function assertTarget(context) {
  const identity = path.join(context.gateDir, 'identity')
  assert.equal(
    fs.readFileSync(identity, 'utf8'),
    `user=target-user\ngroup=target-group\ngid=${context.targetGid}\n`
  )
  assert.equal(fs.statSync(context.gateDir).mode & 0o777, 0o750)
  assert.equal(fs.statSync(identity).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(context.gateDir), ['identity'])
}

function withFixture(callback, options = {}) {
  const context = fixture(options)
  try {
    return callback(context)
  } finally {
    fs.rmSync(context.base, { recursive: true, force: true })
  }
}

function waitFor(check, timeoutMs = 3000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for migration boundary'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('migration child did not exit'))
    }, timeoutMs)
    child.once('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ signal, status })
    })
  })
}

function startPaused(context, pauseAt) {
  const ready = path.join(context.base, `${pauseAt}.ready`)
  const release = path.join(context.base, `${pauseAt}.release`)
  let stdout = ''
  let stderr = ''
  const child = spawn('bash', [context.script, 'current-user', 'current-group', 'target-user', 'target-group'], {
    env: environment(context, {
      KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY: '1',
      KINVEST_DEPLOY_GATE_MIGRATION_PAUSE_AT: pauseAt,
      KINVEST_DEPLOY_GATE_MIGRATION_PAUSE_READY: ready,
      KINVEST_DEPLOY_GATE_MIGRATION_PAUSE_RELEASE: release
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, ready, release, stderr: () => stderr, stdout: () => stdout }
}

function writeGateHarness(context) {
  const harness = path.join(context.base, 'forced-command-gate')
  writeExecutable(harness, gateSource
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${context.gateDir}'`)
    .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
    .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
    .replace(
      'effective_groups = {os.getegid(), *os.getgroups()}',
      `effective_groups = {${context.currentGid}, ${context.targetGid}}`
    ))
  return harness
}

function assertForcedCommandFailsClosed(context, harness) {
  const result = spawnSync(harness, [], {
    encoding: 'utf8',
    env: { ...process.env, SSH_ORIGINAL_COMMAND: 'deploy-v4' }
  })
  assert.equal(result.status, 76)
  assert.equal(result.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')
}

async function run() {
  const source = fs.readFileSync(sourcePath, 'utf8')
  assert.match(source, /^#!\/usr\/bin\/env bash/)
  assert.match(source, /GATE_STATE_DIR='\/var\/lib\/kinvest-deploy-gate'/)
  assert.match(source, /SERVER_ROOT='\/root\/docker\/kinvest'/)
  assert.match(source, /flock -n 8/)
  assert.match(source, /flock -n 9/)
  assert.ok(source.indexOf('flock -n 8') < source.indexOf('flock -n 9'))
  const directoryChown = source.indexOf('chown "$ROOT_UID:$target_gid" "$GATE_STATE_DIR"')
  const identityReplace = source.indexOf('stage_and_replace_identity "$target_user"')
  const markerChown = source.indexOf('chown "$ROOT_UID:$target_gid" "$INSTALL_MARKER"')
  const markerUnlink = source.indexOf('rm -f -- "$INSTALL_MARKER"')
  assert.ok(directoryChown > 0 && directoryChown < identityReplace)
  assert.ok(identityReplace < markerChown && markerChown < markerUnlink)
  assert.doesNotMatch(source, /(?:^|\s)(?:docker|systemctl|sqlite3)(?:\s|$)|compose\s|authorized_keys|sudoers/im)
  assert.doesNotMatch(source, /install-deploy-v4\.sh/)

  withFixture((context) => {
    const result = execute(context)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'DEPLOY_GATE_IDENTITY_MIGRATION_OK\n')
    assert.equal(result.stderr, '')
    assert.deepEqual(fs.readFileSync(context.lockLog, 'utf8').trim().split('\n'), ['8', '9'])
    assertTarget(context)

    const reentry = execute(context)
    assert.notEqual(reentry.status, 0)
    assert.equal(reentry.stdout, '')
    assert.equal(reentry.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH\n')
    assertTarget(context)
  })

  for (const args of [[], ['current-user'], ['current-user', 'current-group', 'target-user', 'target-group', 'extra']]) {
    withFixture((context) => {
      const result = execute(context, {}, args)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_USAGE\n')
      assertCurrent(context)
    })
  }

  withFixture((context) => {
    const result = execute(context, {}, ['current-user;bad', 'current-group', 'target-user', 'target-group'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID\n')
    assertCurrent(context)
  })

  for (const mode of [
    'missing-current-user', 'missing-current-group', 'missing-target-user',
    'missing-target-group', 'target-membership-mismatch'
  ]) {
    withFixture((context) => {
      const result = execute(context, { FAKE_IDENTITY_MODE: mode })
      assert.notEqual(result.status, 0, mode)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID\n', mode)
      assertCurrent(context)
    })
  }

  for (const mutation of [
    (context) => fs.chmodSync(context.gateDir, 0o755),
    (context) => fs.chmodSync(path.join(context.gateDir, 'identity'), 0o600),
    (context) => fs.writeFileSync(path.join(context.gateDir, 'extra'), 'unsafe\n'),
    (context) => fs.writeFileSync(path.join(context.gateDir, 'install-incomplete'), 'ACTIVE\n'),
    (context) => fs.writeFileSync(path.join(context.gateDir, '.identity.ABC123'), 'partial\n'),
    (context) => {
      fs.unlinkSync(path.join(context.gateDir, 'identity'))
      fs.symlinkSync('/dev/null', path.join(context.gateDir, 'identity'))
    }
  ]) {
    withFixture((context) => {
      mutation(context)
      const result = execute(context)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
    })
  }

  withFixture((context) => {
    fs.writeFileSync(path.join(context.gateDir, 'identity'), 'user=wrong\ngroup=current-group\ngid=0\n')
    fs.chmodSync(path.join(context.gateDir, 'identity'), 0o640)
    const result = execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH\n')
  })

  for (const { busy, expectedLocks } of [
    { busy: 'MIGRATION_BUSY_GATE', expectedLocks: ['8'] },
    { busy: 'MIGRATION_BUSY_DEPLOY', expectedLocks: ['8', '9'] }
  ]) {
    withFixture((context) => {
      const result = execute(context, { [busy]: '1' })
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_BUSY\n')
      assert.deepEqual(fs.readFileSync(context.lockLog, 'utf8').trim().split('\n'), expectedLocks)
      assertCurrent(context)
    })
  }

  for (const journal of ['install-v3.journal', 'install-v4.journal']) {
    withFixture((context) => {
      fs.writeFileSync(path.join(context.stateDir, journal), 'ACTIVE\n', { mode: 0o600 })
      const result = execute(context)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_INSTALL_INCOMPLETE\n')
      assertCurrent(context)
    })
  }

  for (const failurePoint of [
    'after-marker',
    'after-directory-group',
    'after-identity-replace',
    'after-marker-unlink',
    'after-final-validation'
  ]) {
    withFixture((context) => {
      const result = execute(context, {
        KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY: '1',
        KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT: failurePoint
      })
      assert.notEqual(result.status, 0, failurePoint)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', failurePoint)
      assertCurrent(context)
    })
  }

  withFixture((context) => {
    const result = execute(context, {
      KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT: 'after-marker'
    })
    assert.equal(result.status, 0, result.stderr)
    assertTarget(context)
  })

  withFixture((context) => {
    const result = execute(context, {
      KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY: '1',
      KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT: 'after-identity-replace',
      KINVEST_DEPLOY_GATE_MIGRATION_ROLLBACK_FAIL: '1'
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED\n')
    assert.equal(fs.existsSync(path.join(context.gateDir, 'install-incomplete')), true)
  })

  withFixture((context) => {
    const result = execute(context, {
      KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY: '1',
      KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT: 'after-marker-unlink',
      KINVEST_DEPLOY_GATE_MIGRATION_ROLLBACK_FAIL: '1'
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED\n')
    const marker = path.join(context.gateDir, 'install-incomplete')
    assert.equal(fs.existsSync(marker), true)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ACTIVE\n')
  })

  withFixture((context) => {
    const identity = path.join(context.gateDir, 'identity')
    fs.linkSync(identity, path.join(context.base, 'identity-hardlink'))
    const result = execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
  })

  for (const pauseAt of ['marker-staged', 'after-directory-group']) {
    const context = fixture()
    try {
      const paused = startPaused(context, pauseAt)
      await waitFor(() => fs.existsSync(paused.ready))
      paused.child.kill('SIGTERM')
      const result = await waitForExit(paused.child)
      assert.equal(result.signal, null, pauseAt)
      assert.equal(result.status, 76, pauseAt)
      assert.equal(paused.stdout(), '', pauseAt)
      assert.equal(paused.stderr(), 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', pauseAt)
      assertCurrent(context)
    } finally {
      fs.rmSync(context.base, { recursive: true, force: true })
    }
  }

  if (spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0) {
    const context = fixture({ realFlock: true })
    const ready = path.join(context.base, 'real-flock.ready')
    const holder = spawn('flock', ['-x', context.gateDir, 'sh', '-c', `: >'${ready}'; sleep 30`], { stdio: 'ignore' })
    try {
      await waitFor(() => fs.existsSync(ready))
      const result = execute(context)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_BUSY\n')
      assertCurrent(context)
    } finally {
      holder.kill('SIGKILL')
      await waitForExit(holder).catch(() => {})
      fs.rmSync(context.base, { recursive: true, force: true })
    }
  }

  const distinctGidsAvailable = new Set([process.getgid(), ...process.getgroups()]).size > 1 || process.getuid() === 0
  if (distinctGidsAvailable) {
    const boundaries = [
      { pauseAt: 'marker-staged', directory: 'current', identity: 'current', marker: null, temporary: ['.install-incomplete.', 'current'] },
      { pauseAt: 'marker-published', directory: 'current', identity: 'current', marker: 'current', temporary: null },
      { pauseAt: 'after-directory-group', directory: 'target', identity: 'current', marker: 'current', temporary: null },
      { pauseAt: 'identity-staged', directory: 'target', identity: 'current', marker: 'current', temporary: ['.identity.', 'target'] },
      { pauseAt: 'after-identity-replace', directory: 'target', identity: 'target', marker: 'current', temporary: null },
      { pauseAt: 'before-marker-unlink', directory: 'target', identity: 'target', marker: 'target', temporary: null }
    ]
    for (const boundary of boundaries) {
      const context = fixture({ distinctGids: true })
      try {
        const paused = startPaused(context, boundary.pauseAt)
        await waitFor(() => fs.existsSync(paused.ready))
        const gids = { current: context.currentGid, target: context.targetGid }
        assert.notEqual(gids.current, gids.target)
        assert.equal(fs.statSync(context.gateDir).gid, gids[boundary.directory], boundary.pauseAt)
        assert.equal(fs.lstatSync(path.join(context.gateDir, 'identity')).gid, gids[boundary.identity], boundary.pauseAt)
        if (boundary.marker) {
          assert.equal(fs.lstatSync(path.join(context.gateDir, 'install-incomplete')).gid, gids[boundary.marker], boundary.pauseAt)
        } else {
          assert.equal(fs.existsSync(path.join(context.gateDir, 'install-incomplete')), false, boundary.pauseAt)
        }
        if (boundary.temporary) {
          const temporary = fs.readdirSync(context.gateDir).find((name) => name.startsWith(boundary.temporary[0]))
          assert.ok(temporary, boundary.pauseAt)
          assert.equal(fs.lstatSync(path.join(context.gateDir, temporary)).gid, gids[boundary.temporary[1]], boundary.pauseAt)
        }
        assertForcedCommandFailsClosed(context, writeGateHarness(context))
        paused.child.kill('SIGTERM')
        const result = await waitForExit(paused.child)
        assert.equal(result.status, 76, boundary.pauseAt)
        assert.equal(paused.stderr(), 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', boundary.pauseAt)
        assertCurrent(context)
      } finally {
        fs.rmSync(context.base, { recursive: true, force: true })
      }
    }
  }
}

module.exports = { run }

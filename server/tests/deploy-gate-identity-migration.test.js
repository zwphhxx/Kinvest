const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { spawnTestProcess } = require('./helpers/deployment-test-process')

const rootDir = path.resolve(__dirname, '../..')
const sourcePath = path.join(rootDir, 'deploy/server/migrate-deploy-gate-identity.sh')
const manifestPath = path.join(rootDir, 'deploy/server/deploy-gate-identity-migration.sha256')
const runbookPath = path.join(rootDir, 'docs/operations/deploy-v4-access-control-runbook.md')
const gateSource = fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-ssh-command-v3'), 'utf8')

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture({ distinctGids = false, failAt = '', pauseAt = '', realFlock = false, rollbackFailAt = '', systemIdentity = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-gate-identity-migration-'))
  const gateDir = path.join(base, 'gate')
  const serverRoot = path.join(base, 'server')
  const stateDir = path.join(serverRoot, 'state')
  const bin = path.join(base, 'bin')
  const lockLog = path.join(base, 'locks.log')
  const availableGids = [...new Set([process.getgid(), ...process.getgroups()])]
  const currentUser = systemIdentity?.currentUser || 'current-user'
  const currentGroup = systemIdentity?.currentGroup || 'current-group'
  const targetUser = systemIdentity?.targetUser || 'target-user'
  const targetGroup = systemIdentity?.targetGroup || 'target-group'
  const currentGid = systemIdentity?.currentGid ?? (distinctGids && availableGids.length > 1 ? availableGids[0] : process.getgid())
  const targetGid = systemIdentity?.targetGid ?? (distinctGids && availableGids.length > 1
    ? availableGids.find((gid) => gid !== currentGid)
    : distinctGids && process.getuid() === 0 ? currentGid + 1 : process.getgid())
  if (distinctGids && currentGid === targetGid) throw new Error('distinct gid test path unavailable')

  fs.mkdirSync(gateDir, { mode: 0o750 })
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin)
  fs.chmodSync(gateDir, 0o750)
  fs.writeFileSync(
    path.join(gateDir, 'identity'),
    `user=${currentUser}\ngroup=${currentGroup}\ngid=${currentGid}\n`,
    { mode: 0o640 }
  )
  fs.chownSync(gateDir, process.getuid(), currentGid)
  fs.chownSync(path.join(gateDir, 'identity'), process.getuid(), currentGid)
  fs.chmodSync(path.join(gateDir, 'identity'), 0o640)
  fs.writeFileSync(path.join(stateDir, 'deploy.lock'), '', { mode: 0o600 })

  if (!systemIdentity) writeExecutable(path.join(bin, 'getent'), `#!/usr/bin/env bash
case "$1:$2:\${FAKE_IDENTITY_MODE:-}" in
  passwd:current-user:missing-current-user|passwd:target-user:missing-target-user) exit 2 ;;
  group:current-group:missing-current-group|group:target-group:missing-target-group) exit 2 ;;
  passwd:current-user:*|passwd:target-user:*) printf '%s:x:1001:${currentGid}:Deploy:/nonexistent:/usr/sbin/nologin\\n' "$2" ;;
  group:current-group:*) printf '%s:x:${currentGid}:\\n' "$2" ;;
  group:target-group:*) printf '%s:x:${targetGid}:\\n' "$2" ;;
  *) exit 2 ;;
esac
`)
  if (!systemIdentity) writeExecutable(path.join(bin, 'id'), `#!/usr/bin/env bash
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
  let instrumented = source
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${gateDir}'`)
    .replace("SERVER_ROOT='/root/docker/kinvest'", `SERVER_ROOT='${serverRoot}'`)
    .replace("ROOT_UID='0'", `ROOT_UID='${process.getuid()}'`)
    .replace(
      '# migration-fixture-path-anchor',
      `# migration-fixture-path-anchor\nPATH='${bin}:/usr/sbin:/usr/bin:/sbin:/bin'\nexport PATH`
    )
    .replace('[[ "$(id -u)" -eq 0 ]]', '[[ "${KINVEST_GATE_MIGRATION_TEST_ROOT:-}" == 1 ]]')
  const pauseFunction = pauseAt
    ? `migration_fixture_pause() {
  : >"$MIGRATION_FIXTURE_PAUSE_READY" || return 1
  while [[ ! -e "$MIGRATION_FIXTURE_PAUSE_RELEASE" ]]; do sleep 0.01; done
}`
    : 'migration_fixture_pause() { return 0; }'
  instrumented = instrumented.replace(
    '# migration-test-instrumentation-anchor',
    `# migration-test-instrumentation-anchor\n${pauseFunction}`
  )
  const forwardMarkers = {
    'after-marker': 'forward-marker-published',
    'after-directory-group': 'forward-directory-owned',
    'after-identity-replace': 'forward-identity-replaced',
    'after-marker-unlink': 'forward-marker-unlinked',
    'after-final-validation': 'forward-final-validated'
  }
  const pauseMarkers = {
    'marker-staged': 'forward-marker-staged',
    'marker-published': 'forward-marker-published',
    'after-directory-group': 'forward-directory-owned',
    'identity-staged': 'forward-identity-staged',
    'after-identity-replace': 'forward-identity-replaced',
    'before-marker-unlink': 'forward-marker-target-owned'
  }
  if (failAt) {
    const marker = `# migration-boundary-${forwardMarkers[failAt]}`
    instrumented = instrumented.replace(marker, `${marker}\n  return 1`)
  }
  if (rollbackFailAt) {
    const marker = `# migration-boundary-${rollbackFailAt}`
    instrumented = instrumented.replace(marker, `${marker}\n  return 1`)
  }
  if (pauseAt) {
    const marker = `# migration-boundary-${pauseMarkers[pauseAt] || pauseAt}`
    instrumented = instrumented.replace(marker, `${marker}\n  migration_fixture_pause || return 1`)
  }
  const script = path.join(base, 'migrate.sh')
  writeExecutable(script, instrumented)

  return {
    base, bin, currentGid, currentGroup, currentUser, gateDir,
    processes: [],
    phase: `migration:${pauseAt || 'execute'}:${failAt || 'forward'}:${rollbackFailAt || 'no-rollback-failure'}`,
    identityArgs: [currentUser, currentGroup, targetUser, targetGroup],
    lockLog, script, serverRoot, stateDir, targetGid, targetGroup, targetUser
  }
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

async function execute(context, overrides = {}, args = context.identityArgs) {
  const managed = spawnTestProcess('bash', [context.script, ...args], {
    env: environment(context, overrides),
    stdio: ['ignore', 'pipe', 'pipe']
  }, { label: context.phase })
  context.processes.push(managed)
  let stdout = ''
  let stderr = ''
  managed.child.stdout.on('data', (chunk) => { stdout += chunk })
  managed.child.stderr.on('data', (chunk) => { stderr += chunk })
  const result = await managed.waitForExit(`${context.phase}:exit`)
  await managed.cleanup(`${context.phase}:cleanup`)
  return { ...result, stdout, stderr }
}

function boundedSync(command, args, options = {}, label = 'migration:probe') {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`${label}: DEPLOY_TEST_EXIT_TIMEOUT`)
  }
  return result
}

function assertCurrent(context) {
  const identity = path.join(context.gateDir, 'identity')
  assert.equal(
    fs.readFileSync(identity, 'utf8'),
    `user=${context.currentUser}\ngroup=${context.currentGroup}\ngid=${context.currentGid}\n`
  )
  assert.equal(fs.statSync(context.gateDir).mode & 0o777, 0o750)
  assert.equal(fs.statSync(identity).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(context.gateDir), ['identity'])
}

function assertTarget(context) {
  const identity = path.join(context.gateDir, 'identity')
  assert.equal(
    fs.readFileSync(identity, 'utf8'),
    `user=${context.targetUser}\ngroup=${context.targetGroup}\ngid=${context.targetGid}\n`
  )
  assert.equal(fs.statSync(context.gateDir).mode & 0o777, 0o750)
  assert.equal(fs.statSync(identity).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(context.gateDir), ['identity'])
}

async function removeFixture(context) {
  let failure
  for (const managed of context.processes) {
    try { await managed.cleanup() } catch (error) { failure ||= error }
  }
  if (failure) throw failure
  fs.rmSync(context.base, { recursive: true, force: true })
}

async function withFixture(callback, options = {}) {
  const context = fixture(options)
  try {
    return await callback(context)
  } finally {
    await removeFixture(context)
  }
}

function startPaused(context, pauseAt) {
  const ready = path.join(context.base, `${pauseAt}.ready`)
  const release = path.join(context.base, `${pauseAt}.release`)
  let stdout = ''
  let stderr = ''
  const phase = `migration:${pauseAt}`
  const managed = spawnTestProcess('/bin/bash', [context.script, ...context.identityArgs], {
    env: environment(context, {
      MIGRATION_FIXTURE_PAUSE_READY: ready,
      MIGRATION_FIXTURE_PAUSE_RELEASE: release
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  }, { label: phase })
  context.processes.push(managed)
  const { child } = managed
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { ...managed, phase, ready, release, stderr: () => stderr, stdout: () => stdout }
}

function writeGateHarness(context, visibleGids = [context.currentGid, context.targetGid], suffix = 'both') {
  const harness = path.join(context.base, `forced-command-gate-${suffix}`)
  writeExecutable(harness, gateSource
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${context.gateDir}'`)
    .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
    .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
    .replace(
      'effective_groups = {os.getegid(), *os.getgroups()}',
      `effective_groups = {${visibleGids.join(', ')}}`
    ))
  return harness
}

function assertForcedCommandFailsClosedForBothPrincipals(context) {
  assertForcedCommandFailsClosed(context, writeGateHarness(context, [context.currentGid], 'source-only'))
  assertForcedCommandFailsClosed(context, writeGateHarness(context, [context.targetGid], 'target-only'))
}

function exactCurrentState(context) {
  try {
    assertCurrent(context)
    return true
  } catch {
    return false
  }
}

function assertSourceOrWrapperFailClosed(context) {
  if (exactCurrentState(context)) return
  assertForcedCommandFailsClosedForBothPrincipals(context)
}

function systemFlockAvailable() {
  return boundedSync('flock', ['--version'], { stdio: 'ignore' }, 'migration:flock-availability').status === 0
}

function probeExclusiveLock(pathname, expectedAvailable, label) {
  const result = boundedSync('flock', ['-n', '-x', pathname, 'true'], { stdio: 'ignore' }, label)
  assert.equal(result.status === 0, expectedAvailable, pathname)
}

function discoverSystemIdentityPair() {
  const passwd = boundedSync('/usr/bin/getent', ['passwd'], { encoding: 'utf8' }, 'migration:system-passwd')
  const groups = boundedSync('/usr/bin/getent', ['group'], { encoding: 'utf8' }, 'migration:system-groups')
  if (passwd.status !== 0 || groups.status !== 0) return null
  const groupByGid = new Map(groups.stdout.trim().split('\n').map((line) => {
    const [name, , gid] = line.split(':')
    return [Number(gid), name]
  }))
  const identities = []
  for (const line of passwd.stdout.trim().split('\n')) {
    const [user, , , primaryGid] = line.split(':')
    const gid = Number(primaryGid)
    const group = groupByGid.get(gid)
    if (!user || !group || !Number.isInteger(gid)) continue
    const membership = boundedSync('/usr/bin/id', ['-G', user], { encoding: 'utf8' }, 'migration:system-membership')
    if (membership.status !== 0 || !membership.stdout.trim().split(/\s+/).includes(String(gid))) continue
    identities.push({ gid, group, user })
  }
  for (const current of identities) {
    const target = identities.find((candidate) => candidate.user !== current.user && candidate.gid !== current.gid)
    if (target) return {
      currentGid: current.gid,
      currentGroup: current.group,
      currentUser: current.user,
      targetGid: target.gid,
      targetGroup: target.group,
      targetUser: target.user
    }
  }
  return null
}

function assertForcedCommandFailsClosed(context, harness) {
  const result = boundedSync(harness, [], {
    encoding: 'utf8',
    env: { ...process.env, SSH_ORIGINAL_COMMAND: 'deploy-v4' }
  }, `${context.phase}:forced-command`)
  assert.equal(result.status, 76)
  assert.equal(result.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')
}

async function run() {
  await require('./deployment-test-process.test').run()
  const source = fs.readFileSync(sourcePath, 'utf8')
  assert.match(source, /^#!\/bin\/bash$/m)
  assert.match(source, /^PATH='\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'$/m)
  assert.match(source, /unset BASH_ENV ENV CDPATH PYTHONPATH PYTHONHOME PYTHONOPTIMIZE/)
  assert.ok((source.match(/\/usr\/bin\/python3 -I -/g) || []).length >= 6)
  assert.doesNotMatch(source, /^\s*assert\b/m)
  assert.doesNotMatch(source, /KINVEST_DEPLOY_GATE_MIGRATION_TEST_|test_pause_if_requested|test_failure_requested/)
  assert.doesNotMatch(source, /MIGRATION_FIXTURE_|while \[\[ ! -e "\$release"/)
  for (const marker of [
    'migration-test-instrumentation-anchor',
    'migration-boundary-forward-marker-staged',
    'migration-boundary-forward-marker-unlinked',
    'migration-boundary-forward-final-validated',
    'migration-boundary-rollback-marker-owned',
    'migration-boundary-rollback-final-validated'
  ]) assert.match(source, new RegExp(`# ${marker}`), marker)

  const manifest = fs.readFileSync(manifestPath, 'utf8')
  const manifestMatch = manifest.match(/^([0-9a-f]{64}) {2}migrate-deploy-gate-identity\.sh\n$/)
  assert.ok(manifestMatch)
  assert.equal(
    manifestMatch[1],
    crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')
  )
  const runbook = fs.readFileSync(runbookPath, 'utf8')
  const migrationSection = runbook.slice(
    runbook.indexOf('## One-time gate identity migration'),
    runbook.indexOf('If a protocol-v4 RESTORE')
  )
  const pinnedMatch = migrationSection.match(/PINNED_MIGRATION_SHA256='([0-9a-f]{64})'/)
  assert.ok(pinnedMatch)
  assert.equal(pinnedMatch[1], manifestMatch[1])
  assert.equal(pinnedMatch[1], crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'))
  const serverInstructions = migrationSection.slice(migrationSection.indexOf('PINNED_MIGRATION_SHA256='))
  assert.doesNotMatch(serverInstructions, /deploy-gate-identity-migration\.sha256/)
  assert.doesNotMatch(serverInstructions, /\/root\/kinvest-reviewed\/[^\s`]*\.sha256/)
  assert.match(serverInstructions, /root_staged_hash=.*sha256sum/)
  assert.match(serverInstructions, /"\$root_staged_hash" = "\$PINNED_MIGRATION_SHA256"/)
  assert.match(serverInstructions, /sudo \/usr\/bin\/env -i PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/)
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

  await withFixture(async (context) => {
    const malicious = path.join(context.base, 'malicious-python')
    const imported = path.join(context.base, 'sitecustomize-imported')
    fs.mkdirSync(malicious)
    fs.writeFileSync(
      path.join(malicious, 'sitecustomize.py'),
      `from pathlib import Path\nPath(${JSON.stringify(imported)}).write_text('imported')\n`
    )
    fs.chmodSync(context.gateDir, 0o755)
    const result = await execute(context, { PYTHONOPTIMIZE: '1', PYTHONPATH: malicious })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
    assert.equal(fs.existsSync(imported), false)
  })

  await withFixture(async (context) => {
    const result = await execute(context)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'DEPLOY_GATE_IDENTITY_MIGRATION_OK\n')
    assert.equal(result.stderr, '')
    assert.deepEqual(fs.readFileSync(context.lockLog, 'utf8').trim().split('\n'), ['8', '9'])
    assertTarget(context)

    const reentry = await execute(context)
    assert.notEqual(reentry.status, 0)
    assert.equal(reentry.stdout, '')
    assert.equal(reentry.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH\n')
    assertTarget(context)
  })

  for (const args of [[], ['current-user'], ['current-user', 'current-group', 'target-user', 'target-group', 'extra']]) {
    await withFixture(async (context) => {
      const result = await execute(context, {}, args)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_USAGE\n')
      assertCurrent(context)
    })
  }

  await withFixture(async (context) => {
    const result = await execute(context, {}, ['current-user;bad', 'current-group', 'target-user', 'target-group'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID\n')
    assertCurrent(context)
  })

  for (const mode of [
    'missing-current-user', 'missing-current-group', 'missing-target-user',
    'missing-target-group', 'target-membership-mismatch'
  ]) {
    await withFixture(async (context) => {
      const result = await execute(context, { FAKE_IDENTITY_MODE: mode })
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
    await withFixture(async (context) => {
      mutation(context)
      const result = await execute(context)
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
    })
  }

  await withFixture(async (context) => {
    fs.writeFileSync(path.join(context.gateDir, 'identity'), 'user=wrong\ngroup=current-group\ngid=0\n')
    fs.chmodSync(path.join(context.gateDir, 'identity'), 0o640)
    const result = await execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH\n')
  })

  for (const { busy, expectedLocks } of [
    { busy: 'MIGRATION_BUSY_GATE', expectedLocks: ['8'] },
    { busy: 'MIGRATION_BUSY_DEPLOY', expectedLocks: ['8', '9'] }
  ]) {
    await withFixture(async (context) => {
      const result = await execute(context, { [busy]: '1' })
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_BUSY\n')
      assert.deepEqual(fs.readFileSync(context.lockLog, 'utf8').trim().split('\n'), expectedLocks)
      assertCurrent(context)
    })
  }

  for (const journal of ['install-v3.journal', 'install-v4.journal']) {
    await withFixture(async (context) => {
      fs.writeFileSync(path.join(context.stateDir, journal), 'ACTIVE\n', { mode: 0o600 })
      const result = await execute(context)
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
    await withFixture(async (context) => {
      const result = await execute(context)
      assert.notEqual(result.status, 0, failurePoint)
      assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', failurePoint)
      assertCurrent(context)
    }, { failAt: failurePoint })
  }

  await withFixture(async (context) => {
    const result = await execute(context, {
      KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT: 'after-marker'
    })
    assert.equal(result.status, 0, result.stderr)
    assertTarget(context)
  })

  await withFixture(async (context) => {
    const result = await execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED\n')
    assert.equal(fs.existsSync(path.join(context.gateDir, 'install-incomplete')), true)
  }, { failAt: 'after-identity-replace', rollbackFailAt: 'rollback-marker-owned' })

  await withFixture(async (context) => {
    const result = await execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED\n')
    const marker = path.join(context.gateDir, 'install-incomplete')
    assert.equal(fs.existsSync(marker), true)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ACTIVE\n')
  }, { failAt: 'after-marker-unlink', rollbackFailAt: 'rollback-marker-owned' })

  for (const rollbackFailAt of [
    'rollback-marker-owned',
    'rollback-directory-owned',
    'rollback-identity-replaced',
    'rollback-temporaries-cleaned',
    'rollback-marker-unlinked',
    'rollback-final-fsync',
    'rollback-final-validated'
  ]) {
    await withFixture(async (context) => {
      const result = await execute(context)
      assert.notEqual(result.status, 0, rollbackFailAt)
      assertSourceOrWrapperFailClosed(context)
      if (result.stderr === 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED\n') {
        assertForcedCommandFailsClosedForBothPrincipals(context)
      } else {
        assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', rollbackFailAt)
      }
    }, { failAt: 'after-identity-replace', rollbackFailAt })
  }

  await withFixture(async (context) => {
    const identity = path.join(context.gateDir, 'identity')
    fs.linkSync(identity, path.join(context.base, 'identity-hardlink'))
    const result = await execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
  })

  for (const pauseAt of ['marker-staged', 'after-directory-group']) {
    const context = fixture({ pauseAt })
    let paused
    try {
      paused = startPaused(context, pauseAt)
      await paused.waitForReady(() => fs.existsSync(paused.ready), paused.phase + ":ready")
      paused.child.kill('SIGTERM')
      const result = await paused.waitForExit(paused.phase + ":exit")
      assert.equal(result.signal, null, pauseAt)
      assert.equal(result.status, 76, pauseAt)
      assert.equal(paused.stdout(), '', pauseAt)
      assert.equal(paused.stderr(), 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', pauseAt)
      assertCurrent(context)
    } finally {
      await removeFixture(context)
    }
  }

  const realFlock = systemFlockAvailable()
  if (process.platform === 'linux') assert.equal(realFlock, true, 'Linux CI must provide util-linux flock')
  if (realFlock) {
    for (const lockKind of ['gate', 'deploy']) {
      const context = fixture({ realFlock: true })
      const ready = path.join(context.base, `real-${lockKind}-flock.ready`)
      const lockPath = lockKind === 'gate' ? context.gateDir : path.join(context.stateDir, 'deploy.lock')
      try {
        const holder = spawnTestProcess('flock', [
          '-x', lockPath, 'sh', '-c', `: >'${ready}'; while :; do sleep 1; done`
        ], { stdio: 'ignore' }, { label: `migration:flock-holder:${lockKind}` })
        context.processes.push(holder)
        await holder.waitForReady(() => fs.existsSync(ready), `migration:flock-holder:${lockKind}:ready`)
        const result = await execute(context)
        assert.notEqual(result.status, 0)
        assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_BUSY\n')
        assertCurrent(context)
      } finally {
        await removeFixture(context)
      }
    }

    for (const scenario of [
      { failAt: '', pauseAt: 'after-directory-group', terminalStatus: 0 },
      { failAt: 'after-identity-replace', pauseAt: 'rollback-directory-owned', terminalStatus: 76 }
    ]) {
      const context = fixture({ ...scenario, realFlock: true })
      let paused
      try {
        paused = startPaused(context, scenario.pauseAt)
        await paused.waitForReady(() => fs.existsSync(paused.ready), paused.phase + ":ready")
        probeExclusiveLock(context.gateDir, false, `${paused.phase}:gate-lock-held`)
        probeExclusiveLock(path.join(context.stateDir, 'deploy.lock'), false, `${paused.phase}:deploy-lock-held`)
        fs.writeFileSync(paused.release, '')
        const result = await paused.waitForExit(paused.phase + ":exit")
        assert.equal(result.status, scenario.terminalStatus, scenario.pauseAt)
        probeExclusiveLock(context.gateDir, true, `${paused.phase}:gate-lock-released`)
        probeExclusiveLock(path.join(context.stateDir, 'deploy.lock'), true, `${paused.phase}:deploy-lock-released`)
      } finally {
        await removeFixture(context)
      }
    }
  }

  const distinctGidsAvailable = new Set([process.getgid(), ...process.getgroups()]).size > 1 || process.getuid() === 0
  if (distinctGidsAvailable) {
    let distinctGidCoverageRan = false
    const boundaries = [
      { pauseAt: 'marker-staged', directory: 'current', identity: 'current', marker: null, temporary: ['.install-incomplete.', 'current'] },
      { pauseAt: 'marker-published', directory: 'current', identity: 'current', marker: 'current', temporary: null },
      { pauseAt: 'after-directory-group', directory: 'target', identity: 'current', marker: 'current', temporary: null },
      { pauseAt: 'identity-staged', directory: 'target', identity: 'current', marker: 'current', temporary: ['.identity.', 'target'] },
      { pauseAt: 'after-identity-replace', directory: 'target', identity: 'target', marker: 'current', temporary: null },
      { pauseAt: 'before-marker-unlink', directory: 'target', identity: 'target', marker: 'target', temporary: null }
    ]
    for (const boundary of boundaries) {
      distinctGidCoverageRan = true
      const context = fixture({ distinctGids: true, pauseAt: boundary.pauseAt })
      let paused
      try {
        paused = startPaused(context, boundary.pauseAt)
        await paused.waitForReady(() => fs.existsSync(paused.ready), paused.phase + ":ready")
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
        assertForcedCommandFailsClosedForBothPrincipals(context)
        paused.child.kill('SIGTERM')
        const result = await paused.waitForExit(paused.phase + ":exit")
        assert.equal(result.status, 76, boundary.pauseAt)
        assert.equal(paused.stderr(), 'DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK\n', boundary.pauseAt)
        assertCurrent(context)
      } finally {
        await removeFixture(context)
      }
    }
    if (process.platform === 'linux') assert.equal(distinctGidCoverageRan, true)
  }

  if (process.env.KINVEST_GATE_IDENTITY_ROOT_LINUX_INTEGRATION === '1') {
    assert.equal(process.platform, 'linux')
    assert.equal(process.getuid(), 0)
    assert.equal(realFlock, true)
    const systemIdentity = discoverSystemIdentityPair()
    assert.ok(systemIdentity, 'root/Linux integration requires two existing distinct identity pairs')
    await withFixture(async (context) => {
      const result = await execute(context)
      assert.equal(result.status, 0, result.stderr)
      assertTarget(context)
    }, { realFlock: true, systemIdentity })
  }
}

module.exports = { run }

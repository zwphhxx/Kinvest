const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const sourcePath = path.join(rootDir, 'deploy/server/migrate-deploy-gate-identity.sh')

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-gate-identity-migration-'))
  const gateDir = path.join(base, 'gate')
  const serverRoot = path.join(base, 'server')
  const stateDir = path.join(serverRoot, 'state')
  const bin = path.join(base, 'bin')
  const lockLog = path.join(base, 'locks.log')
  const currentGid = process.getgid()
  const targetGid = process.getgid()

  fs.mkdirSync(gateDir, { mode: 0o750 })
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin)
  fs.chmodSync(gateDir, 0o750)
  fs.writeFileSync(
    path.join(gateDir, 'identity'),
    `user=current-user\ngroup=current-group\ngid=${currentGid}\n`,
    { mode: 0o640 }
  )
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
  writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
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

function withFixture(callback) {
  const context = fixture()
  try {
    return callback(context)
  } finally {
    fs.rmSync(context.base, { recursive: true, force: true })
  }
}

async function run() {
  const source = fs.readFileSync(sourcePath, 'utf8')
  assert.match(source, /^#!\/usr\/bin\/env bash/)
  assert.match(source, /GATE_STATE_DIR='\/var\/lib\/kinvest-deploy-gate'/)
  assert.match(source, /SERVER_ROOT='\/root\/docker\/kinvest'/)
  assert.match(source, /flock -n 8/)
  assert.match(source, /flock -n 9/)
  assert.ok(source.indexOf('flock -n 8') < source.indexOf('flock -n 9'))
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

  for (const failurePoint of ['after-marker', 'after-directory-group', 'after-identity-replace']) {
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
    const identity = path.join(context.gateDir, 'identity')
    fs.linkSync(identity, path.join(context.base, 'identity-hardlink'))
    const result = execute(context)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE\n')
  })
}

module.exports = { run }

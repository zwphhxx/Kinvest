const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnTestProcess } = require('./helpers/deployment-test-process')

const rootDir = path.resolve(__dirname, '../..')
const assetPath = path.join(rootDir, 'deploy/server/kinvest-nginx-config-installer-v1')
const oldConfig = 'events {}\nhttp { server { listen 80; } }\n'
const candidateConfig = 'events {}\nhttp { server { listen 443 ssl; } }\n'
const oldNginxId = '1'.repeat(64)
const newNginxId = '2'.repeat(64)
const rollbackNginxId = '3'.repeat(64)
const oldKinvestId = '4'.repeat(64)
const changedKinvestId = '5'.repeat(64)
const originalIp = '172.19.0.9'

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

function write(file, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, { mode })
  fs.chmodSync(file, mode)
}

function writeExecutable(file, contents) {
  write(file, contents, 0o755)
}

function fixture({ targetMode = 0o600 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-nginx-config-installer-'))
  const targetDir = path.join(base, 'docker/nginx/conf')
  const target = path.join(targetDir, 'nginx.conf')
  const backupRoot = path.join(base, 'backups')
  const runRoot = path.join(base, 'run')
  const bin = path.join(base, 'bin')
  const gate = path.join(base, 'kinvest-nginx-fixed-ip-gate')
  const lockFile = path.join(runRoot, 'installer.lock')
  const deployLock = path.join(base, 'state/deploy.lock')
  const operations = path.join(base, 'operations.log')
  const gateCount = path.join(base, 'gate.count')
  const nginxId = path.join(base, 'nginx.id')
  const kinvestId = path.join(base, 'kinvest.id')
  const nginxIp = path.join(base, 'nginx.ip')
  const containerHash = path.join(base, 'container.hash')
  const candidate = path.join(base, 'candidate.conf')
  const containerCandidate = path.join(base, 'container-candidate.conf')

  for (const directory of [targetDir, backupRoot, runRoot, bin, path.dirname(deployLock)]) fs.mkdirSync(directory, { recursive: true })
  fs.chmodSync(targetDir, 0o755)
  fs.chmodSync(backupRoot, 0o700)
  write(target, oldConfig, targetMode)
  write(candidate, candidateConfig, 0o600)
  write(operations, '')
  write(gateCount, '0\n')
  write(nginxId, `${oldNginxId}\n`)
  write(kinvestId, `${oldKinvestId}\n`)
  write(nginxIp, `${originalIp}\n`)
  write(containerHash, `${sha256(oldConfig)}\n`)

  writeExecutable(path.join(bin, 'id'), `#!/bin/sh
if [ "\${1:-}" = -u ]; then printf '%s\\n' "\${FAKE_UID:-${process.getuid()}}"; exit 0; fi
exec /usr/bin/id "$@"
`)
  writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env python3
import fcntl
import os
import sys

descriptor = int(sys.argv[-1])
with open('${operations}', 'a', encoding='utf-8') as stream:
    stream.write(f'flock:{descriptor}\\n')
if os.environ.get('SHARED_LOCK_FAIL') == '1' and descriptor == 8:
    raise SystemExit(1)
if os.environ.get('OWN_LOCK_FAIL') == '1' and descriptor == 9:
    raise SystemExit(1)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(1)
`)
  writeExecutable(path.join(bin, 'mktemp'), `#!/usr/bin/env bash
set -euo pipefail
created="$(/usr/bin/mktemp "$@")"
printf '%s\\n' "$created"
if [[ -n "\${SIGNAL_AFTER_SNAPSHOT_CREATE:-}" && "$*" == *kinvest-nginx-config.candidate.* ]]; then
  kill -s "$SIGNAL_AFTER_SNAPSHOT_CREATE" "$PPID"
  sleep 1
fi
`)
  writeExecutable(path.join(bin, 'mv'), `#!/usr/bin/env bash
if [[ "\${FAIL_ROLLBACK_MV:-0}" == 1 && "$*" == *'.nginx.conf.rollback.'* ]]; then exit 1; fi
args=()
for argument in "$@"; do [[ "$argument" == -fT || "$argument" == -f ]] || args+=("$argument"); done
/bin/mv -f "\${args[@]}"
status=$?
if [[ -n "\${SIGNAL_AFTER_INSTALL_MV:-}" && "$*" == *'.nginx.conf.install.'* ]]; then
  kill -s "$SIGNAL_AFTER_INSTALL_MV" "$PPID"
  sleep 1
fi
exit "$status"
`)
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker:%s\\n' "$*" >>'${operations}'
if [[ "$1" == inspect ]]; then
  format="$3"
  container="$4"
  if [[ "$format" == *'.Id'* ]]; then
    [[ "$container" == nginx ]] && cat '${nginxId}' || cat '${kinvestId}'
  elif [[ "$format" == *'IPAddress'* && "$container" == nginx ]]; then
    cat '${nginxIp}'
  else
    exit 1
  fi
  exit 0
fi
if [[ "$1" == cp ]]; then
  [[ "$#" == 3 && "$2" == '${runRoot}/kinvest-nginx-config.candidate.'* && "$3" == nginx:/tmp/kinvest-nginx-config-installer-v1.* ]] || exit 90
  cp "$2" '${containerCandidate}'
  exit 0
fi
if [[ "$1" == exec ]]; then
  container="$2"
  shift 2
  if [[ "$container" == nginx && "$1" == rm ]]; then
    [[ "$#" == 4 && "$2" == -f && "$3" == -- && "$4" == /tmp/kinvest-nginx-config-installer-v1.* ]] || exit 91
    if [[ "\${BLOCK_DOCKER_CLEANUP:-0}" == 1 ]]; then
      trap "rm -f '${containerCandidate}'; exit 124" TERM
      sleep 10
    fi
    rm -f '${containerCandidate}'
    exit 0
  fi
  if [[ "$container" == nginx && "$1 $2" == 'nginx -t' ]]; then
    if [[ "$*" == *' -c '* ]]; then
      [[ "$#" == 4 && "$3" == -c && "$4" == /tmp/kinvest-nginx-config-installer-v1.* ]] || exit 92
    else
      [[ "$#" == 2 ]] || exit 93
    fi
    if [[ "$*" == *' -c '* && "\${PREFLIGHT_FAIL:-0}" == 1 ]]; then exit 1; fi
    if [[ "$*" != *' -c '* && "\${POST_TEST_FAIL:-0}" == 1 ]]; then exit 1; fi
    exit 0
  fi
  if [[ "$container" == nginx && "$1 $2" == 'sha256sum /etc/nginx/nginx.conf' ]]; then
    printf '%s  /etc/nginx/nginx.conf\\n' "$(cat '${containerHash}')"
    exit 0
  fi
fi
exit 1
`)
  writeExecutable(gate, `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 && "$1" == apply ]]
count=$(cat '${gateCount}')
count=$((count + 1))
printf '%s\\n' "$count" >'${gateCount}'
printf 'gate:apply:%s\\n' "$count" >>'${operations}'
case ",\${FAIL_GATE_CALLS:-}," in *",$count,"*) exit 1;; esac
if [[ "$count" == 1 && -n "\${HOLD_GATE_MARKER:-}" ]]; then
  : >"$HOLD_GATE_MARKER"
  while [[ ! -e "$RELEASE_GATE_MARKER" ]]; do sleep 0.01; done
fi
if [[ "$count" == 2 && -n "\${SIGNAL_DURING_ROLLBACK:-}" ]]; then
  kill -s "$SIGNAL_DURING_ROLLBACK" "$PPID"
  sleep 1
fi
rm -f '${containerCandidate}'
if [[ "$count" == 1 ]]; then
  [[ "\${NO_NGINX_ID_CHANGE:-0}" == 1 ]] || printf '%s\\n' '${newNginxId}' >'${nginxId}'
  [[ "\${CHANGE_KINVEST_ID:-0}" == 1 ]] && printf '%s\\n' '${changedKinvestId}' >'${kinvestId}'
  [[ "\${CHANGE_IP:-0}" == 1 ]] && printf '%s\\n' '172.19.0.10' >'${nginxIp}'
else
  printf '%s\\n' '${rollbackNginxId}' >'${nginxId}'
  printf '%s\\n' '${originalIp}' >'${nginxIp}'
fi
"${process.env.SHELL || '/bin/sh'}" -c "sha256sum '${target}' | awk '{print \\$1}'" >'${containerHash}'
printf 'KINVEST_NGINX_FIXED_IP_APPLY_OK ip=%s health=ready https=ready\\n' "$(cat '${nginxIp}')"
`)

  const source = fs.readFileSync(assetPath, 'utf8')
    .replace("TARGET='/root/docker/nginx/conf/nginx.conf'", `TARGET='${target}'`)
    .replace("TARGET_DIR='/root/docker/nginx/conf'", `TARGET_DIR='${targetDir}'`)
    .replace("BACKUP_ROOT='/root/docker/nginx/config-install-backups'", `BACKUP_ROOT='${backupRoot}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("GATE='/usr/local/sbin/kinvest-nginx-fixed-ip-gate'", `GATE='${gate}'`)
    .replace("LOCK_FILE='/run/kinvest-nginx-config-installer.lock'", `LOCK_FILE='${lockFile}'`)
    .replace("DEPLOY_LOCK='/root/docker/kinvest/state/deploy.lock'", `DEPLOY_LOCK='${deployLock}'`)
    .replace("CONTAINER_CLEANUP_TIMEOUT_SECONDS='5'", "CONTAINER_CLEANUP_TIMEOUT_SECONDS='0.2'")
    .replace("ROOT_UID='0'", `ROOT_UID='${process.getuid()}'`)
    .replace("ROOT_GID='0'", `ROOT_GID='${process.getgid()}'`)
  const installer = path.join(base, 'installer')
  writeExecutable(installer, source)
  return {
    base, backupRoot, candidate, containerHash, gateCount, installer, kinvestId,
    processes: [],
    nginxId, nginxIp, operations, target, targetDir, runRoot, containerCandidate,
    deployLock, lockFile
  }
}

function execute(context, candidate = context.candidate, expectedHash = sha256(fs.readFileSync(candidate)), extraEnv = {}, label = 'nginx:execute') {
  return executeAsync(context, extraEnv, label, candidate, expectedHash).waitForResult()
}

async function removeFixture(context) {
  let failure
  for (const managed of context.processes) {
    try { await managed.cleanup() } catch (error) { failure ||= error }
  }
  if (failure) throw failure
  fs.rmSync(context.base, { recursive: true, force: true })
}

function backupDirectories(context) {
  return fs.readdirSync(context.backupRoot).map((entry) => path.join(context.backupRoot, entry))
}

function assertOldState(context) {
  assert.equal(fs.readFileSync(context.target, 'utf8'), oldConfig)
  assert.equal(fs.readFileSync(context.containerHash, 'utf8').trim(), sha256(oldConfig))
}

function assertStableFailure(result, code) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, new RegExp(`^${code}(?: backup=[^ ]+ sha256=[0-9a-f]{64})?\\n$`))
  assert.equal(result.stdout, '')
}

function assertTemporaryFilesCleaned(context) {
  assert.equal(fs.existsSync(context.containerCandidate), false)
  assert.deepEqual(
    fs.readdirSync(context.runRoot).filter((entry) => entry.startsWith('kinvest-nginx-config.candidate.')),
    []
  )
  assert.deepEqual(
    fs.readdirSync(context.targetDir).filter((entry) => entry.startsWith('.nginx.conf.')),
    []
  )
}

function holdLock(context, file, marker) {
  const managed = spawnTestProcess('python3', ['-c', `
import fcntl, sys, time
stream = open(sys.argv[1], 'a+')
fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
open(sys.argv[2], 'w').close()
while True: time.sleep(1)
`, file, marker], { stdio: 'ignore' }, { label: 'nginx:deploy-lock-holder' })
  context.processes.push(managed)
  return managed
}

function executeAsync(context, extraEnv = {}, label = 'nginx:execute', candidate = context.candidate, expectedHash = sha256(fs.readFileSync(candidate))) {
  const managed = spawnTestProcess('bash', [context.installer, candidate, expectedHash], {
    env: { ...process.env, ...extraEnv, PATH: `${path.join(context.base, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe']
  }, { label })
  context.processes.push(managed)
  const { child } = managed
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return {
    ...managed,
    async waitForResult() {
      const result = await managed.waitForExit(`${label}:exit`)
      await managed.cleanup(`${label}:cleanup`)
      return { ...result, stderr, stdout }
    }
  }
}

async function run() {
  assert.equal(fs.existsSync(assetPath), true, 'versioned Nginx config installer asset is required')
  const syntax = spawnTestProcess('bash', ['-n', assetPath], { stdio: 'ignore' }, { label: 'nginx:syntax' })
  try { assert.equal((await syntax.waitForExit()).status, 0) } finally { await syntax.cleanup() }

  const success = fixture()
  try {
    const result = await execute(success)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(success.target, 'utf8'), candidateConfig)
    assert.equal(fs.readFileSync(success.containerHash, 'utf8').trim(), sha256(candidateConfig))
    assert.equal(fs.readFileSync(success.nginxId, 'utf8').trim(), newNginxId)
    assert.equal(fs.readFileSync(success.kinvestId, 'utf8').trim(), oldKinvestId)
    assert.equal(fs.readFileSync(success.nginxIp, 'utf8').trim(), originalIp)
    assert.equal(fs.readFileSync(success.gateCount, 'utf8'), '1\n')
    const [backup] = backupDirectories(success)
    assert.match(path.basename(backup), /^install-20[0-9]{6}T[0-9]{6}Z\./)
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(backup, 'nginx.conf.before')).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(path.join(backup, 'nginx.conf.before'), 'utf8'), oldConfig)
    assert.match(fs.readFileSync(path.join(backup, 'evidence'), 'utf8'), /^version=1\nstatus=success\n/)
    assert.match(result.stdout, new RegExp(`^KINVEST_NGINX_CONFIG_INSTALL_OK backup=.* sha256=${sha256(candidateConfig)}\\n$`))
    assert.equal(result.stderr, '')
    assertTemporaryFilesCleaned(success)
  } finally { await removeFixture(success) }

  const preflight = fixture()
  try {
    const result = await execute(preflight, preflight.candidate, undefined, { PREFLIGHT_FAIL: '1' })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_PREFLIGHT_FAILED')
    assertOldState(preflight)
    assert.equal(fs.readFileSync(preflight.gateCount, 'utf8'), '0\n')
    assert.equal(backupDirectories(preflight).length, 0)
    assertTemporaryFilesCleaned(preflight)
  } finally { await removeFixture(preflight) }

  const locked = fixture()
  try {
    const result = await execute(locked, locked.candidate, undefined, { OWN_LOCK_FAIL: '1' })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_LOCKED')
    assertOldState(locked)
    assert.equal(fs.readFileSync(locked.gateCount, 'utf8'), '0\n')
    assert.equal(backupDirectories(locked).length, 0)
  } finally { await removeFixture(locked) }

  const sharedLocked = fixture()
  const sharedMarker = path.join(sharedLocked.base, 'shared-lock-held')
  try {
    const sharedHolder = holdLock(sharedLocked, sharedLocked.deployLock, sharedMarker)
    await sharedHolder.waitForReady(() => fs.existsSync(sharedMarker), 'nginx:deploy-lock-holder:ready')
    const result = await execute(sharedLocked)
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_DEPLOY_LOCKED')
    assertOldState(sharedLocked)
    assert.equal(fs.readFileSync(sharedLocked.gateCount, 'utf8'), '0\n')
  } finally {
    await removeFixture(sharedLocked)
  }

  const concurrent = fixture()
  const gateHeld = path.join(concurrent.base, 'gate-held')
  const gateRelease = path.join(concurrent.base, 'gate-release')
  try {
    const first = executeAsync(concurrent, {
      HOLD_GATE_MARKER: gateHeld, RELEASE_GATE_MARKER: gateRelease
    }, 'nginx:concurrent-first')
    await first.waitForReady(() => fs.existsSync(gateHeld), 'nginx:concurrent-first:gate-ready')
    const second = await execute(concurrent, concurrent.candidate, undefined, {}, 'nginx:concurrent-second')
    assertStableFailure(second, 'KINVEST_NGINX_CONFIG_DEPLOY_LOCKED')
    assert.equal(fs.readFileSync(concurrent.target, 'utf8'), candidateConfig)
    write(gateRelease, '')
    const firstResult = await first.waitForResult()
    assert.equal(firstResult.status, 0, firstResult.stderr)
    const lockOperations = fs.readFileSync(concurrent.operations, 'utf8').match(/^flock:[89]$/gm)
    assert.deepEqual(lockOperations.slice(0, 2), ['flock:8', 'flock:9'])
  } finally {
    try {
      if (!fs.existsSync(gateRelease)) write(gateRelease, '')
    } finally { await removeFixture(concurrent) }
  }

  const signalCase = process.env.KINVEST_NGINX_CONFIG_SIGNAL_CASE || 'all'
  if (signalCase !== 'install-move') {
    const snapshotSignal = fixture()
    try {
      const result = await execute(snapshotSignal, snapshotSignal.candidate, undefined, {
        SIGNAL_AFTER_SNAPSHOT_CREATE: 'TERM'
      })
      assert.notEqual(result.status, 0)
      assertOldState(snapshotSignal)
      assert.equal(fs.readFileSync(snapshotSignal.gateCount, 'utf8'), '0\n')
      assertTemporaryFilesCleaned(snapshotSignal)
    } finally { await removeFixture(snapshotSignal) }
  }

  if (signalCase !== 'snapshot') {
    const installMoveSignal = fixture()
    try {
      const result = await execute(installMoveSignal, installMoveSignal.candidate, undefined, {
        SIGNAL_AFTER_INSTALL_MV: 'TERM'
      })
      assertStableFailure(result, 'KINVEST_NGINX_CONFIG_INTERRUPTED')
      assertOldState(installMoveSignal)
      assert.equal(fs.readFileSync(installMoveSignal.gateCount, 'utf8'), '1\n')
      assertTemporaryFilesCleaned(installMoveSignal)
    } finally { await removeFixture(installMoveSignal) }
  }

  for (const scenario of [
    { code: 'KINVEST_NGINX_CONFIG_GATE_APPLY_FAILED', env: { FAIL_GATE_CALLS: '1' } },
    { code: 'KINVEST_NGINX_CONFIG_NGINX_ID_UNCHANGED', env: { NO_NGINX_ID_CHANGE: '1' } },
    {
      code: 'KINVEST_NGINX_CONFIG_KINVEST_ID_CHANGED',
      outputCode: 'KINVEST_NGINX_CONFIG_ROLLBACK_FAILED',
      evidenceStatus: 'rollback-failed',
      env: { CHANGE_KINVEST_ID: '1' }
    },
    { code: 'KINVEST_NGINX_CONFIG_IP_CHANGED', env: { CHANGE_IP: '1' } }
  ]) {
    const context = fixture()
    try {
      const result = await execute(context, context.candidate, undefined, scenario.env)
      assertStableFailure(result, scenario.outputCode || scenario.code)
      assertOldState(context)
      assert.equal(fs.readFileSync(context.gateCount, 'utf8'), '2\n')
      const [backup] = backupDirectories(context)
      assert.match(fs.readFileSync(path.join(backup, 'evidence'), 'utf8'), new RegExp(`^version=1\\nstatus=${scenario.evidenceStatus || 'rolled-back'}\\nerror=${scenario.code}\\n`))
      const operations = fs.readFileSync(context.operations, 'utf8')
      assert.match(operations, /gate:apply:1/)
      assert.match(operations, /gate:apply:2/)
      assertTemporaryFilesCleaned(context)
    } finally { await removeFixture(context) }
  }

  const mismatch = fixture()
  try {
    const result = await execute(mismatch, mismatch.candidate, '0'.repeat(64))
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_HASH_MISMATCH')
    assertOldState(mismatch)
  } finally { await removeFixture(mismatch) }

  const invalidHash = fixture()
  try {
    const result = await execute(invalidHash, invalidHash.candidate, 'A'.repeat(64))
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_HASH_INVALID')
    assertOldState(invalidHash)
  } finally { await removeFixture(invalidHash) }

  const symlink = fixture()
  try {
    const linked = path.join(symlink.base, 'candidate-link.conf')
    fs.symlinkSync(symlink.candidate, linked)
    const result = await execute(symlink, linked, sha256(candidateConfig))
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_CANDIDATE_INVALID')
    assertOldState(symlink)
  } finally { await removeFixture(symlink) }

  const nonRegular = fixture()
  try {
    const result = await execute(nonRegular, nonRegular.base, '0'.repeat(64))
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_CANDIDATE_INVALID')
    assertOldState(nonRegular)
  } finally { await removeFixture(nonRegular) }

  const nonRoot = fixture()
  try {
    const result = await execute(nonRoot, nonRoot.candidate, undefined, { FAKE_UID: String(process.getuid() + 1) })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_ROOT_REQUIRED')
    assertOldState(nonRoot)
  } finally { await removeFixture(nonRoot) }

  const oversized = fixture()
  try {
    const large = path.join(oversized.base, 'large.conf')
    write(large, 'x'.repeat(1024 * 1024 + 1), 0o600)
    const result = await execute(oversized, large)
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_CANDIDATE_TOO_LARGE')
    assertOldState(oversized)
  } finally { await removeFixture(oversized) }

  const rollbackFailure = fixture()
  try {
    const result = await execute(rollbackFailure, rollbackFailure.candidate, undefined, { FAIL_GATE_CALLS: '1,2' })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_ROLLBACK_FAILED')
    assert.equal(fs.readFileSync(rollbackFailure.target, 'utf8'), oldConfig)
    assert.equal(fs.readFileSync(rollbackFailure.gateCount, 'utf8'), '2\n')
  } finally { await removeFixture(rollbackFailure) }

  const metadataRollback = fixture({ targetMode: 0o644 })
  try {
    const result = await execute(metadataRollback, metadataRollback.candidate, undefined, { FAIL_GATE_CALLS: '1' })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_GATE_APPLY_FAILED')
    assertOldState(metadataRollback)
    assert.equal(fs.statSync(metadataRollback.target).mode & 0o777, 0o644)
  } finally { await removeFixture(metadataRollback) }

  const rollbackSignal = fixture()
  try {
    const result = await execute(rollbackSignal, rollbackSignal.candidate, undefined, {
      FAIL_GATE_CALLS: '1',
      SIGNAL_DURING_ROLLBACK: 'TERM'
    })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_GATE_APPLY_FAILED')
    assertOldState(rollbackSignal)
    assertTemporaryFilesCleaned(rollbackSignal)
  } finally { await removeFixture(rollbackSignal) }

  const blockedCleanup = fixture()
  try {
    const started = Date.now()
    const result = await execute(blockedCleanup, blockedCleanup.candidate, undefined, {
      BLOCK_DOCKER_CLEANUP: '1',
      FAIL_GATE_CALLS: '1'
    })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_ROLLBACK_FAILED')
    assert.ok(Date.now() - started < 3000, 'container cleanup must be bounded')
    assertOldState(blockedCleanup)
    assert.doesNotMatch(result.stdout + result.stderr, /INSTALL_OK/)
    assertTemporaryFilesCleaned(blockedCleanup)
  } finally { await removeFixture(blockedCleanup) }

  const rollbackTemporaryFailure = fixture()
  try {
    const result = await execute(rollbackTemporaryFailure, rollbackTemporaryFailure.candidate, undefined, {
      FAIL_GATE_CALLS: '1',
      FAIL_ROLLBACK_MV: '1'
    })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_ROLLBACK_FAILED')
    assert.equal(fs.readFileSync(rollbackTemporaryFailure.gateCount, 'utf8'), '1\n')
    assertTemporaryFilesCleaned(rollbackTemporaryFailure)
  } finally { await removeFixture(rollbackTemporaryFailure) }

  const secret = fixture()
  try {
    const marker = 'token=KINVEST_SUPER_SECRET_12345'
    write(secret.candidate, `${candidateConfig}# ${marker}\n`, 0o600)
    const result = await execute(secret, secret.candidate, undefined, { PREFLIGHT_FAIL: '1' })
    assertStableFailure(result, 'KINVEST_NGINX_CONFIG_PREFLIGHT_FAILED')
    assert.doesNotMatch(result.stdout + result.stderr, /KINVEST_SUPER_SECRET_12345|token=/)
  } finally { await removeFixture(secret) }
}

module.exports = { run }

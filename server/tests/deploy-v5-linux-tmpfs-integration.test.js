const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const TMPFS_MAGIC = 0x01021994
const rootDir = path.resolve(__dirname, '../..')
const helper = path.join(rootDir, 'deploy/server/deploy-v5-runtime.py')
const executor = path.join(rootDir, 'deploy/server/deploy-kinvest-v5')

/**
 * @param {string} file
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => string} getStderrText
 * @param {number} [timeoutMs]
 */
function waitForFile(file, child, getStderrText, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer)
        resolve()
      } else if (child.exitCode !== null) {
        clearInterval(timer)
        reject(new Error(`fault-barrier child exited early at ${path.basename(file)}: ${getStderrText()}`))
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`fault barrier timeout: ${path.basename(file)}`))
      }
    }, 10)
  })
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runHelper(args, env = {}) {
  /** @type {Record<string, string>} */
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
  )
  Object.assign(childEnv, { PYTHONDONTWRITEBYTECODE: '1' }, env)
  delete childEnv.KINVEST_V5_TEST_ALLOW_NON_TMPFS
  return spawnSync(process.env.PYTHON || 'python3', [helper, ...args], {
    encoding: 'utf8', env: childEnv, timeout: 15000
  })
}

async function killAtBarrier(args, barrierRoot, point, signal) {
  for (const suffix of ['reached', 'release']) {
    fs.rmSync(path.join(barrierRoot, `${point}.${suffix}`), { force: true })
  }
  /** @type {Record<string, string>} */
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
  )
  Object.assign(env, {
    PYTHONDONTWRITEBYTECODE: '1',
    KINVEST_V5_TEST_BARRIER_ROOT: barrierRoot,
    KINVEST_V5_TEST_BARRIER: point
  })
  delete env.KINVEST_V5_TEST_ALLOW_NON_TMPFS
  const child = spawn(process.env.PYTHON || 'python3', [helper, ...args], {
    detached: true, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderrText = ''
  child.stderr.on('data', value => { stderrText += String(value) })
  await waitForFile(path.join(barrierRoot, `${point}.reached`), child, () => stderrText)
  process.kill(-child.pid, signal)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not die at ${point}`)), 5000)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}

async function run() {
  if (process.platform !== 'linux') {
    process.stdout.write('SKIP deploy-v5 Linux tmpfs crash integration: non-Linux\n')
    return
  }

  const tmpfsBase = fs.existsSync('/dev/shm') && fs.statfsSync('/dev/shm').type === TMPFS_MAGIC
    ? '/dev/shm' : '/run'
  assert.equal(fs.statfsSync(tmpfsBase).type, TMPFS_MAGIC,
    'Linux H4-2 integration requires a real writable tmpfs')
  const root = fs.mkdtempSync(path.join(tmpfsBase, 'kinvest-v5-crash-'))
  const runRoot = path.join(root, 'run')
  const accessRoot = path.join(runRoot, 'kinvest-secrets')
  const ifindRoot = path.join(runRoot, 'kinvest-ifind-secrets')
  const stateRoot = path.join(root, 'state')
  const barrierRoot = path.join(root, 'barriers')
  for (const directory of [runRoot, accessRoot, ifindRoot, stateRoot, barrierRoot]) {
    fs.mkdirSync(directory, { mode: 0o700 })
    fs.chmodSync(directory, 0o700)
  }
  fs.chmodSync(runRoot, 0o755)
  const uid = String(process.getuid())
  const gid = String(process.getgid())

  try {
    assert.equal(spawnSync('bash', ['-n', executor], { encoding: 'utf8' }).status, 0,
      'unmodified executor must remain syntactically executable')
    const executorSource = fs.readFileSync(executor, 'utf8')
    assert.match(executorSource, /reserve-registry "\$RUN_ROOT"/)
    assert.match(executorSource, /state-write "\$STATE_ROOT"/)
    assert.doesNotMatch(executorSource, /secure_temp candidate_registry/)

    await killAtBarrier(['reserve-registry', runRoot, uid, gid], barrierRoot,
      'registry-before-create', 'SIGTERM')
    assert.deepEqual(fs.readdirSync(runRoot).filter(name => name.startsWith('kinvest-v5.candidates.')), [])

    await killAtBarrier(['reserve-registry', runRoot, uid, gid], barrierRoot,
      'registry-after-create-zero', 'SIGKILL')
    const zeroRegistry = fs.readdirSync(runRoot).find(name => name.startsWith('kinvest-v5.candidates.'))
    assert.ok(zeroRegistry)
    assert.equal(fs.statSync(path.join(runRoot, zeroRegistry)).size, 0)
    assert.equal(runHelper(['recover', path.join(runRoot, zeroRegistry), runRoot,
      accessRoot, ifindRoot, path.join(root, 'backups'), stateRoot, uid, gid]).status, 0)

    const reserved = runHelper(['reserve-registry', runRoot, uid, gid])
    assert.equal(reserved.status, 0, reserved.stderr)
    const registry = reserved.stdout.trim()
    const payload = path.join(root, 'disabled.payload')
    fs.writeFileSync(payload, [
      'KINVEST_DEPLOY_V5', 'FORWARD',
      `ghcr.io/example/kinvest@sha256:${'a'.repeat(64)}`, 'b'.repeat(40),
      '{}', '{}', 'disabled', '', '', '', '', '{}', 'disabled', '', '', 'EOF'
    ].join('\n') + '\n', { mode: 0o600 })
    await killAtBarrier(['materialize', payload, runRoot, accessRoot, ifindRoot,
      uid, gid, uid, gid, registry], barrierRoot, 'registry-after-replace', 'SIGKILL')
    const backupRoot = path.join(root, 'backups')
    fs.mkdirSync(backupRoot, { mode: 0o700 })
    fs.chmodSync(backupRoot, 0o700)
    assert.equal(runHelper(['recover', registry, runRoot, accessRoot, ifindRoot,
      backupRoot, stateRoot, uid, gid]).status, 0)

    for (const [point, signal] of [
      ['backup-before-link', 'SIGTERM'],
      ['backup-after-link', 'SIGKILL'],
      ['backup-after-unlink', 'SIGKILL']
    ]) {
      const reservedBackup = runHelper(['reserve-registry', runRoot, uid, gid])
      assert.equal(reservedBackup.status, 0, reservedBackup.stderr)
      const backupRegistry = reservedBackup.stdout.trim()
      const reservedTemp = runHelper(['reserve-backup-temp', backupRoot, backupRegistry,
        runRoot, uid, gid])
      assert.equal(reservedTemp.status, 0, reservedTemp.stderr)
      const sourceBackup = reservedTemp.stdout.trim()
      fs.writeFileSync(sourceBackup, point, { mode: 0o600 })
      fs.chmodSync(sourceBackup, 0o600)
      assert.equal(runHelper(['seal-backup-temp', backupRoot, sourceBackup, backupRegistry,
        runRoot, uid, gid]).status, 0)
      await killAtBarrier(['commit-backup', backupRoot, sourceBackup,
        `${point}.sqlite`, uid, gid, backupRegistry, runRoot],
      barrierRoot, point, signal)
      assert.equal(runHelper(['recover', backupRegistry, runRoot, accessRoot, ifindRoot,
        backupRoot, stateRoot, uid, gid]).status, 0)
      assert.equal(fs.readdirSync(backupRoot).some(name => name.includes(point)), false)
    }

    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const suffix = signal.toLowerCase()
      const reservedBackup = runHelper(['reserve-registry', runRoot, uid, gid])
      assert.equal(reservedBackup.status, 0, reservedBackup.stderr)
      const backupRegistry = reservedBackup.stdout.trim()
      const reservedTemp = runHelper(['reserve-backup-temp', backupRoot, backupRegistry,
        runRoot, uid, gid])
      assert.equal(reservedTemp.status, 0, reservedTemp.stderr)
      const sourceBackup = reservedTemp.stdout.trim()
      const finalBackup = path.join(backupRoot, `same-collision-${suffix}.sqlite`)
      fs.writeFileSync(sourceBackup, 'same-content', { mode: 0o600 })
      fs.writeFileSync(finalBackup, 'same-content', { mode: 0o600 })
      fs.chmodSync(sourceBackup, 0o600)
      fs.chmodSync(finalBackup, 0o600)
      assert.equal(runHelper(['seal-backup-temp', backupRoot, sourceBackup, backupRegistry,
        runRoot, uid, gid]).status, 0)
      assert.notEqual(fs.statSync(sourceBackup).ino, fs.statSync(finalBackup).ino)
      await killAtBarrier(['commit-backup', backupRoot, sourceBackup,
        path.basename(finalBackup), uid, gid, backupRegistry, runRoot],
      barrierRoot, 'backup-before-link', signal)
      assert.equal(runHelper(['recover', backupRegistry, runRoot, accessRoot, ifindRoot,
        backupRoot, stateRoot, uid, gid]).status, 0)
      assert.equal(fs.existsSync(sourceBackup), false)
      assert.equal(fs.readFileSync(finalBackup, 'utf8'), 'same-content')
      assert.equal(fs.existsSync(backupRegistry), false)
    }

    const source = path.join(root, 'state-source')
    const journalPayload = JSON.stringify({
      candidateAccessId: 'none',
      candidateIfindId: 'none',
      intent: 'FORWARD',
      pendingBackupChecksum: 'none',
      pendingBackupPath: 'none',
      phase: 'prepared',
      version: 2
    }) + '\n'
    for (const [name, point, signal, payload] of [
      ['deploy-v5.journal', 'journal-after-rename', 'SIGTERM', journalPayload],
      ['current.state', 'current-after-rename', 'SIGKILL', 'durable-state\n']
    ]) {
      fs.writeFileSync(source, payload, { mode: 0o600 })
      await killAtBarrier(['state-write', stateRoot, name, source, uid, gid],
        barrierRoot, point, signal)
      assert.equal(fs.readFileSync(path.join(stateRoot, name), 'utf8'), payload)
      const retry = runHelper(['state-write', stateRoot, name, source, uid, gid])
      assert.equal(retry.status, 0, retry.stderr)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = { run }

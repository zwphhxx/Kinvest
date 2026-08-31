const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { spawn, spawnSync } = require('node:child_process')
const { observeInstallerProcess } = require('./helpers/deploy-v3-process-lifecycle')

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.pid = 42
    this.exitCode = null
    this.signalCode = null
    this.killCount = 0
  }

  exit(status = 0, signal = null) {
    this.exitCode = status
    this.signalCode = signal
    this.emit('exit', status, signal)
  }

  kill() {
    this.killCount += 1
    queueMicrotask(() => this.exit(null, 'SIGKILL'))
    return true
  }
}

function ownedGroupExists(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return false
  const probe = spawnSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8', timeout: 1000 })
  if (probe.status === 0) return true
  if (probe.status === 1) return false
  throw new Error('test process group inspection failed')
}

async function forceCleanupOwnedGroup(child) {
  if (ownedGroupExists(child)) {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (ownedGroupExists(child)) throw error }
  }
  const deadline = performance.now() + 5000
  while (ownedGroupExists(child)) {
    if (performance.now() >= deadline) throw new Error('test process group cleanup failed')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function run() {
  const alreadyExited = new FakeChild()
  alreadyExited.exit(0)
  const alreadyObserved = observeInstallerProcess(alreadyExited)
  assert.deepEqual(await alreadyObserved.waitForExit(), { status: 0, signal: null })
  await alreadyObserved.cleanup()
  assert.equal(alreadyExited.killCount, 0)

  const earlyExit = new FakeChild()
  const earlyObserved = observeInstallerProcess(earlyExit)
  earlyExit.exit(7)
  assert.deepEqual(await earlyObserved.waitForExit(), { status: 7, signal: null })
  await assert.rejects(earlyObserved.waitForReady(() => false), /exited before readiness/)
  await earlyObserved.cleanup()

  const spawnFailure = new FakeChild()
  spawnFailure.pid = undefined
  const failedObserved = observeInstallerProcess(spawnFailure)
  spawnFailure.emit('error', new Error('untrusted child error details'))
  await assert.rejects(failedObserved.waitForExit(), /^Error: v3 installer process failed$/)
  await failedObserved.cleanup()
  assert.equal(spawnFailure.killCount, 0)

  const readyChild = new FakeChild()
  const readyObserved = observeInstallerProcess(readyChild)
  let ready = false
  queueMicrotask(() => { ready = true })
  await readyObserved.waitForReady(() => ready)
  readyChild.exit(0)
  await readyObserved.cleanup()

  const missingReady = new FakeChild()
  const missingObserved = observeInstallerProcess(missingReady, { readyTimeoutMs: 0 })
  await assert.rejects(missingObserved.waitForReady(() => false), /timed out.*readiness/)
  await missingObserved.cleanup()
  assert.equal(missingReady.killCount, 1)
  assert.equal(missingReady.signalCode, 'SIGKILL')

  const timedOut = new FakeChild()
  const cleanupOrder = []
  timedOut.once('exit', () => cleanupOrder.push('exit'))
  const timeoutObserved = observeInstallerProcess(timedOut, { completionTimeoutMs: 0 })
  await assert.rejects(timeoutObserved.waitForExit(), /completion budget/)
  await timeoutObserved.cleanup()
  assert.equal(timedOut.signalCode, 'SIGKILL', 'the child must exit before fixture removal')
  cleanupOrder.push('fixture-removed')
  await timeoutObserved.cleanup()
  assert.deepEqual(cleanupOrder, ['exit', 'fixture-removed'])
  assert.equal(timedOut.killCount, 1)
  assert.equal(timedOut.listenerCount('exit'), 0)
  assert.equal(timedOut.listenerCount('error'), 0)

  const slowChild = new FakeChild()
  const slowObserved = observeInstallerProcess(slowChild)
  const delayedExit = setTimeout(() => slowChild.exit(0), 6000)
  try {
    assert.deepEqual(await slowObserved.waitForExit(), { status: 0, signal: null })
    assert.equal(slowChild.killCount, 0, 'valid completion beyond the former five-second budget must survive')
  } finally {
    clearTimeout(delayedExit)
    await slowObserved.cleanup()
  }

  const liveError = new FakeChild()
  const liveObserved = observeInstallerProcess(liveError)
  liveError.emit('error', new Error('live child error'))
  await assert.rejects(liveObserved.waitForExit(), /process failed/)
  await liveObserved.cleanup()
  assert.equal(liveError.killCount, 1, 'an error event alone does not prove a live child exited')

  const refusedChild = new FakeChild()
  const refusedObserved = observeInstallerProcess(refusedChild, {
    terminate: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }
  })
  await assert.rejects(refusedObserved.cleanup(), /termination failed/)
  refusedChild.exit(0)

  const stuckChild = new FakeChild()
  const stuckObserved = observeInstallerProcess(stuckChild, { cleanupTimeoutMs: 0, terminate: () => {} })
  await assert.rejects(stuckObserved.cleanup(), /cleanup did not exit/)
  stuckChild.exit(0)

  assert.throws(() => observeInstallerProcess(new FakeChild(), { completionTimeoutMs: -1 }), /invalid.*budget/)

  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: process.platform !== 'win32'
  })
  const workerObserved = observeInstallerProcess(worker, {
    ownedProcessGroup: process.platform !== 'win32'
  })
  try {
    await once(worker, 'spawn')
    await workerObserved.cleanup()
    assert.equal(worker.signalCode, 'SIGKILL')
  } finally {
    if (process.platform === 'win32') await workerObserved.cleanup()
    else await forceCleanupOwnedGroup(worker)
  }

  if (process.platform !== 'win32') {
    for (const exitCode of [0, 7]) {
      const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.exit(${exitCode})`
      const parent = spawn(process.execPath, ['-e', source], { stdio: 'ignore', detached: true })
      const parentObserved = observeInstallerProcess(parent, { ownedProcessGroup: true })
      try {
        assert.deepEqual(await parentObserved.waitForExit(), { status: exitCode, signal: null })
        assert.equal(ownedGroupExists(parent), true, 'a descendant must survive the parent for this regression')
        await parentObserved.cleanup()
        assert.equal(ownedGroupExists(parent), false, 'cleanup must remove descendants even after the parent exits')
      } finally {
        await forceCleanupOwnedGroup(parent)
      }
    }
  }

  console.log('deploy-v3-process-lifecycle: PASS')
}

module.exports = { run }

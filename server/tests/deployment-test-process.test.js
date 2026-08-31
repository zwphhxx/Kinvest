const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { observeTestProcess, spawnTestProcess } = require('./helpers/deployment-test-process')

function fakeChild() {
  const events = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => true
  })
  const child = /** @type {import('node:child_process').ChildProcess} */ (/** @type {unknown} */ (events))
  const close = (status = 0, signal = null) => {
    Object.assign(events, { exitCode: status, signalCode: signal })
    events.emit('exit', status, signal)
    events.emit('close', status, signal)
  }
  const setPid = (pid) => { Object.assign(events, { pid }) }
  return { child, close, setPid }
}

async function run() {
  {
    const fixture = fakeChild()
    fixture.close()
    const process = observeTestProcess(fixture.child, { label: 'already-exited' })
    assert.deepEqual(await process.waitForExit(), { status: 0, signal: null })
    await process.cleanup()
  }
  {
    const fixture = fakeChild()
    const process = observeTestProcess(fixture.child, { label: 'migration-marker' })
    fixture.close(76)
    await assert.rejects(process.waitForReady(() => false), /migration-marker: DEPLOY_TEST_EARLY_EXIT/)
    await process.cleanup()
  }
  {
    const fixture = fakeChild()
    const process = observeTestProcess(fixture.child, { label: 'spawn-error' })
    fixture.child.emit('error', new Error('sensitive simulated child error'))
    await assert.rejects(process.waitForReady(() => false), (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /spawn-error: DEPLOY_TEST_PROCESS_ERROR/)
      assert.doesNotMatch(error.message, /sensitive/)
      return true
    })
    await process.cleanup()
  }
  {
    const fixture = fakeChild()
    let kills = 0
    const process = observeTestProcess(fixture.child, {
      label: 'bounded-readiness', readyTimeoutMs: 15,
      terminate: () => { kills += 1; fixture.close(null, 'SIGKILL') }
    })
    await assert.rejects(process.waitForReady(() => false), /bounded-readiness: DEPLOY_TEST_READY_TIMEOUT/)
    const firstCleanup = process.cleanup()
    assert.equal(process.cleanup(), firstCleanup)
    await firstCleanup
    assert.equal(kills, 1)
    assert.equal(fixture.child.listenerCount('exit'), 0)
    assert.equal(fixture.child.listenerCount('close'), 0)
    assert.equal(fixture.child.listenerCount('error'), 0)
  }
  {
    const fixture = fakeChild()
    const order = []
    const process = observeTestProcess(fixture.child, {
      label: 'bounded-completion', completionTimeoutMs: 15,
      terminate: () => { order.push('terminate'); fixture.close(null, 'SIGKILL') }
    })
    await assert.rejects(process.waitForExit(), /bounded-completion: DEPLOY_TEST_EXIT_TIMEOUT/)
    await process.cleanup()
    order.push('fixture-removal')
    assert.deepEqual(order, ['terminate', 'fixture-removal'])
  }
  {
    const fixture = fakeChild()
    const process = observeTestProcess(fixture.child, {
      label: 'predicate-error', terminate: () => fixture.close()
    })
    await assert.rejects(process.waitForReady(() => { throw new Error('private path') }),
      /predicate-error: DEPLOY_TEST_READY_CHECK_FAILED/)
    await process.cleanup()
  }
  for (const status of [0, 7]) {
    const fixture = fakeChild()
    fixture.setPid(424242)
    fixture.close(status)
    let groupPresent = true
    let kills = 0
    const process = observeTestProcess(fixture.child, {
      label: `parent-exited-${status}`, ownedProcessGroup: true,
      groupExists: () => groupPresent,
      terminate: () => { kills += 1; groupPresent = false }
    })
    await process.cleanup()
    assert.equal(kills, 1)
    assert.equal(groupPresent, false)
  }
  for (const code of ['ESRCH', 'EPERM']) {
    const fixture = fakeChild()
    fixture.setPid(424242)
    let closed = false
    const process = observeTestProcess(fixture.child, {
      label: `exit-notification-race-${code}`, ownedProcessGroup: true,
      groupExists: () => false,
      terminate: () => {
        queueMicrotask(() => { fixture.close(); closed = true })
        throw Object.assign(new Error('simulated termination race'), { code })
      }
    })
    await process.cleanup()
    assert.equal(closed, true)
    assert.equal(fixture.child.listenerCount('close'), 0)
  }
  {
    const fixture = fakeChild()
    fixture.setPid(424242)
    let removed = false
    const process = observeTestProcess(fixture.child, {
      label: 'permission-denied-live-group', ownedProcessGroup: true,
      groupExists: () => true,
      terminate: () => { throw Object.assign(new Error('simulated denial'), { code: 'EPERM' }) }
    })
    await assert.rejects((async () => {
      await process.cleanup()
      removed = true
    })(), /permission-denied-live-group: DEPLOY_TEST_TERMINATE_FAILED/)
    assert.equal(removed, false)
    fixture.close()
  }
  {
    const fixture = fakeChild()
    let removed = false
    const process = observeTestProcess(fixture.child, {
      label: 'cleanup-failure', cleanupTimeoutMs: 15, terminate: () => {}
    })
    await assert.rejects((async () => {
      await process.cleanup()
      removed = true
    })(), /cleanup-failure: DEPLOY_TEST_CLEANUP_TIMEOUT/)
    assert.equal(removed, false)
    fixture.close()
  }
  {
    const fixture = fakeChild()
    fixture.setPid(1)
    assert.throws(() => observeTestProcess(fixture.child, {
      label: 'invalid-group', ownedProcessGroup: true
    }), /DEPLOY_TEST_INVALID_GROUP/)
  }
  {
    const process = spawnTestProcess('/kinvest-test-command-does-not-exist', [],
      { stdio: 'ignore' }, { label: 'missing-executable' })
    try {
      await assert.rejects(process.waitForExit(), /missing-executable: DEPLOY_TEST_PROCESS_ERROR/)
    } finally {
      await process.cleanup()
    }
  }
  {
    const processHandle = spawnTestProcess(process.execPath, ['-e',
      "process.stdout.write('ready\\n');setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'pipe'] }, { label: 'owned-node-process' })
    let ready = false
    processHandle.child.stdout.on('data', () => { ready = true })
    try {
      await processHandle.waitForReady(() => ready, 'owned-node-ready')
      processHandle.child.kill('SIGTERM')
      const result = await processHandle.waitForExit('owned-node-signalled')
      assert.equal(result.signal, 'SIGTERM')
    } finally {
      await processHandle.cleanup()
    }
  }
  process.stdout.write('deployment-test-process: PASS\n')
}

module.exports = { run }

const { spawn, spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')

/**
 * @typedef {object} LifecycleOptions
 * @property {string} [label]
 * @property {number} [readyTimeoutMs]
 * @property {number} [completionTimeoutMs]
 * @property {number} [cleanupTimeoutMs]
 * @property {boolean} [ownedProcessGroup]
 * @property {(groupId: number, remainingMs: number) => boolean} [groupExists]
 * @property {() => void} [terminate]
 */

function failure(label, code) {
  return Object.assign(new Error(`${label}: ${code}`), { code })
}

function budget(value, fallback) {
  const result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || result < 1) throw failure('deployment-test', 'DEPLOY_TEST_INVALID_BUDGET')
  return result
}

/** @param {LifecycleOptions} options */
function settings(options) {
  const label = options.label || 'deployment-test'
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 .:_/-]{0,159}$/.test(label)) {
    throw failure('deployment-test', 'DEPLOY_TEST_INVALID_LABEL')
  }
  return {
    label,
    ready: budget(options.readyTimeoutMs, 30000),
    completion: budget(options.completionTimeoutMs, 30000),
    cleanup: budget(options.cleanupTimeoutMs, 5000)
  }
}

function probeGroup(groupId, remainingMs) {
  const result = spawnSync('pgrep', ['-g', String(groupId)], {
    encoding: 'utf8', timeout: Math.max(1, Math.min(1000, Math.ceil(remainingMs))),
    killSignal: 'SIGKILL', maxBuffer: 65536
  })
  if (result.error || result.signal) throw failure('deployment-test', 'DEPLOY_TEST_GROUP_PROBE_FAILED')
  const output = result.stdout.trim()
  if (result.status === 1 && output === '') return false
  if (result.status === 0 && /^[0-9]+(?:\s+[0-9]+)*$/.test(output)) return true
  throw failure('deployment-test', 'DEPLOY_TEST_GROUP_PROBE_FAILED')
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Observe before any asynchronous yield, so a quick exit or spawn error cannot be lost.
 * A group may only be owned when its dedicated detached child was created by this test.
 * @param {import('node:child_process').ChildProcess} child
 * @param {LifecycleOptions} [options]
 */
function observeTestProcess(child, options = {}) {
  const limits = settings(options)
  if (options.ownedProcessGroup && child.pid !== undefined &&
      (!Number.isSafeInteger(child.pid) || child.pid <= 1)) {
    throw failure(limits.label, 'DEPLOY_TEST_INVALID_GROUP')
  }
  const groupId = options.ownedProcessGroup ? child.pid : undefined
  let exited = child.exitCode !== null || child.signalCode !== null
  let closed = exited && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)
  let processError = false
  let result = { status: child.exitCode, signal: child.signalCode }
  /** @type {Promise<void> | undefined} */
  let cleanupPromise
  const onExit = (status, signal) => {
    exited = true
    result = { status, signal }
  }
  const onClose = (status, signal) => {
    onExit(status, signal)
    closed = true
  }
  const onError = () => {
    processError = true
    if (child.pid === undefined) {
      exited = true
      closed = true
    }
  }
  child.on('exit', onExit)
  child.on('close', onClose)
  child.on('error', onError)

  const groupPresent = (deadline, label) => {
    if (groupId === undefined) return false
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw failure(label, 'DEPLOY_TEST_CLEANUP_TIMEOUT')
    return (options.groupExists || probeGroup)(groupId, remaining)
  }

  function cleanup(label = limits.label) {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const deadline = performance.now() + limits.cleanup
      if (!exited || groupPresent(deadline, label)) {
        let terminationFailed = false
        let alreadyGone = false
        let permissionDenied = false
        try {
          if (options.terminate) options.terminate()
          else if (groupId !== undefined) process.kill(-groupId, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch (error) {
          terminationFailed = true
          const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
          alreadyGone = code === 'ESRCH'
          permissionDenied = code === 'EPERM'
        }
        if (terminationFailed && !alreadyGone &&
            !(permissionDenied && groupId !== undefined && !groupPresent(deadline, label))) {
          throw failure(label, 'DEPLOY_TEST_TERMINATE_FAILED')
        }
      }
      while (true) {
        if (closed && !groupPresent(deadline, label)) break
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw failure(label, 'DEPLOY_TEST_CLEANUP_TIMEOUT')
        await pause(Math.min(10, remaining))
      }
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
    })()
    return cleanupPromise
  }

  async function waitForReady(check, label = limits.label, timeoutMs = limits.ready) {
    const deadline = performance.now() + budget(timeoutMs, limits.ready)
    while (true) {
      if (processError) throw failure(label, 'DEPLOY_TEST_PROCESS_ERROR')
      if (exited) throw failure(label, 'DEPLOY_TEST_EARLY_EXIT')
      let ready
      try { ready = check() } catch { throw failure(label, 'DEPLOY_TEST_READY_CHECK_FAILED') }
      if (ready) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw failure(label, 'DEPLOY_TEST_READY_TIMEOUT')
      await pause(Math.min(10, remaining))
    }
  }

  async function waitForExit(label = limits.label, timeoutMs = limits.completion) {
    const deadline = performance.now() + budget(timeoutMs, limits.completion)
    while (true) {
      if (processError) throw failure(label, 'DEPLOY_TEST_PROCESS_ERROR')
      if (closed) return { ...result }
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        await cleanup(label)
        throw failure(label, 'DEPLOY_TEST_EXIT_TIMEOUT')
      }
      await pause(Math.min(10, remaining))
    }
  }

  return { child, waitForReady, waitForExit, cleanup }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [spawnOptions]
 * @param {LifecycleOptions} [options]
 */
function spawnTestProcess(command, args, spawnOptions = {}, options = {}) {
  settings(options)
  const ownedProcessGroup = process.platform !== 'win32'
  const child = spawn(command, args, { ...spawnOptions, detached: ownedProcessGroup })
  return observeTestProcess(child, { ...options, ownedProcessGroup })
}

module.exports = { observeTestProcess, spawnTestProcess }

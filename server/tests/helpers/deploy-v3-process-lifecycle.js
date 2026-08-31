const { performance } = require('node:perf_hooks')
const { spawnSync } = require('node:child_process')

function observeInstallerProcess(child, {
  readyTimeoutMs = 30000,
  completionTimeoutMs = 30000,
  cleanupTimeoutMs = 5000,
  ownedProcessGroup = false,
  terminate = () => { child.kill('SIGKILL') }
} = {}) {
  for (const value of [readyTimeoutMs, completionTimeoutMs, cleanupTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid installer wait budget')
  }
  const groupId = ownedProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : null

  function ownedGroupExists() {
    if (groupId === null) return false
    const probe = spawnSync('pgrep', ['-g', String(groupId)], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 65536
    })
    if (probe.error || probe.signal) throw new Error('v3 installer group inspection failed')
    if (probe.status === 1 && probe.stdout.trim() === '') return false
    if (probe.status === 0 && /^\d+(?:\s+\d+)*$/.test(probe.stdout.trim())) return true
    throw new Error('v3 installer group inspection failed')
  }

  let completed = false
  let failure = null
  let result = null
  let resolveTerminal = () => {}
  let resolveFailure = () => {}
  const terminal = new Promise(resolve => { resolveTerminal = () => resolve(undefined) })
  const failed = new Promise(resolve => { resolveFailure = () => resolve(undefined) })
  /** @type {Promise<void> | undefined} */
  let cleanupPromise

  function detach() {
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
  }

  function onExit(status, signal) {
    if (completed) return
    completed = true
    result = { status, signal }
    detach()
    resolveTerminal()
  }

  function onError() {
    failure = new Error('v3 installer process failed')
    resolveFailure()
    if (child.pid == null) onExit(null, null)
  }

  child.once('exit', onExit)
  child.on('error', onError)
  if (child.exitCode != null || child.signalCode != null) onExit(child.exitCode, child.signalCode)

  async function waitForTerminal(timeoutMs, message, includeFailure) {
    let timer
    try {
      if (!completed && !(includeFailure && failure)) {
        const timeout = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        })
        await Promise.race(includeFailure ? [terminal, failed, timeout] : [terminal, timeout])
      }
      if (includeFailure && failure) throw failure
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async function waitForReady(check) {
    const deadline = performance.now() + readyTimeoutMs
    for (;;) {
      if (failure) throw failure
      if (completed) throw new Error('v3 installer exited before readiness')
      if (check()) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error('timed out waiting for v3 installer readiness')
      let timer
      try {
        await Promise.race([
          terminal,
          failed,
          new Promise(resolve => { timer = setTimeout(resolve, Math.min(10, remaining)) })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const deadline = performance.now() + cleanupTimeoutMs
      if (!completed || ownedGroupExists()) {
        try {
          if (groupId === null) terminate()
          else process.kill(-groupId, 'SIGKILL')
        } catch (error) {
          const disappeared = groupId !== null && error?.code === 'EPERM' && !ownedGroupExists()
          if (error?.code !== 'ESRCH' && !disappeared) {
            throw new Error('v3 installer termination failed', { cause: error })
          }
        }
      }
      if (!completed) {
        await waitForTerminal(Math.max(0, Math.ceil(deadline - performance.now())), 'v3 installer cleanup did not exit', false)
      }
      while (ownedGroupExists()) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new Error('v3 installer descendants did not exit')
        await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining)))
      }
      detach()
    })()
    return cleanupPromise
  }

  return {
    waitForReady,
    waitForExit: () => waitForTerminal(completionTimeoutMs, 'v3 installer did not exit within completion budget', true),
    cleanup
  }
}

module.exports = { observeInstallerProcess }

/* global module */

(function exposeAuthLifecycle(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestAuthLifecycle = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  function createAuthorizedRequestLifecycle() {
    let authorized = false
    let currentEpoch = 0
    const controllers = new Set()

    function authorize() {
      authorized = true
    }

    function invalidate() {
      authorized = false
      currentEpoch += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }

    function beginRequest() {
      if (!authorized) throw new Error('AUTH_EPOCH_INACTIVE')
      const controller = new AbortController()
      controllers.add(controller)
      return Object.freeze({ controller, epoch: currentEpoch, signal: controller.signal })
    }

    function canCommit(ticket) {
      return authorized === true && ticket && ticket.epoch === currentEpoch &&
        ticket.signal.aborted === false && controllers.has(ticket.controller)
    }

    function commit(ticket, callback) {
      if (!canCommit(ticket)) throw new Error('AUTH_EPOCH_STALE')
      return callback()
    }

    function finishRequest(ticket) {
      if (ticket && ticket.controller) controllers.delete(ticket.controller)
    }

    return Object.freeze({
      authorize,
      beginRequest,
      canCommit,
      commit,
      epoch: () => currentEpoch,
      finishRequest,
      invalidate,
      isAuthorized: () => authorized
    })
  }

  /**
   * @param {{
   *   baseDelayMs: number,
   *   maxDelayMs: number,
   *   setTimer: (callback: () => unknown, delay: number) => unknown,
   *   clearTimer: (timer: unknown) => void
   * }} options
   */
  function createSingleFlightRetry(options) {
    const baseDelayMs = options.baseDelayMs
    const maxDelayMs = options.maxDelayMs
    let active = false
    let generation = 0
    let failures = 0
    let timer = null
    let inFlight = null
    const ignoreOutcome = /** @type {(outcome: any, error: any, decision: any) => void} */ (() => {})

    function cancel() {
      active = false
      if (timer !== null) options.clearTimer(timer)
      timer = null
      inFlight = null
    }

    function activate(nextGeneration) {
      cancel()
      active = true
      generation = nextGeneration
      failures = 0
    }

    /**
     * @param {number} expectedGeneration
     * @param {() => unknown | Promise<unknown>} operation
     * @param {(error: any) => { retry: boolean }} classify
     * @param {(outcome: any, error: any, decision: any) => void | Promise<void>} [onOutcome]
     */
    function run(expectedGeneration, operation, classify, onOutcome = ignoreOutcome) {
      if (!active || expectedGeneration !== generation) {
        return Promise.resolve(Object.freeze({ kind: 'stale' }))
      }
      if (inFlight) return inFlight

      let currentPromise
      currentPromise = Promise.resolve()
        .then(operation)
        .then(async (value) => {
          if (!active || expectedGeneration !== generation) return Object.freeze({ kind: 'stale' })
          const outcome = Object.freeze({ kind: 'success', value })
          await onOutcome(outcome, null, null)
          return outcome
        })
        .catch(async (error) => {
          if (!active || expectedGeneration !== generation) return Object.freeze({ kind: 'stale' })
          const decision = classify(error)
          if (decision.retry) {
            failures += 1
            const delayMs = Math.min(baseDelayMs * (2 ** (failures - 1)), maxDelayMs)
            const outcome = Object.freeze({ kind: 'retry', delayMs })
            timer = options.setTimer(() => {
              timer = null
              return run(expectedGeneration, operation, classify, onOutcome)
            }, delayMs)
            await onOutcome(outcome, error, decision)
            return outcome
          }
          const outcome = Object.freeze({ kind: 'terminal' })
          await onOutcome(outcome, error, decision)
          return outcome
        })
        .finally(() => {
          if (inFlight === currentPromise) inFlight = null
        })
      inFlight = currentPromise
      return currentPromise
    }

    return Object.freeze({ activate, cancel, run })
  }

  return Object.freeze({ createAuthorizedRequestLifecycle, createSingleFlightRetry })
})

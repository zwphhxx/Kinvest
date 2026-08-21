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

    function finishRequest(ticket) {
      if (ticket && ticket.controller) controllers.delete(ticket.controller)
    }

    return Object.freeze({
      authorize,
      beginRequest,
      canCommit,
      epoch: () => currentEpoch,
      finishRequest,
      invalidate,
      isAuthorized: () => authorized
    })
  }

  return Object.freeze({ createAuthorizedRequestLifecycle })
})

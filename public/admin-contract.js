/* global module */

(function exposeAdminContract(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestAdmin = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  function approvedRequestDecision(request) {
    return request && Number.isSafeInteger(request.approvedAt)
      ? Object.freeze({ approvable: false, label: '已批准，等待设备兑换' })
      : Object.freeze({ approvable: true, label: '等待管理员批准' })
  }

  function mutationFailureDecision(code) {
    if (code === 'ADMIN_CSRF_INVALID') {
      return Object.freeze({ clear: true, restore: true, refresh: true, replay: false })
    }
    if (code === 'ADMIN_AUTH_REQUIRED') {
      return Object.freeze({ clear: true, restore: false, refresh: false, replay: false })
    }
    return Object.freeze({ clear: false, restore: false, refresh: false, replay: false })
  }

  function logoutFailureDecision(code) {
    return code === 'ADMIN_AUTH_REQUIRED'
      ? Object.freeze({ restoreSession: false, showLogin: true })
      : Object.freeze({ restoreSession: true, showLogin: false })
  }

  function createAdminBootstrapGate() {
    let pending = true
    let generation = 0

    function begin() {
      if (!pending) throw new Error('ADMIN_BOOTSTRAP_COMPLETE')
      return Object.freeze({ generation })
    }

    function settle(ticket) {
      if (!pending || !ticket || ticket.generation !== generation) return false
      pending = false
      generation += 1
      return true
    }

    return Object.freeze({
      begin,
      canLogin: () => !pending,
      settle
    })
  }

  function createAdminSecurityState() {
    let csrfToken = null
    let restorePromise = null
    let generation = 0

    function setCsrf(value) {
      generation += 1
      csrfToken = typeof value === 'string' && value.length > 0 ? value : null
      restorePromise = null
    }

    function clear() {
      generation += 1
      csrfToken = null
      restorePromise = null
    }

    function restore(loader) {
      if (restorePromise) return restorePromise
      const restoreGeneration = generation
      let loaded
      try {
        loaded = loader()
      } catch (error) {
        loaded = Promise.reject(error)
      }
      restorePromise = Promise.resolve(loaded)
        .then((result) => {
          if (generation !== restoreGeneration) throw new Error('ADMIN_CSRF_STALE')
          if (!result || typeof result.csrfToken !== 'string' || result.csrfToken.length === 0) {
            throw new Error('ADMIN_CSRF_INVALID')
          }
          csrfToken = result.csrfToken
          return result
        })
        .finally(() => {
          if (restorePromise === currentPromise) restorePromise = null
        })
      const currentPromise = restorePromise
      return restorePromise
    }

    return Object.freeze({ clear, getCsrf: () => csrfToken, restore, setCsrf })
  }

  function createAdminSessionLifecycle() {
    let active = false
    let currentEpoch = 0
    const controllers = new Set()

    function invalidate() {
      active = false
      currentEpoch += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }

    function activate() {
      invalidate()
      active = true
    }

    function suspend() {
      invalidate()
      return Object.freeze({ epoch: currentEpoch })
    }

    function resume(suspension) {
      if (active || !suspension || suspension.epoch !== currentEpoch) return false
      active = true
      return true
    }

    function beginRequest() {
      if (!active) throw new Error('ADMIN_EPOCH_INACTIVE')
      const controller = new AbortController()
      controllers.add(controller)
      return Object.freeze({ controller, epoch: currentEpoch, signal: controller.signal })
    }

    function canCommit(ticket) {
      return active && ticket && ticket.epoch === currentEpoch &&
        ticket.signal.aborted === false && controllers.has(ticket.controller)
    }

    function commit(ticket, callback) {
      if (!canCommit(ticket)) throw new Error('ADMIN_EPOCH_STALE')
      return callback()
    }

    function finishRequest(ticket) {
      if (ticket && ticket.controller) controllers.delete(ticket.controller)
    }

    return Object.freeze({
      activate,
      beginRequest,
      commit,
      finishRequest,
      invalidate,
      resume,
      suspend
    })
  }

  return Object.freeze({
    approvedRequestDecision,
    createAdminBootstrapGate,
    createAdminSessionLifecycle,
    createAdminSecurityState,
    logoutFailureDecision,
    mutationFailureDecision
  })
})

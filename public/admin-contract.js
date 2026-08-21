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

  function createAdminSecurityState() {
    let csrfToken = null
    let restorePromise = null

    function setCsrf(value) {
      csrfToken = typeof value === 'string' && value.length > 0 ? value : null
    }

    function clear() {
      csrfToken = null
    }

    function restore(loader) {
      if (restorePromise) return restorePromise
      let loaded
      try {
        loaded = loader()
      } catch (error) {
        loaded = Promise.reject(error)
      }
      restorePromise = Promise.resolve(loaded)
        .then((result) => {
          if (!result || typeof result.csrfToken !== 'string' || result.csrfToken.length === 0) {
            throw new Error('ADMIN_CSRF_INVALID')
          }
          setCsrf(result.csrfToken)
          return result
        })
        .finally(() => {
          restorePromise = null
        })
      return restorePromise
    }

    return Object.freeze({ clear, getCsrf: () => csrfToken, restore, setCsrf })
  }

  return Object.freeze({
    approvedRequestDecision,
    createAdminSecurityState,
    mutationFailureDecision
  })
})

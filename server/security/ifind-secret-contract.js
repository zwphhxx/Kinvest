const { types } = require('node:util')

const IFIND_BUNDLE_PATH = '/run/secrets/kinvest-ifind'
const IFIND_DIAGNOSTIC_MODE_DISABLED = 'disabled'
const IFIND_DIAGNOSTIC_MODE_ADMIN = 'admin-diagnostic'
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/

class IfindSecretContractError extends Error {
  constructor() {
    super('The iFinD secret configuration is invalid')
    this.name = 'IfindSecretContractError'
    this.code = 'IFIND_SECRET_CONFIG_INVALID'
  }
}

function failConfig() {
  throw new IfindSecretContractError()
}

function snapshotExactDataObject(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    return null
  }
  const snapshot = Object.create(null)
  for (const key of expected) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return null
    }
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function createIfindSecretContract(value) {
  try {
    if (!types.isProxy(value)) {
      const disabledFields = snapshotExactDataObject(value, ['mode'])
      if (disabledFields && disabledFields.mode === IFIND_DIAGNOSTIC_MODE_DISABLED) {
        return Object.freeze({ mode: IFIND_DIAGNOSTIC_MODE_DISABLED })
      }

      const adminFields = snapshotExactDataObject(
        value,
        ['mode', 'versionId', 'bundlePath']
      )
      if (adminFields &&
        adminFields.mode === IFIND_DIAGNOSTIC_MODE_ADMIN &&
        typeof adminFields.versionId === 'string' &&
        VERSION_ID_PATTERN.test(adminFields.versionId) &&
        adminFields.bundlePath === IFIND_BUNDLE_PATH) {
        return Object.freeze({
          mode: IFIND_DIAGNOSTIC_MODE_ADMIN,
          versionId: adminFields.versionId,
          bundlePath: IFIND_BUNDLE_PATH
        })
      }
    }
  } catch {
    failConfig()
  }
  failConfig()
}

module.exports = {
  IFIND_BUNDLE_PATH,
  IFIND_DIAGNOSTIC_MODE_ADMIN,
  IFIND_DIAGNOSTIC_MODE_DISABLED,
  IfindSecretContractError,
  createIfindSecretContract
}

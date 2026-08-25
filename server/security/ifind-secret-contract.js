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

function hasExactKeys(value, expected) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function createIfindSecretContract(value) {
  try {
    if (hasExactKeys(value, ['mode']) &&
      value.mode === IFIND_DIAGNOSTIC_MODE_DISABLED) {
      return Object.freeze({ mode: IFIND_DIAGNOSTIC_MODE_DISABLED })
    }

    if (!hasExactKeys(value, ['mode', 'versionId', 'bundlePath']) ||
      value.mode !== IFIND_DIAGNOSTIC_MODE_ADMIN ||
      typeof value.versionId !== 'string' ||
      !VERSION_ID_PATTERN.test(value.versionId) ||
      value.bundlePath !== IFIND_BUNDLE_PATH) {
      failConfig()
    }

    return Object.freeze({
      mode: IFIND_DIAGNOSTIC_MODE_ADMIN,
      versionId: value.versionId,
      bundlePath: IFIND_BUNDLE_PATH
    })
  } catch (error) {
    if (error instanceof IfindSecretContractError) throw error
    failConfig()
  }
}

module.exports = {
  IFIND_BUNDLE_PATH,
  IFIND_DIAGNOSTIC_MODE_ADMIN,
  IFIND_DIAGNOSTIC_MODE_DISABLED,
  IfindSecretContractError,
  createIfindSecretContract
}

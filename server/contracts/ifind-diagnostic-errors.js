const SAFE_ERROR_CLASSES = Object.freeze([
  'AUTH', 'PERMISSION', 'QUOTA', 'NETWORK', 'API', 'CONFIG', 'BUSY',
  'RATE_LIMITED'
])

function rule(errorClasses, stages, allowsVendorErrorCode = false) {
  return Object.freeze({
    errorClasses: Object.freeze(errorClasses),
    stages: Object.freeze(stages),
    allowsVendorErrorCode
  })
}

const CLIENT_FAILURE_RULES = Object.freeze({
  IFIND_AUTH_REJECTED: rule(['AUTH'], ['auth', 'probe', 'quote', 'financial'], true),
  IFIND_CLIENT_CLEARED: rule(['CONFIG'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_CLIENT_FAILED: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_CONFIG_INVALID: rule(['CONFIG'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_CONNECTION_TIMEOUT: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_DUPLICATE_RESPONSE: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_FINANCIAL_REJECTED: rule(['API'], ['financial'], true),
  IFIND_HTTP_STATUS: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_NETWORK_FAILED: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_PERMISSION_REJECTED: rule(['PERMISSION'], ['probe', 'quote', 'financial'], true),
  IFIND_PROBE_REJECTED: rule(['API'], ['probe'], true),
  IFIND_QUOTE_REJECTED: rule(['API'], ['quote'], true),
  IFIND_QUOTA_REJECTED: rule(['QUOTA'], ['probe', 'quote', 'financial'], true),
  IFIND_RESPONSE_ABORTED: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_ENCODING: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_FAILED: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_INVALID: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_JSON: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_SHAPE: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_RESPONSE_TOO_LARGE: rule(['API'], [null, 'auth', 'probe', 'quote', 'financial']),
  IFIND_TIMEOUT: rule(['NETWORK'], [null, 'auth', 'probe', 'quote', 'financial'])
})

const REPOSITORY_INTERNAL_FAILURE_RULES = Object.freeze({
  IFIND_DIAGNOSTIC_STALE_RESERVATION: rule(['CONFIG'], []),
  IFIND_LEGACY_DIAGNOSTIC_FAILURE: rule(SAFE_ERROR_CLASSES, [])
})

const CLIENT_EMITTABLE_FAILURE_CODES = Object.freeze(Object.keys(CLIENT_FAILURE_RULES))
const REPOSITORY_INTERNAL_FAILURE_CODES = Object.freeze(
  Object.keys(REPOSITORY_INTERNAL_FAILURE_RULES)
)
const ALL_PERSISTABLE_FAILURE_CODES = Object.freeze([
  ...CLIENT_EMITTABLE_FAILURE_CODES,
  ...REPOSITORY_INTERNAL_FAILURE_CODES
])

function isSafeErrorClass(value) {
  return SAFE_ERROR_CLASSES.includes(value)
}

function isSafeVendorErrorCode(value) {
  return Number.isSafeInteger(value) && value !== 0
}

function clientRule(failureCode) {
  return typeof failureCode === 'string' && Object.hasOwn(CLIENT_FAILURE_RULES, failureCode)
    ? CLIENT_FAILURE_RULES[failureCode]
    : null
}

function isClientFailureBase({ failureCode, errorClass, vendorErrorCode }) {
  const contract = clientRule(failureCode)
  if (!contract || !contract.errorClasses.includes(errorClass)) return false
  if (vendorErrorCode === null) return true
  return contract.allowsVendorErrorCode && isSafeVendorErrorCode(vendorErrorCode)
}

function isClientFailureMetadata({ failureCode, errorClass, stage, vendorErrorCode }) {
  const contract = clientRule(failureCode)
  return isClientFailureBase({ failureCode, errorClass, vendorErrorCode }) &&
    contract.stages.includes(stage)
}

function isPersistableFailureMetadata({ failureCode, errorClass, vendorErrorCode }) {
  if (isClientFailureBase({ failureCode, errorClass, vendorErrorCode })) return true
  if (typeof failureCode !== 'string' ||
      !Object.hasOwn(REPOSITORY_INTERNAL_FAILURE_RULES, failureCode)) return false
  const contract = REPOSITORY_INTERNAL_FAILURE_RULES[failureCode]
  return contract.errorClasses.includes(errorClass) && vendorErrorCode === null
}

module.exports = {
  ALL_PERSISTABLE_FAILURE_CODES,
  CLIENT_EMITTABLE_FAILURE_CODES,
  REPOSITORY_INTERNAL_FAILURE_CODES,
  isClientFailureBase,
  isClientFailureMetadata,
  isPersistableFailureMetadata,
  isSafeErrorClass
}

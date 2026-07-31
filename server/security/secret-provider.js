const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const VERSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

class SecretProviderError extends Error {
  constructor(code) {
    super(code === 'SECRET_NOT_FOUND'
      ? 'The requested secret version is unavailable'
      : 'An explicit valid secret name and version are required')
    this.name = 'SecretProviderError'
    this.code = code
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidSecretName(value) {
  return typeof value === 'string' && SECRET_NAME_PATTERN.test(value)
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidVersionId(value) {
  return typeof value === 'string' && VERSION_ID_PATTERN.test(value)
}

/**
 * @param {{ secretName?: unknown, versionId?: unknown }} [reference]
 */
function validateSecretReference(reference = {}) {
  const { secretName, versionId } = reference
  if (!isValidSecretName(secretName) || !isValidVersionId(versionId)) {
    throw new SecretProviderError('SECRET_REFERENCE_INVALID')
  }
  return { secretName, versionId }
}

class MockSecretProvider {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries))
  }

  readSecret(reference) {
    const { secretName, versionId } = validateSecretReference(reference)
    const key = `${secretName}:${versionId}`
    if (!this.entries.has(key)) {
      throw new SecretProviderError('SECRET_NOT_FOUND')
    }
    return this.entries.get(key)
  }

  deleteEntry(reference) {
    const { secretName, versionId } = validateSecretReference(reference)
    return this.entries.delete(`${secretName}:${versionId}`)
  }
}

module.exports = {
  MockSecretProvider,
  SecretProviderError,
  isValidSecretName,
  isValidVersionId,
  validateSecretReference
}

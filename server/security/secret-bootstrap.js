const {
  ROLE_NAME,
  parseSecretVersionConfig,
  validateLoadedSecretMaterial
} = require('./secret-bootstrap-contract')
const { loadCvmSsmSecrets } = require('./cvm-ssm-secret-provider')

class SecretBootstrapRuntimeError extends Error {
  constructor(code) {
    const messages = {
      SECRET_BOOTSTRAP_CONFIG_INVALID: 'The secret bootstrap configuration is invalid',
      SECRET_PROVIDER_DISABLED: 'The secret provider is disabled'
    }
    super(messages[code] || 'Secret bootstrap failed')
    this.name = 'SecretBootstrapRuntimeError'
    this.code = code
  }
}

function parseEnvironmentConfig(env) {
  const hasMode = Object.prototype.hasOwnProperty.call(env, 'KINVEST_SECRET_PROVIDER_MODE')
  const hasVersions = Object.prototype.hasOwnProperty.call(env, 'KINVEST_SECRET_VERSION_IDS')
  if (!hasMode && !hasVersions) {
    return parseSecretVersionConfig('{}')
  }
  if (!hasMode || !hasVersions) {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }

  const mode = env.KINVEST_SECRET_PROVIDER_MODE
  const versionJson = env.KINVEST_SECRET_VERSION_IDS
  let config
  try {
    config = parseSecretVersionConfig(versionJson)
  } catch {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }
  if ((mode === 'disabled' && config.mode !== 'disabled') ||
    (mode === 'cvm-ssm' && config.mode !== 'cvm-ssm') ||
    (mode !== 'disabled' && mode !== 'cvm-ssm')) {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }
  return config
}

function createRuntime(provider, status) {
  let cleared = false
  return Object.freeze({
    status: Object.freeze({ ...status }),
    readSecret(reference) {
      if (!provider) throw new SecretBootstrapRuntimeError('SECRET_PROVIDER_DISABLED')
      return provider.readSecret(reference)
    },
    clear() {
      if (cleared) return
      cleared = true
      if (provider) provider.clear()
    }
  })
}

async function bootstrapSecrets({
  env = process.env,
  loadSecrets = loadCvmSsmSecrets,
  validateMaterial = validateLoadedSecretMaterial
} = {}) {
  if (!env || typeof env !== 'object' ||
    typeof loadSecrets !== 'function' ||
    typeof validateMaterial !== 'function') {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }
  const config = parseEnvironmentConfig(env)
  if (config.mode === 'disabled') {
    return createRuntime(null, { mode: 'disabled', referenceCount: 0 })
  }

  let provider
  try {
    provider = await loadSecrets({
      references: config.references,
      roleName: ROLE_NAME
    })
    const status = await validateMaterial(provider, config)
    return createRuntime(provider, status)
  } catch (error) {
    if (provider && typeof provider.clear === 'function') provider.clear()
    throw error
  }
}

module.exports = {
  SecretBootstrapRuntimeError,
  bootstrapSecrets,
  parseEnvironmentConfig
}

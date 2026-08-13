const {
  ROLE_NAME,
  parseSecretVersionConfig,
  validateLoadedSecretMaterial
} = require('./secret-bootstrap-contract')
const { loadCvmSsmSecrets } = require('./cvm-ssm-secret-provider')
const {
  BUNDLE_PATH,
  loadGithubTmpfsSecrets
} = require('./github-tmpfs-secret-provider')

/**
 * @typedef {{secretName: string, versionId: string}} SecretReference
 * @typedef {{readSecret: (reference: SecretReference) => Buffer, clear: () => void}} SecretProviderLike
 * @typedef {{mode: string, referenceCount: number}} SecretRuntimeStatus
 * @typedef {Readonly<{status: Readonly<SecretRuntimeStatus>, readSecret: (reference: SecretReference) => Buffer, clear: () => void}>} SecretRuntime
 */

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

/** @param {Record<string, string | undefined>} env */
function parseEnvironmentConfig(env) {
  const hasMode = Object.prototype.hasOwnProperty.call(env, 'KINVEST_SECRET_PROVIDER_MODE')
  const hasVersions = Object.prototype.hasOwnProperty.call(env, 'KINVEST_SECRET_VERSION_IDS')
  const hasBundlePath = Object.prototype.hasOwnProperty.call(env, 'KINVEST_SECRET_BUNDLE_PATH')
  if (!hasMode && !hasVersions) {
    if (hasBundlePath) {
      throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
    }
    return Object.freeze({
      ...parseSecretVersionConfig('{}'),
      providerMode: 'disabled'
    })
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
  const githubModeValid = mode === 'github-tmpfs-v1' &&
    config.mode === 'cvm-ssm' &&
    hasBundlePath &&
    env.KINVEST_SECRET_BUNDLE_PATH === BUNDLE_PATH &&
    config.references.length === 2
  if ((mode === 'disabled' && (config.mode !== 'disabled' || hasBundlePath)) ||
    (mode === 'cvm-ssm' && (config.mode !== 'cvm-ssm' || hasBundlePath)) ||
    (mode === 'github-tmpfs-v1' && !githubModeValid) ||
    (mode !== 'disabled' && mode !== 'cvm-ssm' && mode !== 'github-tmpfs-v1')) {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }
  return Object.freeze({
    ...config,
    providerMode: mode,
    ...(mode === 'github-tmpfs-v1' ? { bundlePath: BUNDLE_PATH } : {})
  })
}

/**
 * @param {SecretProviderLike | null} provider
 * @param {SecretRuntimeStatus} status
 * @returns {SecretRuntime}
 */
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

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(options: {references: SecretReference[], roleName?: string, bundlePath?: string}) => Promise<SecretProviderLike>} [options.loadSecrets]
 * @param {(provider: SecretProviderLike, config: any) => Promise<SecretRuntimeStatus>} [options.validateMaterial]
 * @returns {Promise<SecretRuntime>}
 */
async function bootstrapSecrets({
  env = process.env,
  loadSecrets,
  validateMaterial = validateLoadedSecretMaterial
} = {}) {
  if (!env || typeof env !== 'object' ||
    (loadSecrets !== undefined && typeof loadSecrets !== 'function') ||
    typeof validateMaterial !== 'function') {
    throw new SecretBootstrapRuntimeError('SECRET_BOOTSTRAP_CONFIG_INVALID')
  }
  const config = parseEnvironmentConfig(env)
  if (config.providerMode === 'disabled') {
    return createRuntime(null, { mode: 'disabled', referenceCount: 0 })
  }

  let provider
  try {
    const loader = loadSecrets || (config.providerMode === 'cvm-ssm'
      ? loadCvmSsmSecrets
      : loadGithubTmpfsSecrets)
    const loaderOptions = config.providerMode === 'cvm-ssm'
      ? { references: config.references, roleName: ROLE_NAME }
      : loadSecrets
          ? { references: config.references, bundlePath: config.bundlePath }
          : { references: config.references }
    provider = await loader(loaderOptions)
    const validatedStatus = await validateMaterial(provider, config)
    return createRuntime(provider, {
      ...validatedStatus,
      mode: config.providerMode
    })
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

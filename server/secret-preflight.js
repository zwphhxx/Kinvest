const { bootstrapSecrets } = require('./security/secret-bootstrap')

const SSM_PREFLIGHT_ERROR_CODES = new Set([
  'SECRET_BOOTSTRAP_CONFIG_INVALID',
  'SECRET_MATERIAL_INVALID',
  'SECRET_MATERIAL_LOAD_FAILED',
  'SECRET_MATERIAL_PROVIDER_INVALID',
  'SECRET_VERSION_CONFIG_INVALID',
  'SSM_BOOTSTRAP_INVALID',
  'SSM_CLIENT_UNAVAILABLE',
  'SSM_PREFLIGHT_REQUIRES_CVM_SSM',
  'SSM_SECRET_LOAD_FAILED',
  'TEMPORARY_CREDENTIALS_REQUIRED'
])

/** @param {unknown} error */
function stableErrorCode(error, fallback = 'SSM_PREFLIGHT_FAILED') {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  return typeof code === 'string' && SSM_PREFLIGHT_ERROR_CODES.has(code)
    ? code
    : fallback
}

/** @param {any} [options] */
async function runPreflight({
  env = process.env,
  bootstrap = bootstrapSecrets,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let runtime
  try {
    runtime = await bootstrap({ env })
    if (!runtime || !runtime.status || runtime.status.mode !== 'cvm-ssm') {
      const error = Object.assign(new Error('SSM preflight requires CVM SSM mode'), {
        code: 'SSM_PREFLIGHT_REQUIRES_CVM_SSM'
      })
      throw error
    }
    stdout.write(`KINVEST_SSM_PREFLIGHT_OK references=${runtime.status.referenceCount}\n`)
    return 0
  } catch (error) {
    stderr.write(`${stableErrorCode(error)}\n`)
    return 1
  } finally {
    if (runtime && typeof runtime.clear === 'function') runtime.clear()
  }
}

if (require.main === module) {
  runPreflight().then((exitCode) => {
    process.exitCode = exitCode
  })
}

module.exports = {
  runPreflight,
  stableErrorCode
}

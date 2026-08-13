const { bootstrapSecrets } = require('./security/secret-bootstrap')

const SSM_PREFLIGHT_ERROR_CODES = new Set([
  'GITHUB_TMPFS_BUNDLE_INVALID',
  'GITHUB_TMPFS_CONFIG_INVALID',
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

function preflightSuccessLine(status) {
  if (!status || typeof status !== 'object' ||
    !Number.isSafeInteger(status.referenceCount)) {
    throw Object.assign(new Error('Invalid secret preflight status'), {
      code: 'SSM_PREFLIGHT_REQUIRES_CVM_SSM'
    })
  }

  if (status.mode === 'disabled' && status.referenceCount === 0) {
    return 'KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0\n'
  }
  if (status.mode === 'github-tmpfs-v1' && status.referenceCount === 2) {
    return 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=2\n'
  }
  if (status.mode === 'cvm-ssm' &&
    status.referenceCount >= 2 && status.referenceCount <= 11) {
    return `KINVEST_SSM_PREFLIGHT_OK references=${status.referenceCount}\n`
  }

  throw Object.assign(new Error('Invalid secret preflight mode or reference count'), {
    code: 'SSM_PREFLIGHT_REQUIRES_CVM_SSM'
  })
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
    stdout.write(preflightSuccessLine(runtime && runtime.status))
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
  preflightSuccessLine,
  runPreflight,
  stableErrorCode
}

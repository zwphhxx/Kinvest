const { bootstrapSecrets } = require('./security/secret-bootstrap')

function stableErrorCode(error, fallback = 'SSM_PREFLIGHT_FAILED') {
  const code = error && error.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? code
    : fallback
}

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
      const error = new Error('SSM preflight requires CVM SSM mode')
      error.code = 'SSM_PREFLIGHT_REQUIRES_CVM_SSM'
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

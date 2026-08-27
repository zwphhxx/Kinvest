const {
  IFIND_BUNDLE_PATH,
  IFIND_DIAGNOSTIC_MODE_ADMIN,
  IFIND_DIAGNOSTIC_MODE_DISABLED
} = require('./security/ifind-secret-contract')
const {
  loadIfindTmpfsSecrets
} = require('./security/ifind-tmpfs-secret-provider')

const ERROR_CODES = new Set([
  'IFIND_REFRESH_TOKEN_UNAVAILABLE',
  'IFIND_SECRET_CONFIG_INVALID',
  'IFIND_TMPFS_BUNDLE_INVALID'
])

function stableErrorCode(error) {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  return typeof code === 'string' && ERROR_CODES.has(code)
    ? code
    : 'IFIND_PREFLIGHT_FAILED'
}

async function runPreflight({
  env = process.env,
  load = loadIfindTmpfsSecrets,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let provider
  let token
  try {
    const mode = env.KINVEST_IFIND_DIAGNOSTIC_MODE
    if (mode === IFIND_DIAGNOSTIC_MODE_DISABLED) {
      stdout.write('KINVEST_IFIND_PREFLIGHT_OK mode=disabled references=0\n')
      return 0
    }
    if (mode !== IFIND_DIAGNOSTIC_MODE_ADMIN ||
      env.KINVEST_IFIND_SECRET_BUNDLE_PATH !== IFIND_BUNDLE_PATH) {
      throw Object.assign(new Error('Invalid iFinD preflight configuration'), {
        code: 'IFIND_SECRET_CONFIG_INVALID'
      })
    }
    provider = await load({
      mode,
      versionId: env.KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID,
      bundlePath: IFIND_BUNDLE_PATH
    })
    if (!provider || typeof provider.readRefreshToken !== 'function') {
      throw Object.assign(new Error('Missing iFinD provider'), {
        code: 'IFIND_PREFLIGHT_FAILED'
      })
    }
    token = provider.readRefreshToken()
    if (!Buffer.isBuffer(token) || token.length === 0) {
      throw Object.assign(new Error('Missing iFinD material'), {
        code: 'IFIND_PREFLIGHT_FAILED'
      })
    }
    stdout.write('KINVEST_IFIND_PREFLIGHT_OK mode=admin-diagnostic references=1\n')
    return 0
  } catch (error) {
    stderr.write(`${stableErrorCode(error)}\n`)
    return 1
  } finally {
    if (token) token.fill(0)
    if (provider && typeof provider.clear === 'function') provider.clear()
  }
}

if (require.main === module) {
  runPreflight().then((code) => { process.exitCode = code })
}

module.exports = { runPreflight, stableErrorCode }

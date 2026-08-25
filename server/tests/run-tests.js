const fs = require('node:fs')
const path = require('node:path')

const pythonBytecodeCachePath = path.resolve(__dirname, '../../deploy/server/__pycache__')
const previousPythonDontWriteBytecode = process.env.PYTHONDONTWRITEBYTECODE
process.env.PYTHONDONTWRITEBYTECODE = '1'

function removeRepositoryPythonBytecodeCache() {
  fs.rmSync(pythonBytecodeCachePath, { recursive: true, force: true })
}

process.once('exit', removeRepositoryPythonBytecodeCache)

const tests = [
  require('./admin-auth.test'),
  require('./trusted-client.test'),
  require('./http-auth.test'),
  require('./http-security-regression.test'),
  require('./http-auth-real.test'),
  require('./admin-auth-atomic.test'),
  require('./security-identity.test'),
  require('./device-approval.test'),
  require('./access-control-runtime.test'),
  require('./device-auth-cli.test'),
  require('./cvm-ssm-secret-provider.test'),
  require('./github-tmpfs-secret-provider.test'),
  require('./secret-bootstrap-contract.test'),
  require('./tencent-ssm-client.test'),
  require('./secret-bootstrap.test'),
  require('./server-secret-bootstrap.test'),
  require('./secret-preflight.test'),
  require('./access-preflight.test'),
  require('./ssm-material-generator.test'),
  require('./docker-secret-bootstrap.test'),
  require('./metadata-firewall-contract.test'),
  require('./metadata-firewall-installer.test'),
  require('./refresh-policy.test'),
  require('./refresh-rules.test'),
  require('./health.test'),
  require('./build.test'),
  require('./frontend-auth-state.test'),
  require('./frontend-auth-contract.test'),
  require('./frontend-contract.test'),
  require('./data-source-contract.test'),
  require('./model-security-contract.test'),
  require('./offline-image-attestation.test'),
  require('./deploy-contract.test'),
  require('./nginx-canonical-origin.test'),
  require('./deploy-secret-version-config.test'),
  require('./deploy-v2-contract.test'),
  require('./deploy-v2-secret-state.test'),
  require('./deploy-v2-workflow.test'),
  require('./deploy-v3-contract.test'),
  require('./deploy-v3-state.test'),
  require('./deploy-v3-installer.test'),
  require('./deploy-v3-workflow.test'),
  require('./deploy-v4.test'),
  require('./deploy-v4-executor.test'),
  require('./deploy-v4-installer.test'),
  require('./deploy-gate-identity-migration.test'),
  require('./deploy-v4-workflow.test'),
  require('./nginx-fixed-ip-gate.test'),
  require('./nginx-config-installer.test'),
  require('./data-lifecycle.test'),
  require('./workflow-contract.test')
]

async function main() {
  let hasFailure = false

  try {
    for (const test of tests) {
      try {
        if (typeof test.run === 'function') {
          await test.run()
          console.log(`✅ ${test.run.name || 'test'} passed`)
        }
      } catch (err) {
        hasFailure = true
        console.error(`❌ ${test.run ? test.run.name || 'test' : 'unknown'} failed`, err.message)
      }
    }

    if (hasFailure) {
      process.exitCode = 1
      return
    }

    console.log('All tests passed')
  } finally {
    removeRepositoryPythonBytecodeCache()
    process.removeListener('exit', removeRepositoryPythonBytecodeCache)
    if (previousPythonDontWriteBytecode === undefined) {
      delete process.env.PYTHONDONTWRITEBYTECODE
    } else {
      process.env.PYTHONDONTWRITEBYTECODE = previousPythonDontWriteBytecode
    }
  }
}

main()

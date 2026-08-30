const fs = require('fs')
const path = require('path')

const repositoryRoot = path.resolve(__dirname, '..')
const distDirectory = path.join(repositoryRoot, 'dist')
const adminDiagnosticRuntimeFiles = Object.freeze([
  'public/admin-contract.js',
  'public/admin.html',
  'public/admin.js',
  'public/auth.css'
])
const runtimeFiles = [
  'server/server.js',
  'server/access-preflight.js',
  'server/pre-listen-preparation.js',
  'server/adapters/ifind-http-client.js',
  'server/adapters/modelAdapter.js',
  'server/ai/model-quota.js',
  'server/ai/research-safety.js',
  'server/contracts/ifind-diagnostic-errors.js',
  'server/adapters/ifindAdapter.js',
  'server/data/mockData.js',
  'server/db/device-auth-repository.js',
  'server/db/ifind-diagnostic-repository.js',
  'server/db/ifind-market-diagnostic-repository.js',
  'server/db/admin-auth-repository.js',
  'server/db/database-identity.js',
  'server/db/refresh-db.js',
  'server/domain/security-identity.js',
  'server/domain/ifind-calibration.js',
  'server/domain/ifind-report-period-evidence.js',
  'server/domain/ifind-indicator-id.js',
  'server/domain/ifind-market-cases.js',
  'server/domain/ifind-market-financial-parser.js',
  'server/domain/ifind-market-manifest-validator.js',
  'server/domain/ifind-market-quote-parser.js',
  'server/http/auth-http.js',
  'server/http/ifind-market-diagnostic-http.js',
  'server/http/trusted-client.js',
  'server/ifind-diagnostic-runtime.js',
  'server/ifind-secret-preflight.js',
  'server/security/access-control-runtime.js',
  'server/security/admin-auth.js',
  'server/security/device-approval.js',
  'server/security/cvm-ssm-secret-provider.js',
  'server/security/github-tmpfs-secret-provider.js',
  'server/security/ifind-secret-contract.js',
  'server/security/ifind-tmpfs-secret-provider.js',
  'server/security/secret-provider.js',
  'server/security/secret-bootstrap-contract.js',
  'server/security/secret-bootstrap.js',
  'server/services/health.js',
  'server/services/ifind-calibration-service.js',
  'server/services/ifind-diagnostic-service.js',
  'server/services/ifind-market-diagnostic-service.js',
  'server/security/tencent-ssm-client.js',
  'server/secret-preflight.js',
  'server/services/refresh-rules.js',
  'server/utils/refresh-policy.js',
  'public/index.html',
  'public/research.html',
  'public/app.css',
  'public/app.js',
  'public/auth-contract.js',
  'public/auth-lifecycle.js',
  'public/auth-ui.js',
  ...adminDiagnosticRuntimeFiles,
  'public/data-source-contract.js',
  'public/finance-contract.js',
  'public/research.css',
  'public/research-contract.js',
  'public/research.js',
  'public/valuation-position.js'
].sort()

fs.rmSync(distDirectory, { recursive: true, force: true })

for (const relativePath of runtimeFiles) {
  const sourcePath = path.join(repositoryRoot, relativePath)
  const destinationPath = path.join(distDirectory, relativePath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.copyFileSync(sourcePath, destinationPath)
}

const packageJson = require(path.join(repositoryRoot, 'package.json'))
const distPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  private: packageJson.private,
  type: packageJson.type,
  engines: packageJson.engines,
  dependencies: packageJson.dependencies,
  scripts: {
    start: packageJson.scripts.start,
    'access:preflight': packageJson.scripts['access:preflight']
  }
}

fs.writeFileSync(
  path.join(distDirectory, 'package.json'),
  `${JSON.stringify(distPackageJson, null, 2)}\n`
)

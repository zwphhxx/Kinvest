const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function listRelativeFiles(directory, prefix = '') {
  const files = []
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(path.join(directory, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files
}

async function runBuildArtifactsExist() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const fixturePath = path.join(repositoryRoot, 'server', 'data', 'build-leak.log')
  const expectedArtifacts = [
    'package.json',
    'public/app.css',
    'public/app.js',
    'public/data-source-contract.js',
    'public/finance-contract.js',
    'public/index.html',
    'public/research-contract.js',
    'public/research.css',
    'public/research.html',
    'public/research.js',
    'public/valuation-position.js',
    'server/adapters/ifindAdapter.js',
    'server/adapters/modelAdapter.js',
    'server/ai/model-quota.js',
    'server/ai/research-safety.js',
    'server/data/mockData.js',
    'server/db/device-auth-repository.js',
    'server/db/refresh-db.js',
    'server/domain/security-identity.js',
    'server/security/cvm-ssm-secret-provider.js',
    'server/security/device-approval.js',
    'server/security/secret-bootstrap-contract.js',
    'server/security/secret-provider.js',
    'server/server.js',
    'server/services/health.js',
    'server/services/refresh-rules.js',
    'server/utils/refresh-policy.js'
  ]

  try {
    fs.writeFileSync(fixturePath, 'build leak fixture\n')
    execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build.js')], {
      cwd: repositoryRoot
    })

    assert.strictEqual(
      fs.existsSync(path.join(repositoryRoot, 'dist', 'server', 'data', 'build-leak.log')),
      false,
      'Build must not copy files outside the runtime allowlist'
    )
    assert.deepStrictEqual(
      listRelativeFiles(path.join(repositoryRoot, 'dist')),
      expectedArtifacts
    )

    for (const artifact of expectedArtifacts.filter((file) => file.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(repositoryRoot, 'dist', artifact), 'utf8')
      const localReferences = Array.from(
        html.matchAll(/\b(?:href|src)=(["'])(\/[^"']+)\1/g),
        (match) => match[2]
      )
      for (const reference of localReferences) {
        const pathname = reference.split(/[?#]/, 1)[0]
        if (!path.extname(pathname)) continue
        const assetPath = path.join(repositoryRoot, 'dist', 'public', pathname)
        assert.strictEqual(
          fs.existsSync(assetPath) && fs.statSync(assetPath).isFile(),
          true,
          `${artifact} references missing build artifact: ${pathname}`
        )
      }
    }
  } finally {
    fs.rmSync(fixturePath, { force: true })
  }
}

module.exports = { run: runBuildArtifactsExist }

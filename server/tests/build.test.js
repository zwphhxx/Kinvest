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
    'public/admin-contract.js',
    'public/admin.html',
    'public/admin.js',
    'public/app.css',
    'public/app.js',
    'public/auth-contract.js',
    'public/auth-lifecycle.js',
    'public/auth-ui.js',
    'public/auth.css',
    'public/data-source-contract.js',
    'public/finance-contract.js',
    'public/index.html',
    'public/research-contract.js',
    'public/research.css',
    'public/research.html',
    'public/research.js',
    'public/valuation-position.js',
    'server/access-preflight.js',
    'server/adapters/ifindAdapter.js',
    'server/adapters/modelAdapter.js',
    'server/ai/model-quota.js',
    'server/ai/research-safety.js',
    'server/data/mockData.js',
    'server/db/admin-auth-repository.js',
    'server/db/database-identity.js',
    'server/db/device-auth-repository.js',
    'server/db/refresh-db.js',
    'server/domain/security-identity.js',
    'server/http/auth-http.js',
    'server/http/trusted-client.js',
    'server/pre-listen-preparation.js',
    'server/secret-preflight.js',
    'server/security/access-control-runtime.js',
    'server/security/admin-auth.js',
    'server/security/cvm-ssm-secret-provider.js',
    'server/security/device-approval.js',
    'server/security/github-tmpfs-secret-provider.js',
    'server/security/secret-bootstrap-contract.js',
    'server/security/secret-bootstrap.js',
    'server/security/secret-provider.js',
    'server/security/tencent-ssm-client.js',
    'server/server.js',
    'server/services/health.js',
    'server/services/refresh-rules.js',
    'server/utils/refresh-policy.js'
  ]

  const dockerfile = fs.readFileSync(
    path.join(repositoryRoot, 'Dockerfile'),
    'utf8'
  )
  const linuxSmokePath = path.join(
    repositoryRoot,
    'scripts',
    'docker-access-preflight-linux-smoke.js'
  )
  assert.equal(fs.existsSync(linuxSmokePath), true)
  assert.match(
    dockerfile,
    /^FROM build AS access-preflight-linux-smoke[\s\S]*RUN node scripts\/docker-access-preflight-linux-smoke[.]js$/m
  )
  assert.match(
    dockerfile,
    /^COPY --from=access-preflight-linux-smoke \/tmp\/kinvest-access-preflight-linux-smoke-ok \/tmp\/kinvest-access-preflight-linux-smoke-ok$/m
  )
  const linuxSmoke = fs.readFileSync(linuxSmokePath, 'utf8')
  assert.match(linuxSmoke, /process[.]platform[^\n]*linux/)
  assert.match(linuxSmoke, /runAccessPreflight/)
  assert.match(linuxSmoke, /KINVEST_ACCESS_PREFLIGHT_OK/)
  const sourcePackageContract = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'package.json'),
    'utf8'
  ))
  const lockfileContract = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'package-lock.json'),
    'utf8'
  ))
  assert.equal(sourcePackageContract.engines.node, '>=22.16.0')
  assert.equal(lockfileContract.packages[''].engines.node, '>=22.16.0')
  assert.deepStrictEqual(dockerfile.match(/^FROM\b.*$/gm), [
    'FROM node:22.16.0-alpine AS build',
    'FROM build AS access-preflight-linux-smoke',
    'FROM node:22.16.0-alpine AS github-tmpfs-provider-smoke',
    'FROM node:22.16.0-alpine AS runtime-dependencies',
    'FROM node:22.16.0-alpine AS runtime'
  ])
  const preflightSource = fs.readFileSync(
    path.join(repositoryRoot, 'server', 'access-preflight.js'),
    'utf8'
  )
  assert.doesNotMatch(preflightSource, /enableDefensive/)
  assert.match(preflightSource, /new DatabaseSync/)
  assert.match(preflightSource, /readOnly: true/)
  assert.match(preflightSource, /PRAGMA query_only = ON/)
  const deployWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8'
  )
  assert.equal(
    Array.from(deployWorkflow.matchAll(/node-version: "22[.]16[.]0"/g)).length,
    2
  )
  assert.doesNotMatch(deployWorkflow, /node-version: "22[.]13[.]0"/)

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
    const sourcePackage = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, 'package.json'),
      'utf8'
    ))
    const distPackage = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, 'dist', 'package.json'),
      'utf8'
    ))
    assert.deepEqual(distPackage.dependencies, sourcePackage.dependencies)
    assert.deepEqual(distPackage.dependencies, {
      'tencentcloud-sdk-nodejs-common': '4.1.220',
      'tencentcloud-sdk-nodejs-ssm': '4.1.275'
    })
    assert.equal(distPackage.scripts['access:preflight'], 'node server/access-preflight.js')

    const distServerPath = path.join(repositoryRoot, 'dist', 'server', 'server.js')
    delete require.cache[require.resolve(distServerPath)]
    assert.doesNotThrow(
      () => require(distServerPath),
      'Built server runtime must load with every local production dependency present'
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

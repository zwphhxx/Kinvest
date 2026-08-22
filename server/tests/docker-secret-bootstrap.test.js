const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function run() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8')

  assert.match(dockerfile, /FROM node:22[.]16[.]0-alpine AS runtime-dependencies/)
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/)
  assert.match(dockerfile, /COPY --from=runtime-dependencies \/app\/node_modules \.\/node_modules/)
  assert.match(dockerfile, /io\.kinvest\.secret-bootstrap="1"/)
  assert.match(dockerfile, /io\.kinvest\.access-control\.contract="1"/)
  assert.match(
    dockerfile,
    /require\('tencentcloud-sdk-nodejs-ssm'\).*require\('tencentcloud-sdk-nodejs-common'\)/s
  )
  assert.match(dockerfile, /require\('\.\/server\/security\/github-tmpfs-secret-provider'\)/)
  assert.match(dockerfile, /AS github-tmpfs-provider-smoke/)
  assert.match(dockerfile, /docker-github-tmpfs-smoke\.js prepare/)
  assert.match(dockerfile, /USER 10001:10001[\s\S]*docker-github-tmpfs-smoke\.js verify/)
  assert.match(dockerfile, /COPY --from=github-tmpfs-provider-smoke \/tmp\/kinvest-github-tmpfs-smoke-ok/)
  assert.equal(dockerfile.includes('COPY --from=github-tmpfs-provider-smoke /run/secrets'), false)

  const provider = require('../security/github-tmpfs-secret-provider')
  const dockerUser = dockerfile.match(/USER ([0-9]+):([0-9]+)/)
  assert.equal(Boolean(dockerUser), true)
  assert.equal(Number(dockerUser[1]), provider.APPLICATION_UID)
  assert.equal(Number(dockerUser[2]), provider.APPLICATION_GID)
}

module.exports = { run }

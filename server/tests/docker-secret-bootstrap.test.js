const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function run() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8')

  assert.match(dockerfile, /FROM node:22-alpine AS runtime-dependencies/)
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/)
  assert.match(dockerfile, /COPY --from=runtime-dependencies \/app\/node_modules \.\/node_modules/)
  assert.match(dockerfile, /io\.kinvest\.secret-bootstrap="1"/)
  assert.match(
    dockerfile,
    /require\('tencentcloud-sdk-nodejs-ssm'\).*require\('tencentcloud-sdk-nodejs-common'\)/s
  )
}

module.exports = { run }

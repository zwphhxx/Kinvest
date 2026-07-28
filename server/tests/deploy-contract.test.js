const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')

function readRootFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

async function run() {
  const dockerfile = readRootFile('Dockerfile')
  const compose = readRootFile('deploy/server/docker-compose.yml')
  const dockerignore = readRootFile('.dockerignore')

  assert.match(dockerfile, /FROM node:22-alpine/)
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /^HEALTHCHECK\b/m)

  assert.match(compose, /external:\s*true/)
  assert.match(compose, /KINVEST_DB_PATH:\s*\/data\/kinvest\.sqlite/)
  assert.doesNotMatch(compose, /^\s*ports\s*:/m)

  assert.match(dockerignore, /^\.env$/m)
  assert.match(dockerignore, /^\*\.sqlite$/m)
  assert.match(dockerignore, /^\*\.log$/m)
}

module.exports = { run }

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const preflightPath = path.join(rootDir, 'server/ifind-secret-preflight.js')
const composePath = path.join(rootDir, 'deploy/server/docker-compose-v5.yml')

function capture() {
  let value = ''
  return { stream: { write: (chunk) => { value += chunk } }, value: () => value }
}

async function run() {
  assert.equal(fs.existsSync(preflightPath), true, 'iFinD preflight entrypoint must exist')
  const { runPreflight } = require(preflightPath)

  const disabledOut = capture()
  const disabledErr = capture()
  let disabledLoads = 0
  assert.equal(await runPreflight({
    env: { KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled' },
    load: async () => { disabledLoads += 1 },
    stdout: disabledOut.stream,
    stderr: disabledErr.stream
  }), 0)
  assert.equal(disabledLoads, 0)
  assert.equal(disabledOut.value(), 'KINVEST_IFIND_PREFLIGHT_OK mode=disabled references=0\n')
  assert.equal(disabledErr.value(), '')

  const token = 'synthetic-ifind-refresh-token-never-log'
  const diagnosticOut = capture()
  const diagnosticErr = capture()
  let cleared = false
  assert.equal(await runPreflight({
    env: {
      KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
      KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: 'v20260826-001',
      KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind'
    },
    load: async () => ({
      readRefreshToken: () => Buffer.from(token),
      clear: () => { cleared = true }
    }),
    stdout: diagnosticOut.stream,
    stderr: diagnosticErr.stream
  }), 0)
  assert.equal(cleared, true)
  assert.equal(diagnosticOut.value(), 'KINVEST_IFIND_PREFLIGHT_OK mode=admin-diagnostic references=1\n')
  assert.equal(diagnosticErr.value(), '')
  assert.equal((diagnosticOut.value() + diagnosticErr.value()).includes(token), false)

  const failedOut = capture()
  const failedErr = capture()
  const error = Object.assign(new Error(token), { code: 'IFIND_TMPFS_BUNDLE_INVALID' })
  assert.equal(await runPreflight({
    env: {
      KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
      KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: 'v20260826-001',
      KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind'
    },
    load: async () => { throw error },
    stdout: failedOut.stream,
    stderr: failedErr.stream
  }), 1)
  assert.equal(failedOut.value(), '')
  assert.equal(failedErr.value(), 'IFIND_TMPFS_BUNDLE_INVALID\n')
  assert.equal(failedErr.value().includes(token), false)

  const compose = fs.readFileSync(composePath, 'utf8')
  assert.match(compose, /KINVEST_IFIND_DIAGNOSTIC_MODE:/)
  assert.match(compose, /KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID:/)
  assert.match(compose, /KINVEST_IFIND_SECRET_BUNDLE_PATH:/)
  assert.match(compose, /target: \/run\/secrets\/kinvest-ifind/)
  assert.match(compose, /KINVEST_IFIND_SECRET_BUNDLE_HOST_PATH/)
  assert.doesNotMatch(compose, /IFIND.*MATERIAL|refreshTokenMaterial|refresh-token:/i)

  const build = fs.readFileSync(path.join(rootDir, 'scripts/build.js'), 'utf8')
  const dockerfile = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8')
  assert.match(build, /server\/ifind-secret-preflight\.js/)
  assert.match(dockerfile, /io\.kinvest\.ifind-secret-bootstrap="1"/)

  const fingerprint = crypto.createHash('sha256').update(token).digest('hex')
  assert.equal(fingerprint.length, 64)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-ifind-preflight-test-'))
  fs.rmSync(scratch, { recursive: true, force: true })
}

module.exports = { run }

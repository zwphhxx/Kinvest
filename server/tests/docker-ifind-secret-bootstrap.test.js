const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const preflightPath = path.join(rootDir, 'server/ifind-secret-preflight.js')
const runtimePath = path.join(rootDir, 'server/ifind-diagnostic-runtime.js')
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
  const composeEnvironment = Object.fromEntries(
    [
      'PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST',
      'DOCKER_CLI_PLUGIN_EXTRA_DIRS', 'TMPDIR', 'XDG_CONFIG_HOME',
      'XDG_RUNTIME_DIR'
    ]
      .filter((key) => Object.hasOwn(process.env, key))
      .map((key) => [key, process.env[key]])
  )
  Object.assign(composeEnvironment, {
    COMPOSE_DISABLE_ENV_FILE: '1',
    KINVEST_IMAGE: 'kinvest:test',
    KINVEST_SECRET_PROVIDER_MODE: 'tmpfs',
    KINVEST_SECRET_VERSION_IDS: '{"admin-password-verifier":"v-test"}',
    KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
    KINVEST_TRUSTED_PROXY_ADDRESSES: '["127.0.0.1"]',
    KINVEST_CONTAINER_IP: '172.30.0.2',
    KINVEST_SECRET_BUNDLE_HOST_PATH: '/run/kinvest-test-secrets',
    KINVEST_METADATA_NETWORK: 'kinvest-test-metadata',
    KINVEST_BRIDGE_INTERFACE: 'br-kinvest-tst',
    KINVEST_METADATA_SUBNET: '172.30.0.0/24',
    KINVEST_METADATA_GATEWAY: '172.30.0.1',
    KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled',
    KINVEST_IFIND_SECRET_BUNDLE_HOST_PATH: '/run/kinvest-test-ifind-secrets'
  })
  const composeModel = JSON.parse(execFileSync('docker', [
    'compose', '-f', composePath, 'config', '--format', 'json'
  ], {
    cwd: rootDir,
    env: composeEnvironment,
    encoding: 'utf8'
  }))
  assert.deepEqual(Object.keys(composeModel.services), ['kinvest'])
  const disabledEnvironment = composeModel.services.kinvest.environment
  assert.equal(disabledEnvironment.TZ, 'Asia/Shanghai')
  assert.equal(disabledEnvironment.KINVEST_DB_PATH, '/data/kinvest.sqlite')
  const disabledIfindComposeEnvironment = Object.fromEntries(
    Object.entries(disabledEnvironment)
      .filter(([key]) => key.startsWith('KINVEST_IFIND_'))
  )
  assert.deepEqual(disabledIfindComposeEnvironment, {
    KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled',
    KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: null,
    KINVEST_IFIND_SECRET_BUNDLE_PATH: null
  })
  const disabledIfindEnvironment = Object.fromEntries(
    Object.entries(disabledIfindComposeEnvironment).filter(([, value]) => value !== null)
  )
  const { createIfindDiagnosticRuntime } = require(runtimePath)
  const disabledRuntime = await createIfindDiagnosticRuntime({
    env: disabledIfindEnvironment
  })
  assert.deepEqual(disabledRuntime.status, {
    mode: 'disabled',
    configured: false,
    versionId: null
  })
  assert.match(compose, /- KINVEST_IFIND_DIAGNOSTIC_MODE/)
  assert.match(compose, /- KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID/)
  assert.match(compose, /- KINVEST_IFIND_SECRET_BUNDLE_PATH/)
  assert.match(compose, /target: \/run\/secrets\/kinvest-ifind/)
  assert.match(compose, /KINVEST_IFIND_SECRET_BUNDLE_HOST_PATH/)
  assert.doesNotMatch(compose, /kinvest-disabled|kinvest-diagnostic|COMPOSE_PROFILES|profiles:/)
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

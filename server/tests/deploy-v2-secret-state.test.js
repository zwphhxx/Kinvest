const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { readLogLines, runRootFixture } = require('./deploy-v2-contract.test')

const rootDir = path.resolve(__dirname, '../..')
const enabledOne = '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"}}'
const enabledTwo = '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001","v20260812-002"],"active":"v20260812-002"}}'

function stateSource(mapping, { digest = '__DIGEST__', commit = '__COMMIT__' } = {}) {
  return [
    'protocolVersion=2',
    `imageDigest=${digest}`,
    `commit=${commit}`,
    'schemaVersion=0',
    'imageSchemaMin=0',
    'imageSchemaMax=0',
    `secretVersionIds=${mapping}`,
    'releaseRecordSchemaVersion=2',
    'verificationRunId=654321',
    'artifactSource=ghcr-public',
    'databaseBackupPath=none',
    'databaseBackupChecksum=none',
    'deployedAt=2026-08-12T00:00:00Z',
    ''
  ].join('\n')
}

function dockerLog(fixture) {
  return readLogLines(path.join(fixture.fakeState, 'docker.log'))
}

function runtimeEnvLog(fixture) {
  return readLogLines(path.join(fixture.fakeState, 'runtime-env.log'))
}

function assertNoMutation(fixture) {
  assert.equal(
    fs.readFileSync(path.join(fixture.stateDir, 'current.state'), 'utf8'),
    fixture.initialCurrentState
  )
  assert.equal(fs.existsSync(path.join(fixture.stateDir, 'attempt.state')), false)
  const previousStatePath = path.join(fixture.stateDir, 'previous.state')
  if (fixture.initialPreviousState === null) {
    assert.equal(fs.existsSync(previousStatePath), false)
  } else {
    assert.equal(fs.readFileSync(previousStatePath, 'utf8'), fixture.initialPreviousState)
  }
  assert.equal(fs.readdirSync(path.join(fixture.root, 'backups')).length, 0)
  assert.equal(dockerLog(fixture).some((line) => /^compose .*\bup\b/.test(line)), false)
}

async function run() {
  const deploy = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-kinvest-v2.sh'), 'utf8')
  const compose = fs.readFileSync(path.join(rootDir, 'deploy/server/docker-compose.yml'), 'utf8')

  assert.match(deploy, /^SECRET_VERSION_VALIDATOR='\/usr\/local\/libexec\/kinvest-secret-version-config'$/m)
  assert.match(deploy, /io\.kinvest\.secret-bootstrap/)
  assert.match(deploy, /KINVEST_SSM_PREFLIGHT_OK references=/)
  assert.match(deploy, /--user 10001:10001[\s\\]*\n?[\s\S]{0,300}--read-only[\s\\]*\n?[\s\S]{0,300}--cap-drop ALL[\s\\]*\n?[\s\S]{0,300}--security-opt no-new-privileges:true[\s\\]*\n?[\s\S]{0,300}--network container:kinvest/)
  assert.match(deploy, /--entrypoint node[\s\\]*\n?[\s\S]{0,200}server\/secret-preflight\.js/)
  assert.match(compose, /KINVEST_SECRET_PROVIDER_MODE: \$\{KINVEST_SECRET_PROVIDER_MODE/)
  assert.match(compose, /KINVEST_SECRET_VERSION_IDS: \$\{KINVEST_SECRET_VERSION_IDS/)
  assert.doesNotMatch(compose, /SecretString|secretId|secretKey|SECRET_KEY|HMAC_KEY/)

  const disabled = runRootFixture(deploy)
  try {
    assert.equal(disabled.result.status, 0, disabled.result.stderr)
    assert.equal(dockerLog(disabled).some((line) => line.startsWith('run ')), false)
    assert.ok(runtimeEnvLog(disabled).some((line) => line === 'compose|disabled|{}'))
  } finally {
    disabled.cleanup()
  }

  const enabled = runRootFixture(deploy, {
    secretVersionIds: enabledTwo,
    preflightReferences: '3'
  })
  try {
    assert.equal(enabled.result.status, 0, enabled.result.stderr)
    const calls = dockerLog(enabled)
    const preflight = calls.find((line) => line.startsWith('run '))
    assert.ok(preflight)
    assert.match(preflight, /^run --rm --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --network container:kinvest /)
    assert.match(preflight, /--env KINVEST_SECRET_PROVIDER_MODE=cvm-ssm /)
    assert.match(preflight, /--env KINVEST_SECRET_VERSION_IDS=/)
    assert.match(preflight, /--entrypoint node .* server\/secret-preflight\.js$/)
    const preflightIndex = calls.indexOf(preflight)
    const composeUpIndex = calls.findIndex((line) => /^compose .*\bup\b/.test(line))
    assert.ok(preflightIndex >= 0 && composeUpIndex > preflightIndex)
    assert.ok(runtimeEnvLog(enabled).some((line) => line === `compose|cvm-ssm|${enabledTwo}`))
    const current = fs.readFileSync(path.join(enabled.stateDir, 'current.state'), 'utf8')
    assert.match(current, new RegExp(`^secretVersionIds=${enabledTwo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.equal(fs.statSync(path.join(enabled.stateDir, 'current.state')).mode & 0o777, 0o600)
  } finally {
    enabled.cleanup()
  }

  for (const scenario of [
    { mode: 'preflight-label-missing', message: /bootstrap label/i },
    { mode: 'preflight-failure', message: /preflight failed/i },
    { mode: 'preflight-stderr', message: /preflight failed/i },
    { mode: 'preflight-extra-output', message: /preflight failed/i },
    { mode: 'preflight-missing-entry', message: /preflight failed/i }
  ]) {
    const fixture = runRootFixture(deploy, {
      mode: scenario.mode,
      secretVersionIds: enabledOne
    })
    try {
      assert.notEqual(fixture.result.status, 0)
      assert.match(fixture.result.stderr, scenario.message)
      assert.doesNotMatch(fixture.result.stderr, /v20260812/)
      assertNoMutation(fixture)
    } finally {
      fixture.cleanup()
    }
  }

  for (const invalid of [
    '{"rollback":"previous","extra":true}',
    '{"adminPasswordVerifier":"current","deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"}}'
  ]) {
    const fixture = runRootFixture(deploy, { secretVersionIds: invalid })
    try {
      assert.notEqual(fixture.result.status, 0)
      assertNoMutation(fixture)
      assert.doesNotMatch(fixture.result.stderr, /v20260812|current/)
    } finally {
      fixture.cleanup()
    }
  }

  const rollbackEnabled = runRootFixture(deploy, {
    secretVersionIds: '{"rollback":"previous"}',
    currentSecretVersionIds: '{}',
    previousStateSource: stateSource(enabledOne)
  })
  try {
    assert.equal(rollbackEnabled.result.status, 0, rollbackEnabled.result.stderr)
    assert.ok(dockerLog(rollbackEnabled).some((line) => line.startsWith('run ')))
    assert.ok(runtimeEnvLog(rollbackEnabled).some((line) => line === `compose|cvm-ssm|${enabledOne}`))
    assert.match(
      fs.readFileSync(path.join(rollbackEnabled.stateDir, 'current.state'), 'utf8'),
      new RegExp(`^secretVersionIds=${enabledOne.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
    )
  } finally {
    rollbackEnabled.cleanup()
  }

  const rollbackDisabled = runRootFixture(deploy, {
    secretVersionIds: '{"rollback":"previous"}',
    currentSecretVersionIds: enabledOne,
    previousStateSource: stateSource('{}')
  })
  try {
    assert.equal(rollbackDisabled.result.status, 0, rollbackDisabled.result.stderr)
    assert.equal(dockerLog(rollbackDisabled).some((line) => line.startsWith('run ')), false)
    assert.ok(runtimeEnvLog(rollbackDisabled).some((line) => line === 'compose|disabled|{}'))
  } finally {
    rollbackDisabled.cleanup()
  }

  for (const previousStateSource of [
    null,
    stateSource(enabledOne, {
      digest: `ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}`
    }),
    stateSource('{"adminPasswordVerifier":"current"}')
  ]) {
    const fixture = runRootFixture(deploy, {
      secretVersionIds: '{"rollback":"previous"}',
      currentSecretVersionIds: '{}',
      previousStateSource
    })
    try {
      assert.notEqual(fixture.result.status, 0)
      assertNoMutation(fixture)
      assert.doesNotMatch(fixture.result.stderr, /v20260812|current/)
    } finally {
      fixture.cleanup()
    }
  }

  const automaticRollback = runRootFixture(deploy, {
    mode: 'public-health-failure',
    secretVersionIds: '{}',
    currentSecretVersionIds: enabledOne
  })
  try {
    assert.notEqual(automaticRollback.result.status, 0)
    const composeEnvironments = runtimeEnvLog(automaticRollback).filter((line) => line.startsWith('compose|'))
    assert.equal(composeEnvironments.at(-1), `compose|cvm-ssm|${enabledOne}`)
  } finally {
    automaticRollback.cleanup()
  }
}

module.exports = { run }

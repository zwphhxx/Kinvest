const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const workflowPath = path.join(rootDir, '.github/workflows/deploy-production-v3-manual.yml')

function namedStep(source, name) {
  const lines = source.split('\n')
  const marker = `      - name: ${name}`
  const start = lines.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - ')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function stepRun(step) {
  const lines = step.split('\n')
  const start = lines.indexOf('        run: |')
  assert.notEqual(start, -1)
  return lines.slice(start + 1).map((line) => line.slice(10)).join('\n')
}

function materials() {
  const admin = Buffer.from(JSON.stringify({
    digest: Buffer.alloc(32, 1).toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: Buffer.alloc(16, 2).toString('base64url')
  })).toString('base64url')
  return { admin, hmac: Buffer.alloc(32, 3).toString('base64url') }
}

function runGate(script, intent, confirm) {
  return spawnSync('bash', ['-c', script], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CONFIRM: confirm,
      INTENT: intent,
      RELEASE_RUN_ID: '12345',
      WORKFLOW_REF: 'refs/heads/main'
    }
  })
}

function runDeploy(script, overrides = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-deploy-v3-workflow-'))
  const binDir = path.join(fixture, 'bin')
  const payloadPath = path.join(fixture, 'payload')
  const argsPath = path.join(fixture, 'args')
  const environmentPath = path.join(fixture, 'environment')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'ssh'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$CAPTURE_ARGS"',
    '/usr/bin/env > "$CAPTURE_ENVIRONMENT"',
    'cat > "$CAPTURE_PAYLOAD"'
  ].join('\n') + '\n', { mode: 0o700 })
  const secretMaterial = materials()
  const result = spawnSync('bash', ['-c', script], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ADMIN_MATERIAL: secretMaterial.admin,
      CAPTURE_ARGS: argsPath,
      CAPTURE_ENVIRONMENT: environmentPath,
      CAPTURE_PAYLOAD: payloadPath,
      DEPLOY_HOST: 'example.invalid',
      DEPLOY_PORT: '4334',
      DEPLOY_SHA: 'b'.repeat(40),
      DEPLOY_USER: 'kinvest_deploy',
      HMAC_MATERIAL: secretMaterial.hmac,
      HOME: fixture,
      IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      INTENT: 'FORWARD',
      PATH: `${binDir}:${process.env.PATH}`,
      RELEASE_SCHEMA: '2',
      TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
      TMPFS_BOOTSTRAP_ENABLED: 'true',
      TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
      VERIFICATION_RUN_ID: '12345',
      ...overrides
    }
  })
  const captured = {
    args: fs.existsSync(argsPath) ? fs.readFileSync(argsPath, 'utf8') : '',
    environment: fs.existsSync(environmentPath) ? fs.readFileSync(environmentPath, 'utf8') : '',
    payload: fs.existsSync(payloadPath) ? fs.readFileSync(payloadPath, 'utf8') : '',
    result,
    secretMaterial
  }
  fs.rmSync(fixture, { recursive: true, force: true })
  return captured
}

async function run() {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const gate = namedStep(workflow, 'Validate deployment gate')
  const revalidate = namedStep(workflow, 'Revalidate trusted control plane after approval')
  const deploy = namedStep(workflow, 'Deploy canonical payload with deploy-v3 stdin')
  const gateScript = stepRun(gate)
  const deployScript = stepRun(deploy)

  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /pull_request_target|pull_request:/)
  assert.match(workflow, /^permissions:\n {2}contents: read$/m)
  assert.match(workflow, /environment: Production/)
  assert.match(revalidate, /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(revalidate, /git\/ref\/heads\/main/)
  assert.match(revalidate, /TARGET_SHA.*needs\.validate\.outputs\.commit_sha/)
  assert.match(workflow, /name: Check out trusted deployment control plane[\s\S]*ref: \$\{\{ github\.sha \}\}/)
  assert.doesNotMatch(workflow, /ref: \$\{\{ needs\.validate\.outputs\.commit_sha \}\}/)
  assert.ok(workflow.indexOf('Revalidate trusted control plane after approval') < workflow.indexOf('Configure strict SSH trust'))
  assert.match(workflow, /DEPLOY_V3_ENABLED/)
  assert.match(workflow, /TMPFS_BOOTSTRAP_ENABLED/)
  assert.match(workflow, /TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID/)
  assert.match(workflow, /TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID/)
  assert.match(workflow, /gh run download/)
  assert.match(workflow, /release-record-v2/)
  assert.match(workflow, /artifactSource.*ghcr-public/)
  assert.match(workflow, /KINVEST_DEPLOY_V3/)
  assert.match(workflow, /ssh[\s\S]*'deploy-v3'/)
  assert.match(workflow, /Remove ephemeral SSH material[\s\S]*if: \$\{\{ always\(\) \}\}/)
  assert.doesNotMatch(workflow, /GITHUB_ENV|docker (?:login|push)|set -x/)

  for (const secretName of [
    'KINVEST_ADMIN_PASSWORD_VERIFIER_B64URL',
    'KINVEST_DEVICE_TOKEN_HMAC_KEY'
  ]) {
    assert.equal(workflow.split(`secrets.${secretName}`).length - 1, 1)
    assert.match(deploy, new RegExp(`secrets\\.${secretName}`))
  }
  assert.doesNotMatch(deployScript, /echo|printenv|env\s|ps\s/)
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
    assert.match(match[1], /@[0-9a-f]{40}$/)
  }

  for (const [intent, confirm] of [
    ['FORWARD', 'DEPLOY_V3'],
    ['ROLLBACK', 'ROLLBACK_V3'],
    ['RESTORE', 'RESTORE_V3']
  ]) {
    const accepted = runGate(gateScript, intent, confirm)
    assert.equal(accepted.status, 0, `${intent} confirmation was rejected`)
    assert.equal(accepted.stdout, '')
  }
  const rejected = runGate(gateScript, 'RESTORE', 'DEPLOY_V3')
  assert.notEqual(rejected.status, 0)

  const enabled = runDeploy(deployScript)
  assert.equal(enabled.result.status, 0, 'enabled deploy step failed')
  assert.equal(enabled.result.stdout, '')
  assert.equal(enabled.result.stderr, '')
  const enabledLines = enabled.payload.trimEnd().split('\n')
  assert.equal(enabledLines.length, 12)
  assert.deepEqual(enabledLines.slice(0, 9), [
    'KINVEST_DEPLOY_V3',
    'FORWARD',
    `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    'b'.repeat(40),
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"12345"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1',
    'v20260813-001',
    'v20260813-002'
  ])
  assert.equal(enabledLines[9] === enabled.secretMaterial.admin, true)
  assert.equal(enabledLines[10] === enabled.secretMaterial.hmac, true)
  assert.equal(enabledLines[11], 'EOF')
  assert.match(enabled.args, /deploy-v3/)
  assert.equal(enabled.args.includes(enabled.secretMaterial.admin), false)
  assert.equal(enabled.args.includes(enabled.secretMaterial.hmac), false)
  assert.equal(enabled.environment.includes('ADMIN_MATERIAL='), false)
  assert.equal(enabled.environment.includes('HMAC_MATERIAL='), false)
  assert.equal(enabled.environment.includes(enabled.secretMaterial.admin), false)
  assert.equal(enabled.environment.includes(enabled.secretMaterial.hmac), false)

  const disabled = runDeploy(deployScript, {
    TMPFS_BOOTSTRAP_ENABLED: 'false'
  })
  assert.equal(disabled.result.status, 0, 'disabled deploy step failed')
  const disabledLines = disabled.payload.trimEnd().split('\n')
  assert.equal(disabledLines[6], 'disabled')
  assert.deepEqual(disabledLines.slice(7, 11), ['', '', '', ''])
  assert.equal(disabled.payload.includes(disabled.secretMaterial.admin), false)
  assert.equal(disabled.payload.includes(disabled.secretMaterial.hmac), false)
  assert.equal(disabled.environment.includes('ADMIN_MATERIAL='), false)
  assert.equal(disabled.environment.includes('HMAC_MATERIAL='), false)
  assert.equal(disabled.environment.includes(disabled.secretMaterial.admin), false)
  assert.equal(disabled.environment.includes(disabled.secretMaterial.hmac), false)

  const invalidMode = runDeploy(deployScript, { TMPFS_BOOTSTRAP_ENABLED: 'yes' })
  assert.notEqual(invalidMode.result.status, 0)
  assert.equal(invalidMode.payload, '')
  assert.equal(invalidMode.result.stdout.includes(invalidMode.secretMaterial.admin), false)
  assert.equal(invalidMode.result.stderr.includes(invalidMode.secretMaterial.admin), false)
}

module.exports = { run }

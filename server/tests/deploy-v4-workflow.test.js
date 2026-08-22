const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const workflow = fs.readFileSync(path.join(rootDir, '.github/workflows/deploy-production-v4-manual.yml'), 'utf8')

function stepScript(name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  assert.notEqual(start, -1)
  const run = lines.findIndex((line, index) => index > start && line === '        run: |')
  assert.notEqual(run, -1)
  let end = lines.length
  for (let index = run + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - ')) { end = index; break }
  }
  return lines.slice(run + 1, end).map((line) => line.slice(10)).join('\n')
}

function secretMaterial() {
  const admin = JSON.stringify({
    digest: Buffer.alloc(32, 1).toString('base64url'), format: 'kinvest-admin-scrypt-v1',
    n: 65536, p: 1, r: 8, salt: Buffer.alloc(16, 2).toString('base64url')
  })
  return { admin: Buffer.from(admin).toString('base64url'), hmac: Buffer.alloc(32, 3).toString('base64url') }
}

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-workflow-'))
  try {
    const bin = path.join(fixture, 'bin')
    fs.mkdirSync(bin)
    const payloadFile = path.join(fixture, 'payload')
    const argsFile = path.join(fixture, 'args')
    const envFile = path.join(fixture, 'env')
    const githubEnv = path.join(fixture, 'github-env')
    fs.writeFileSync(githubEnv, '')
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" >"$ARGS_FILE"\n/usr/bin/env >"$ENV_FILE"\ncat >"$PAYLOAD_FILE"\n', { mode: 0o755 })
    const secret = secretMaterial()
    const result = spawnSync('bash', ['-c', stepScript('Deploy canonical payload with deploy-v4 stdin')], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_MATERIAL: secret.admin,
        HMAC_MATERIAL: secret.hmac,
        SSH_USER: 'lighthouse', KINVEST_DEPLOY_GATE_USER: 'lighthouse',
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334',
        DEPLOY_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        RELEASE_SCHEMA: '2', VERIFICATION_RUN_ID: '123', INTENT: 'FORWARD',
        TMPFS_BOOTSTRAP_ENABLED: 'true',
        TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
        TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        ARGS_FILE: argsFile, ENV_FILE: envFile, PAYLOAD_FILE: payloadFile,
        GITHUB_ENV: githubEnv,
        HOME: fixture, PATH: `${bin}:${process.env.PATH}`
      }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const lines = fs.readFileSync(payloadFile, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 13)
    assert.equal(lines[0], 'KINVEST_DEPLOY_V4')
    assert.equal(lines[1], 'FORWARD')
    assert.equal(lines[2], `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`)
    assert.equal(lines[3], 'b'.repeat(40))
    assert.equal(lines[4], '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}')
    assert.equal(lines[5], '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}')
    assert.equal(lines[6], 'github-tmpfs-v1')
    assert.equal(lines[7], 'v20260813-001')
    assert.equal(lines[8], 'v20260813-002')
    assert.equal(lines[9] === secret.admin, true)
    assert.equal(lines[10] === secret.hmac, true)
    assert.equal(lines[11], '{"accessControlMode":"device-approval","schemaVersion":1}')
    assert.equal(lines[12], 'EOF')
    const args = fs.readFileSync(argsFile, 'utf8')
    const environment = fs.readFileSync(envFile, 'utf8')
    assert.match(args, /deploy-v4/)
    for (const material of [secret.admin, secret.hmac]) {
      assert.equal(args.includes(material), false)
      assert.equal(environment.includes(material), false)
      assert.equal((result.stdout + result.stderr).includes(material), false)
    }
    assert.doesNotMatch(environment, /^(ADMIN_MATERIAL|HMAC_MATERIAL)=/m)
    assert.doesNotMatch(environment, /^SSH_USER=/m)
    assert.equal(fs.readFileSync(githubEnv, 'utf8'), '')

    const mismatch = spawnSync('bash', ['-c', stepScript('Deploy canonical payload with deploy-v4 stdin')], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_MATERIAL: secret.admin,
        HMAC_MATERIAL: secret.hmac,
        SSH_USER: 'review-secret-user', KINVEST_DEPLOY_GATE_USER: 'lighthouse',
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334',
        DEPLOY_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        RELEASE_SCHEMA: '2', VERIFICATION_RUN_ID: '123', INTENT: 'FORWARD',
        TMPFS_BOOTSTRAP_ENABLED: 'true',
        TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
        TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        HOME: fixture, PATH: `${bin}:${process.env.PATH}`
      }
    })
    assert.notEqual(mismatch.status, 0)
    assert.equal(mismatch.stderr, 'KINVEST_DEPLOY_GATE_IDENTITY_MISMATCH\n')
    assert.equal((mismatch.stdout + mismatch.stderr).includes('review-secret-user'), false)

    assert.match(workflow, /SSH_USER: \$\{\{ secrets\.SSH_USER \}\}/)
    assert.match(workflow, /KINVEST_DEPLOY_GATE_USER: \$\{\{ vars\.KINVEST_DEPLOY_GATE_USER \}\}/)
    assert.doesNotMatch(workflow, /DEPLOY_USER: \$\{\{ vars\.DEPLOY_USER \}\}/)

    const prWorkflow = fs.readFileSync(path.join(rootDir, '.github/workflows/deploy.yml'), 'utf8')
    const containerBuild = prWorkflow.slice(prWorkflow.indexOf('  container-build:'), prWorkflow.indexOf('  publish:'))
    assert.doesNotMatch(containerBuild, /environment: Production|secrets\./)
    assert.match(containerBuild, /push: false/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }

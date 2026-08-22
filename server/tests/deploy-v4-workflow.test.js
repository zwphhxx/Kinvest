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
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" >"$ARGS_FILE"\n/usr/bin/env >"$ENV_FILE"\ncat >"$PAYLOAD_FILE"\n', { mode: 0o755 })
    const secret = secretMaterial()
    const result = spawnSync('bash', ['-c', stepScript('Deploy canonical payload with deploy-v4 stdin')], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_MATERIAL: secret.admin,
        HMAC_MATERIAL: secret.hmac,
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334', DEPLOY_USER: 'kinvest-deploy',
        DEPLOY_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        RELEASE_SCHEMA: '2', VERIFICATION_RUN_ID: '123', INTENT: 'FORWARD',
        TMPFS_BOOTSTRAP_ENABLED: 'true',
        TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
        TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        ARGS_FILE: argsFile, ENV_FILE: envFile, PAYLOAD_FILE: payloadFile,
        HOME: fixture, PATH: `${bin}:${process.env.PATH}`
      }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const lines = fs.readFileSync(payloadFile, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 13)
    assert.equal(lines[0], 'KINVEST_DEPLOY_V4')
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
    assert.doesNotMatch(environment, /^(ADMIN_MATERIAL|HMAC_MATERIAL|GITHUB_ENV)=/m)

    const prWorkflow = fs.readFileSync(path.join(rootDir, '.github/workflows/deploy.yml'), 'utf8')
    const containerBuild = prWorkflow.slice(prWorkflow.indexOf('  container-build:'), prWorkflow.indexOf('  publish:'))
    assert.doesNotMatch(containerBuild, /environment: Production|secrets\./)
    assert.match(containerBuild, /push: false/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }

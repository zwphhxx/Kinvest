const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const workflowPath = path.join(rootDir, '.github/workflows/deploy-production-v2-manual.yml')
const enabled = '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001","v20260812-002"],"active":"v20260812-002"}}'

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

function runMappingStep(script, env) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-j4b-workflow-'))
  const githubEnv = path.join(fixture, 'github-env')
  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ENV: githubEnv,
        SSM_BOOTSTRAP_ENABLED: '',
        SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: '',
        SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: '',
        SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '',
        ...env
      }
    })
    return {
      result,
      githubEnv: fs.existsSync(githubEnv) ? fs.readFileSync(githubEnv, 'utf8') : ''
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

async function run() {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const construct = namedStep(workflow, 'Construct canonical secret VersionId payload')
  const deploy = namedStep(workflow, 'Deploy exact GHCR digest with deploy-v2 stdin')
  const constructScript = stepRun(construct)
  const deployScript = stepRun(deploy)

  assert.match(workflow, /^ {6}- name: Check out validated release$/m)
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/)
  assert.match(construct, /SSM_BOOTSTRAP_ENABLED: \$\{\{ vars\.SSM_BOOTSTRAP_ENABLED \}\}/)
  assert.match(construct, /SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: \$\{\{ vars\.SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID \}\}/)
  assert.match(construct, /SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: \$\{\{ vars\.SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID \}\}/)
  assert.match(construct, /SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: \$\{\{ vars\.SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS \}\}/)
  assert.match(constructScript, /secret-version-config\.py from-env/)
  assert.match(constructScript, /\{"rollback":"previous"\}/)
  assert.match(constructScript, /KINVEST_SECRET_VERSION_IDS=/)
  assert.doesNotMatch(constructScript, /echo .*KINVEST_SECRET_VERSION_IDS|cat .*GITHUB_ENV/)
  assert.match(deployScript, /secret-version-config\.py mapping/)
  assert.match(deployScript, /'deploy-v2'/)
  assert.doesNotMatch(deployScript, /SSM_(?:SECRET|PASSWORD|HMAC_KEY)|SecretString|secretId|secretKey/)
  assert.doesNotMatch(workflow, /pull_request_target/)

  const disabled = runMappingStep(constructScript, {
    INTENT: 'FORWARD',
    SSM_BOOTSTRAP_ENABLED: 'false'
  })
  assert.equal(disabled.result.status, 0, disabled.result.stderr)
  assert.equal(disabled.result.stdout, '')
  assert.equal(disabled.githubEnv, 'KINVEST_SECRET_VERSION_IDS={}\n')

  const configured = runMappingStep(constructScript, {
    INTENT: 'FORWARD',
    SSM_BOOTSTRAP_ENABLED: 'true',
    SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001',
    SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: 'v20260812-002',
    SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '["v20260812-001", "v20260812-002"]'
  })
  assert.equal(configured.result.status, 0, configured.result.stderr)
  assert.equal(configured.result.stdout, '')
  assert.equal(configured.githubEnv, `KINVEST_SECRET_VERSION_IDS=${enabled}\n`)

  const rollback = runMappingStep(constructScript, {
    INTENT: 'ROLLBACK',
    SSM_BOOTSTRAP_ENABLED: 'true'
  })
  assert.equal(rollback.result.status, 0, rollback.result.stderr)
  assert.equal(rollback.githubEnv, 'KINVEST_SECRET_VERSION_IDS={"rollback":"previous"}\n')

  for (const env of [
    {
      INTENT: 'FORWARD',
      SSM_BOOTSTRAP_ENABLED: 'false',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001'
    },
    {
      INTENT: 'FORWARD',
      SSM_BOOTSTRAP_ENABLED: 'true',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001',
      SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: 'v20260812-002',
      SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '["v20260812-002","v20260812-001"]'
    },
    { INTENT: 'UNKNOWN', SSM_BOOTSTRAP_ENABLED: 'false' }
  ]) {
    const invalid = runMappingStep(constructScript, env)
    assert.notEqual(invalid.result.status, 0)
    assert.equal(invalid.githubEnv, '')
    assert.doesNotMatch(`${invalid.result.stdout}${invalid.result.stderr}`, /v20260812/)
  }
}

module.exports = { run }

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
  const workflow = fs.readFileSync(path.join(rootDir, '.github/workflows/deploy-production-v5-manual.yml'), 'utf8')

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

function stepSection(name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  assert.notEqual(start, -1)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - ')) { end = index; break }
  }
  return lines.slice(start, end).join('\n')
}

function jobSection(name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.notEqual(start, -1, `missing job ${name}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-zA-Z0-9_-]+:$/.test(lines[index])) { end = index; break }
  }
  return lines.slice(start, end).join('\n')
}

function jobStepScript(jobName, stepName) {
  const section = jobSection(jobName)
  const lines = section.split('\n')
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`)
  assert.notEqual(start, -1, `missing ${jobName} step ${stepName}`)
  const run = lines.findIndex((line, index) => index > start && line === '        run: |')
  assert.notEqual(run, -1, `missing ${jobName} run block ${stepName}`)
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

function provenanceState() {
  const commit = 'b'.repeat(40)
  const digest = `sha256:${'a'.repeat(64)}`
  const runId = '123'
  const attempt = 2
  return {
    artifacts: { artifacts: [{ expired: false, name: `kinvest-release-record-v2-${runId}-${attempt}` }] },
    commit,
    digest,
    mainSha: commit,
    record: {
      artifact_source: 'ghcr-public', commit_sha: commit, created_at: '2026-08-26T00:00:00Z',
      ghcr_digest: digest, schema_version: 2, source_digest: digest,
      source_repository: 'ghcr.io/zwphhxx/kinvest', tcr_digest: null,
      verification_run_attempt: attempt, verification_run_id: runId
    },
    releaseRunId: runId,
    run: {
      conclusion: 'success', event: 'push', head_branch: 'main', head_sha: commit,
      path: '.github/workflows/deploy.yml', run_attempt: attempt
    },
    validatedCommit: commit,
    validatedDigest: digest,
    validatedRunId: runId,
    workflowSha: commit
  }
}

/**
 * @param {string} script
 * @param {(state: ReturnType<typeof provenanceState>) => void} [mutate]
 */
function runProvenanceScript(script, mutate = () => {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v5-provenance-'))
  try {
    const state = provenanceState()
    mutate(state)
    const bin = path.join(fixture, 'bin')
    const sentinel = path.join(fixture, 'secret-ssh-reached')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'api' && args[1].includes('/git/ref/heads/main')) {
  process.stdout.write(process.env.MOCK_MAIN_SHA)
} else if (args[0] === 'api' && args[1].endsWith('/artifacts')) {
  process.stdout.write(process.env.MOCK_ARTIFACTS)
} else if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
  process.stdout.write(process.env.MOCK_RUN)
} else if (args[0] === 'run' && args[1] === 'download') {
  const directory = args[args.indexOf('--dir') + 1]
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'release-record.json'), process.env.MOCK_RECORD)
} else {
  process.exitCode = 97
}
`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n[ "$1:$2" = "merge-base:--is-ancestor" ]\n', { mode: 0o755 })
    const command = `${script}\nprintf '%s\\n' reached >"$SECRET_SSH_SENTINEL"`
    const result = spawnSync('bash', ['-c', command], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_TOKEN: 'synthetic-github-token',
        GITHUB_REPOSITORY: 'zwphhxx/Kinvest',
        INTENT: 'FORWARD',
        MOCK_ARTIFACTS: JSON.stringify(state.artifacts),
        MOCK_MAIN_SHA: state.mainSha,
        MOCK_RECORD: JSON.stringify(state.record),
        MOCK_RUN: JSON.stringify(state.run),
        PATH: `${bin}:${process.env.PATH}`,
        PROVENANCE_MODE: 'artifact-v2',
        RELEASE_RUN_ID: state.releaseRunId,
        SECRET_SSH_SENTINEL: sentinel,
        VALIDATED_COMMIT: state.validatedCommit,
        VALIDATED_DIGEST: state.validatedDigest,
        VALIDATED_RUN_ID: state.validatedRunId,
        VALIDATED_SCHEMA: '2',
        WORKFLOW_SHA: state.workflowSha
      }
    })
    return { reached: fs.existsSync(sentinel), result, state }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

async function run() {
  assert.match(workflow, /provenance_mode:/)
  assert.match(workflow, /artifact-v2/)
  assert.match(workflow, /state-reproof/)
  for (const input of ['target_digest', 'target_commit', 'target_verification_run_id']) {
    assert.match(workflow, new RegExp(`${input}:`))
  }
  assert.match(workflow, /ROLLBACK_STATE_REPROOF/)
  assert.match(workflow, /RESTORE_STATE_REPROOF/)
  assert.match(workflow, /DEPLOY_V5_STATE_REPROOF_FORWARD_FORBIDDEN/)
  assert.match(workflow, /git merge-base --is-ancestor "\$TARGET_COMMIT" origin\/main/)
  const reproofSection = stepSection('Validate state reproof target')
  assert.doesNotMatch(reproofSection, /gh run download|\/artifacts|release-record\.json/)
  const disabledJob = jobSection('deploy-disabled')
  const diagnosticJob = jobSection('deploy-diagnostic')
  assert.match(disabledJob, /environment: Production/)
  assert.match(diagnosticJob, /environment: Production/)
  assert.match(disabledJob, /actions: read/)
  assert.match(diagnosticJob, /actions: read/)
  assert.doesNotMatch(disabledJob, /secrets\.KINVEST_IFIND_REFRESH_TOKEN/)
  assert.match(diagnosticJob, /secrets\.KINVEST_IFIND_REFRESH_TOKEN/)
  assert.match(disabledJob, /if:.*inputs\.ifind_mode.*disabled/)
  assert.match(diagnosticJob, /if:.*inputs\.ifind_mode.*diagnostic/)
  for (const [name, section] of [['disabled', disabledJob], ['diagnostic', diagnosticJob]]) {
    const gate = section.indexOf(`Check ${name} Production gate identity after approval`)
    const checkout = section.indexOf('Check out trusted deployment control plane')
    const revalidate = section.indexOf('Revalidate full release provenance after approval')
    const firstSecret = section.indexOf('secrets.')
    assert.ok(gate >= 0 && checkout > gate && revalidate > checkout, `${name} trust order`)
    assert.ok(firstSecret > revalidate, `${name} secrets must follow full revalidation`)
    for (const evidence of ['run_attempt', 'conclusion', '/artifacts', 'gh run download', 'release-record.json']) {
      assert.match(section.slice(revalidate), new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} ${evidence}`)
    }
  }
  assert.doesNotMatch(workflow, /^ {2}deploy:$/m)

  const provenanceScripts = ['deploy-disabled', 'deploy-diagnostic'].map((job) =>
    jobStepScript(job, 'Revalidate full release provenance after approval'))
  /** @type {Array<[string, (state: ReturnType<typeof provenanceState>) => void]>} */
  const mismatchCases = [
    ['run id', (state) => { state.validatedRunId = '124' }],
    ['expired artifact', (state) => { state.artifacts.artifacts[0].expired = true }],
    ['run attempt', (state) => { state.run.run_attempt = 3 }],
    ['attempt', (state) => { state.record.verification_run_attempt = 3 }],
    ['conclusion', (state) => { state.run.conclusion = 'failure' }],
    ['artifact identity', (state) => { state.artifacts.artifacts[0].name = 'wrong-artifact' }],
    ['release record', (state) => { delete state.record.created_at }],
    ['commit', (state) => { state.record.commit_sha = 'c'.repeat(40) }],
    ['digest', (state) => {
      state.record.source_digest = `sha256:${'d'.repeat(64)}`
      state.record.ghcr_digest = state.record.source_digest
    }]
  ]
  for (const script of provenanceScripts) {
    assert.doesNotMatch(script, /\|\|\s*true/)
    const accepted = runProvenanceScript(script)
    assert.equal(accepted.result.status, 0, accepted.result.stderr)
    assert.equal(accepted.reached, true)
    for (const [name, mutate] of mismatchCases) {
      const rejected = runProvenanceScript(script, mutate)
      assert.notEqual(rejected.result.status, 0, `${name} mismatch reached protected steps: ${JSON.stringify({ releaseRunId: rejected.state.releaseRunId, validatedRunId: rejected.state.validatedRunId })}`)
      assert.equal(rejected.reached, false, `${name} mismatch touched Secret/SSH sentinel`)
    }
  }
  const conclusionCheck = `[[ "$(jq -r '.conclusion' <<<"$run_json")" == "success" ]]`
  const weakened = provenanceScripts[0].replace(conclusionCheck, ': # intentionally removed conclusion check')
  assert.notEqual(weakened, provenanceScripts[0])
  const bypassed = runProvenanceScript(weakened, (state) => { state.run.conclusion = 'failure' })
  assert.equal(bypassed.result.status, 0, bypassed.result.stderr)
  assert.equal(bypassed.reached, true, 'executable fixture must expose a commented-out trust check')

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v5-workflow-'))
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
    const ifind = 'synthetic-ifind-refresh-token-1234567890'
    const diagnosticStep = 'Deploy diagnostic payload with deploy-v5 stdin'
    const disabledStep = 'Deploy disabled payload with deploy-v5 stdin'
    assert.doesNotMatch(stepSection(disabledStep), /secrets\.KINVEST_IFIND_REFRESH_TOKEN/)
    assert.match(stepSection(diagnosticStep), /secrets\.KINVEST_IFIND_REFRESH_TOKEN/)
    assert.match(stepScript(disabledStep), /set \+x/)
    assert.match(stepScript(diagnosticStep), /set \+x/)

    const result = spawnSync('bash', ['-c', stepScript(diagnosticStep)], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_MATERIAL: secret.admin,
        HMAC_MATERIAL: secret.hmac,
        KINVEST_DEPLOY_GATE_USER: 'lighthouse',
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334',
        DEPLOY_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        RELEASE_SCHEMA: '2', VERIFICATION_RUN_ID: '123', INTENT: 'FORWARD',
        PROVENANCE_MODE: 'artifact-v2',
        TMPFS_BOOTSTRAP_ENABLED: 'true',
        TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
        TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        KINVEST_IFIND_DIAGNOSTIC_MODE: 'diagnostic',
        TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID: 'v20260826-001',
        IFIND_MATERIAL: ifind,
        ARGS_FILE: argsFile, ENV_FILE: envFile, PAYLOAD_FILE: payloadFile,
        GITHUB_ENV: githubEnv,
        HOME: fixture, PATH: `${bin}:${process.env.PATH}`
      }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const lines = fs.readFileSync(payloadFile, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 16)
    assert.equal(lines[0], 'KINVEST_DEPLOY_V5')
    assert.equal(lines[1], 'FORWARD')
    assert.equal(lines[2], `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`)
    assert.equal(lines[3], 'b'.repeat(40))
    assert.equal(lines[4], '{"artifactSource":"ghcr-public","provenanceMode":"artifact-v2","releaseRecordSchemaVersion":2,"verificationRunId":"123"}')
    assert.equal(lines[5], '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}')
    assert.equal(lines[6], 'github-tmpfs-v1')
    assert.equal(lines[7], 'v20260813-001')
    assert.equal(lines[8], 'v20260813-002')
    assert.equal(lines[9] === secret.admin, true)
    assert.equal(lines[10] === secret.hmac, true)
    assert.equal(lines[11], '{"accessControlMode":"device-approval","schemaVersion":1}')
    assert.equal(lines[12], 'diagnostic')
    assert.equal(lines[13], 'v20260826-001')
    assert.equal(lines[14], ifind)
    assert.equal(lines[15], 'EOF')
    const args = fs.readFileSync(argsFile, 'utf8')
    const environment = fs.readFileSync(envFile, 'utf8')
    assert.match(args, /deploy-v5/)
    for (const material of [secret.admin, secret.hmac, ifind]) {
      assert.equal(args.includes(material), false)
      assert.equal(environment.includes(material), false)
      assert.equal((result.stdout + result.stderr).includes(material), false)
    }
    assert.doesNotMatch(environment, /^(ADMIN_MATERIAL|HMAC_MATERIAL|IFIND_MATERIAL)=/m)
    assert.equal(fs.readFileSync(githubEnv, 'utf8'), '')

    const disabledPayload = path.join(fixture, 'disabled-payload')
    const disabledResult = spawnSync('bash', ['-c', stepScript(disabledStep)], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_MATERIAL: secret.admin, HMAC_MATERIAL: secret.hmac,
        KINVEST_DEPLOY_GATE_USER: 'lighthouse',
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334',
        DEPLOY_SHA: 'b'.repeat(40), IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        RELEASE_SCHEMA: '2', VERIFICATION_RUN_ID: '123', INTENT: 'FORWARD',
        PROVENANCE_MODE: 'artifact-v2',
        TMPFS_BOOTSTRAP_ENABLED: 'true',
        TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260813-001',
        TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID: 'v20260813-002',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled',
        ARGS_FILE: argsFile, ENV_FILE: envFile, PAYLOAD_FILE: disabledPayload,
        HOME: fixture, PATH: `${bin}:${process.env.PATH}`
      }
    })
    assert.equal(disabledResult.status, 0, disabledResult.stderr)
    const disabledLines = fs.readFileSync(disabledPayload, 'utf8').trimEnd().split('\n')
    assert.equal(disabledLines.length, 16)
    assert.deepEqual(disabledLines.slice(12, 15), ['disabled', '', ''])

    const mismatch = spawnSync('bash', ['-c', stepScript('Check diagnostic Production gate identity after approval')], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        KINVEST_DEPLOY_GATE_USER: '',
        DEPLOY_HOST: 'example.invalid', DEPLOY_PORT: '4334',
        DEPLOY_V5_ENABLED: 'true',
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        KINVEST_IFIND_DIAGNOSTIC_MODE: 'diagnostic',
        REQUESTED_IFIND_MODE: 'diagnostic',
        WORKFLOW_REF: 'refs/heads/main'
      }
    })
    assert.notEqual(mismatch.status, 0)
    assert.equal(mismatch.stderr, 'KINVEST_DEPLOY_GATE_IDENTITY_MISMATCH\n')

    assert.doesNotMatch(workflow, /secrets\.SSH_USER/)
    assert.match(workflow, /KINVEST_DEPLOY_GATE_USER: \$\{\{ vars\.KINVEST_DEPLOY_GATE_USER \}\}/)
    assert.doesNotMatch(workflow, /DEPLOY_USER: \$\{\{ vars\.DEPLOY_USER \}\}/)
    assert.match(workflow, /environment: Production/)
    assert.match(workflow, /DEPLOY_V5_ENABLED: \$\{\{ vars\.DEPLOY_V5_ENABLED \}\}/)
    assert.match(workflow, /KINVEST_IFIND_REFRESH_TOKEN/)
    assert.match(workflow, /TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID/)
    assert.doesNotMatch(workflow, /pull_request_target|permissions:\s*write-all/)
    assert.doesNotMatch(workflow, /\$GITHUB_ENV/)
    assert.match(workflow, /^on:\n {2}workflow_dispatch:/m)
    assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m)
    for (const use of workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)) {
      assert.match(use[1], /^[0-9a-f]{40}$/)
    }
    const validateJob = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  deploy-disabled:'))
    assert.doesNotMatch(validateJob, /environment:|secrets\./)

    const prWorkflow = fs.readFileSync(path.join(rootDir, '.github/workflows/deploy.yml'), 'utf8')
    const securityJob = prWorkflow.slice(prWorkflow.indexOf('  security:'), prWorkflow.indexOf('  container-build:'))
    assert.match(securityJob, /permissions:\n {6}contents: read/)
    assert.doesNotMatch(securityJob, /environment:|secrets\./)
    assert.match(securityJob, /name: Verify isolated deploy-v5 sudoers semantics/)
    assert.match(securityJob, /KINVEST_RUN_SUDOERS_INTEGRATION: ['"]1['"]/)
    assert.match(securityJob, /runSudoersIntegrationOnly/)
    const containerBuild = prWorkflow.slice(prWorkflow.indexOf('  container-build:'), prWorkflow.indexOf('  publish:'))
    assert.doesNotMatch(containerBuild, /environment: Production|secrets\./)
    assert.match(containerBuild, /push: false/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }

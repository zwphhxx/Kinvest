const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const contractPath = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')

/**
 * @param {string} command
 * @param {unknown} input
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runContract(command, input = '', args = [], env = {}) {
  return spawnSync('python3', [contractPath, command, ...args], {
    encoding: 'utf8',
    input: typeof input === 'string' ? input : (JSON.stringify(input) ?? ''),
    env: { ...process.env, KINVEST_DEPLOY_PROTOCOL: '4', ...env },
    maxBuffer: 128 * 1024
  })
}

function materials() {
  const admin = JSON.stringify({
    digest: Buffer.alloc(32, 1).toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: Buffer.alloc(16, 2).toString('base64url')
  })
  return {
    admin: Buffer.from(admin).toString('base64url'),
    hmac: Buffer.alloc(32, 3).toString('base64url')
  }
}

function payload(overrides = {}) {
  const secret = materials()
  const value = {
    magic: 'KINVEST_DEPLOY_V4',
    intent: 'FORWARD',
    digest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    commit: 'b'.repeat(40),
    provenance: '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    registry: '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    provider: 'github-tmpfs-v1',
    adminVersion: 'v20260813-001',
    hmacVersion: 'v20260813-002',
    admin: secret.admin,
    hmac: secret.hmac,
    policy: '{"accessControlMode":"device-approval","schemaVersion":1}',
    end: 'EOF',
    ...overrides
  }
  return [
    value.magic,
    value.intent,
    value.digest,
    value.commit,
    value.provenance,
    value.registry,
    value.provider,
    value.adminVersion,
    value.hmacVersion,
    value.admin,
    value.hmac,
    value.policy,
    value.end
  ].join('\n') + '\n'
}

function state(overrides = {}) {
  return {
    protocolVersion: 5,
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    runtimeImageId: `sha256:${'b'.repeat(64)}`,
    commit: 'c'.repeat(40),
    schemaVersion: 0,
    imageSchemaMin: 0,
    imageSchemaMax: 0,
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: {
      adminPasswordVerifier: 'v20260813-001',
      deviceTokenHmac: { accepted: ['v20260813-002'], active: 'v20260813-002' }
    },
    secretBundleId: 'd'.repeat(32),
    secretMaterialFingerprints: {
      adminPasswordVerifier: 'e'.repeat(64),
      deviceTokenHmac: 'f'.repeat(64)
    },
    accessControlMode: 'device-approval',
    imageAccessControlContract: 1,
    trustedProxyAddresses: ['172.19.0.2'],
    trustedProxyConfigChecksum: '1'.repeat(64),
    releaseRecordSchemaVersion: 2,
    verificationRunId: '123',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-13T00:00:00Z',
    ...overrides
  }
}

function request(overrides = {}) {
  const current = state()
  return {
    imageDigest: current.imageDigest,
    commit: current.commit,
    secretProviderMode: current.secretProviderMode,
    secretVersionIds: current.secretVersionIds,
    secretMaterialFingerprints: current.secretMaterialFingerprints,
    accessControlMode: current.accessControlMode,
    ...overrides
  }
}

function assertV4Failure(result, code = /^DEPLOY_V4_[A-Z0-9_]+\n$/) {
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, code)
  const secret = materials()
  assert.equal(result.stderr.includes(secret.admin), false)
  assert.equal(result.stderr.includes(secret.hmac), false)
}

async function run() {
  const valid = runContract('validate-payload', payload())
  assert.equal(valid.status, 0, valid.stderr)
  const validated = JSON.parse(valid.stdout)
  assert.equal(validated.accessControlMode, 'device-approval')
  assert.deepEqual(validated.runtimePolicy, { accessControlMode: 'device-approval', schemaVersion: 1 })

  for (const invalid of [
    payload().replace(/\nEOF\n$/, '\n'),
    payload() + 'extra\n',
    payload().replace(/\n/g, '\r\n'),
    payload({ policy: '{"schemaVersion":1,"accessControlMode":"device-approval"}' }),
    payload({ policy: '{"accessControlMode":"public","schemaVersion":1}' }),
    payload({ policy: '{"accessControlMode":"disabled","schemaVersion":1,"x":0}' }),
    payload({ policy: 'not-json' })
  ]) assertV4Failure(runContract('validate-payload', invalid))

  const disabled = runContract('validate-payload', payload({
    provider: 'disabled', adminVersion: '', hmacVersion: '', admin: '', hmac: '',
    policy: '{"accessControlMode":"disabled","schemaVersion":1}'
  }))
  assert.equal(disabled.status, 0, disabled.stderr)

  const canonical = runContract('canonical-state', state())
  assert.equal(canonical.status, 0, canonical.stderr)
  assert.deepEqual(canonical.stdout.trimEnd().split('\n').map((line) => line.split('=', 1)[0]), [
    'protocolVersion', 'imageDigest', 'runtimeImageId', 'commit', 'schemaVersion',
    'imageSchemaMin', 'imageSchemaMax', 'secretProviderMode', 'secretVersionIds',
    'secretBundleId', 'secretMaterialFingerprints', 'accessControlMode',
    'imageAccessControlContract', 'trustedProxyAddresses', 'trustedProxyConfigChecksum',
    'releaseRecordSchemaVersion', 'verificationRunId', 'artifactSource',
    'databaseBackupPath', 'databaseBackupChecksum', 'deployedAt'
  ])
  assert.equal(canonical.stdout.includes('trustedProxyAddresses=["172.19.0.2"]'), true)

  for (const invalid of [
    { ...state(), extra: true },
    state({ imageAccessControlContract: 2 }),
    state({ trustedProxyAddresses: ['172.19.0.2', '172.19.0.2'] }),
    state({ trustedProxyAddresses: ['172.19.0.0/16'] }),
    state({ trustedProxyAddresses: [], accessControlMode: 'device-approval' }),
    state({ trustedProxyConfigChecksum: '', accessControlMode: 'device-approval' })
  ]) assertV4Failure(runContract('canonical-state', invalid), /^DEPLOY_V4_STATE_INVALID\n$/)

  const legacyV4 = { ...state({
    protocolVersion: 4,
    accessControlMode: undefined,
    imageAccessControlContract: undefined,
    trustedProxyAddresses: undefined,
    trustedProxyConfigChecksum: undefined
  }) }
  for (const key of ['accessControlMode', 'imageAccessControlContract', 'trustedProxyAddresses', 'trustedProxyConfigChecksum']) delete legacyV4[key]
  const legacyText = Object.entries(legacyV4).map(([key, value]) =>
    `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`
  ).join('\n') + '\n'
  const migrated = runContract('parse-state', legacyText)
  assert.equal(migrated.status, 0, migrated.stderr)
  assert.deepEqual(JSON.parse(migrated.stdout), {
    ...legacyV4,
    protocolVersion: 5,
    accessControlMode: 'disabled',
    imageAccessControlContract: 0,
    trustedProxyAddresses: [],
    trustedProxyConfigChecksum: ''
  })

  const downgrade = runContract('resolve-intent', {
    intent: 'FORWARD', request: request({ accessControlMode: 'disabled' }), current: state(), previous: null
  })
  assertV4Failure(downgrade, /^ACCESS_CONTROL_DOWNGRADE_FORBIDDEN\n$/)

  const previousDisabled = state({
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'2'.repeat(64)}`,
    runtimeImageId: `sha256:${'3'.repeat(64)}`,
    commit: '4'.repeat(40),
    accessControlMode: 'disabled', imageAccessControlContract: 0,
    trustedProxyAddresses: [], trustedProxyConfigChecksum: ''
  })
  const rollback = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({ imageDigest: previousDisabled.imageDigest, commit: previousDisabled.commit }),
    current: state(),
    previous: previousDisabled
  })
  assert.equal(rollback.status, 0, rollback.stderr)
  const rollbackPlan = JSON.parse(rollback.stdout)
  assert.equal(rollbackPlan.target.accessControlMode, 'device-approval')
  assert.deepEqual(rollbackPlan.target.trustedProxyAddresses, ['172.19.0.2'])
  assert.deepEqual(rollbackPlan.secretVersionIds, state().secretVersionIds)

  const rollbackSecretReplacement = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({
      imageDigest: previousDisabled.imageDigest,
      commit: previousDisabled.commit,
      secretVersionIds: {
        adminPasswordVerifier: 'v20260813-010',
        deviceTokenHmac: { accepted: ['v20260813-011'], active: 'v20260813-011' }
      },
      secretMaterialFingerprints: {
        adminPasswordVerifier: '5'.repeat(64),
        deviceTokenHmac: '6'.repeat(64)
      }
    }),
    current: state(),
    previous: previousDisabled
  })
  assertV4Failure(rollbackSecretReplacement, /^ROLLBACK_SECURITY_STATE_MISMATCH\n$/)

  const rollbackPolicyReplacement = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({
      imageDigest: previousDisabled.imageDigest,
      commit: previousDisabled.commit,
      accessControlMode: 'disabled'
    }),
    current: state(),
    previous: previousDisabled
  })
  assertV4Failure(rollbackPolicyReplacement, /^ROLLBACK_SECURITY_STATE_MISMATCH\n$/)

  for (const mismatch of [
    { accessControlMode: 'disabled' },
    { imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}` },
    { commit: '9'.repeat(40) }
  ]) {
    const restore = runContract('resolve-intent', {
      intent: 'RESTORE', request: request(mismatch), current: state(), previous: null
    })
    assertV4Failure(restore, /^RESTORE_STATE_MISMATCH\n$/)
  }

  const recoverySecurityMismatch = runContract('make-recovery-state', {
    original: state(),
    approved: {
      secretProviderMode: 'disabled',
      secretVersionIds: {},
      secretMaterialFingerprints: {},
      secretBundleId: 'none',
      accessControlMode: 'disabled',
      imageAccessControlContract: 1,
      trustedProxyAddresses: [],
      trustedProxyConfigChecksum: ''
    }
  })
  assertV4Failure(recoverySecurityMismatch, /^RECOVERY_SECURITY_STATE_MISMATCH\n$/)

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-access-network-'))
  try {
    const config = path.join(fixture, 'access-control-network.conf')
    fs.writeFileSync(config, 'KINVEST_WEB_NETWORK=web\nKINVEST_NGINX_CONTAINER=nginx\nKINVEST_NGINX_IPV4=172.19.0.2\n', { mode: 0o600 })
    const network = runContract('validate-network-config', '', [config], {
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid())
    })
    assert.equal(network.status, 0, network.stderr)
    assert.deepEqual(JSON.parse(network.stdout), {
      checksum: require('node:crypto').createHash('sha256').update(fs.readFileSync(config)).digest('hex'),
      container: 'nginx',
      ip: '172.19.0.2',
      network: 'web',
      trustedProxyAddresses: ['172.19.0.2']
    })
    for (const mode of [0o644, 0o640, 0o400]) {
      fs.chmodSync(config, mode)
      assertV4Failure(runContract('validate-network-config', '', [config], {
        KINVEST_V4_TEST_ROOT_UID: String(process.getuid())
      }), /^DEPLOY_V4_PROXY_CONFIG_INVALID\n$/)
    }
    fs.chmodSync(config, 0o600)
    fs.appendFileSync(config, 'EXTRA=value\n')
    assertV4Failure(runContract('validate-network-config', '', [config], {
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid())
    }), /^DEPLOY_V4_PROXY_CONFIG_INVALID\n$/)
    fs.writeFileSync(config, 'KINVEST_WEB_NETWORK=web\nKINVEST_NGINX_CONTAINER=nginx\nKINVEST_NGINX_IPV4=172.19.0.0/16\n')
    assertV4Failure(runContract('validate-network-config', '', [config], {
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid())
    }), /^DEPLOY_V4_PROXY_CONFIG_INVALID\n$/)
    const alias = path.join(fixture, 'alias.conf')
    fs.symlinkSync(config, alias)
    assertV4Failure(runContract('validate-network-config', '', [alias], {
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid())
    }), /^DEPLOY_V4_PROXY_CONFIG_INVALID\n$/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }

  const deployer = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-kinvest-v3.sh'), 'utf8')
  const wrapper = fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-ssh-command-v3'), 'utf8')
  const compose = fs.readFileSync(path.join(rootDir, 'deploy/server/docker-compose-v3.yml'), 'utf8')
  assert.match(wrapper, /deploy-v4\)[\s\S]*deploy-kinvest-v4/)
  assert.match(deployer, /protocolVersion=5[\s\S]*DEPLOY_V3_PROTOCOL_RETIRED/)
  assert.match(deployer, /io\.kinvest\.access-control\.contract/)
  assert.match(deployer, /KINVEST_ACCESS_CONTROL_MODE/)
  assert.match(deployer, /KINVEST_TRUSTED_PROXY_ADDRESSES/)
  assert.match(deployer, /server\/access-preflight\.js/)
  assert.match(deployer, /current_bundle_path="\$BUNDLE_ROOT\/\$current_bundle_id"/)
  assert.match(deployer, /run_secret_preflight "\$recovery_image_id" "\$current_provider" "\$current_versions" "\$current_bundle_path"/)
  assert.match(deployer, /recovery_bundle="\$current_bundle_path"/)
  assert.match(deployer, /\$intent" == RESTORE[\s\S]*schema_before" != "\$current_schema_version"[\s\S]*RESTORE_SCHEMA_MISMATCH/)
  assert.match(deployer, /sqlite3[\s\S]*\.backup|source\.backup\(destination\)/)
  assert.match(deployer, /--network none/)
  assert.match(deployer, /\/api\/watchlist/)
  assert.match(deployer, /\/api\/auth\/status/)
  assert.ok(deployer.indexOf('run_access_preflight') < deployer.indexOf('create_database_backup'))
  assert.match(compose, /KINVEST_ACCESS_CONTROL_MODE=\$\{KINVEST_ACCESS_CONTROL_MODE:\?set access control mode\}/)
  assert.match(compose, /KINVEST_TRUSTED_PROXY_ADDRESSES=\$\{KINVEST_TRUSTED_PROXY_ADDRESSES:\?set canonical trusted proxy JSON\}/)

  const workflowPath = path.join(rootDir, '.github/workflows/deploy-production-v4-manual.yml')
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /environment: Production/)
  assert.match(workflow, /DEPLOY_V4_ENABLED/)
  assert.doesNotMatch(workflow, /DEPLOY_V3_ENABLED/)
  assert.match(workflow, /KINVEST_ACCESS_CONTROL_MODE: \$\{\{ vars\.KINVEST_ACCESS_CONTROL_MODE \}\}/)
  assert.match(workflow, /KINVEST_DEPLOY_V4/)
  assert.match(workflow, /'deploy-v4'/)
  assert.doesNotMatch(workflow, /GITHUB_ENV|set -x/)
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) assert.match(match[1], /@[0-9a-f]{40}$/)

  for (const file of [
    'deploy/server/deploy-kinvest-v4',
    'deploy/server/install-deploy-v4.sh',
    'deploy/server/access-control-network.conf.example',
    'deploy/server/docker-compose.nginx-fixed-ip.yml',
    'docs/operations/deploy-v4-access-control-runbook.md'
  ]) assert.equal(fs.existsSync(path.join(rootDir, file)), true, `${file} missing`)

  const installer = fs.readFileSync(path.join(rootDir, 'deploy/server/install-deploy-v4.sh'), 'utf8')
  assert.match(installer, /EXPECTED_ASSET_HASHES/)
  assert.match(installer, /deploy-kinvest-v4/)
  assert.match(installer, /access-control-network\.conf\.example/)
  assert.doesNotMatch(installer, /systemctl restart|docker compose up|DEPLOY_V4_ENABLED/)
}

module.exports = { run }

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const helperPath = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')

function state(overrides = {}) {
  return {
    protocolVersion: 4,
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
    releaseRecordSchemaVersion: 2,
    verificationRunId: '123',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-13T00:00:00Z',
    ...overrides
  }
}

function helper(command, input) {
  return spawnSync('python3', [helperPath, command], {
    encoding: 'utf8',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    maxBuffer: 64 * 1024
  })
}

function request(overrides = {}) {
  return {
    imageDigest: state().imageDigest,
    commit: state().commit,
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: state().secretVersionIds,
    secretMaterialFingerprints: state().secretMaterialFingerprints,
    ...overrides
  }
}

async function run() {
  const valid = helper('canonical-state', state())
  assert.equal(valid.status, 0, valid.stderr)
  const lines = valid.stdout.trimEnd().split('\n')
  assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf('='))), [
    'protocolVersion',
    'imageDigest',
    'runtimeImageId',
    'commit',
    'schemaVersion',
    'imageSchemaMin',
    'imageSchemaMax',
    'secretProviderMode',
    'secretVersionIds',
    'secretBundleId',
    'secretMaterialFingerprints',
    'releaseRecordSchemaVersion',
    'verificationRunId',
    'artifactSource',
    'databaseBackupPath',
    'databaseBackupChecksum',
    'deployedAt'
  ])
  assert.equal(valid.stdout.includes('material'), false)

  const reuseConflict = helper('check-version-reuse', {
    current: state(),
    candidate: {
      secretProviderMode: 'github-tmpfs-v1',
      secretVersionIds: state().secretVersionIds,
      secretMaterialFingerprints: {
        ...state().secretMaterialFingerprints,
        deviceTokenHmac: '0'.repeat(64)
      }
    }
  })
  assert.notEqual(reuseConflict.status, 0)
  assert.equal(reuseConflict.stderr, 'SECRET_VERSION_REUSE_CONFLICT\n')

  const rollback = helper('resolve-intent', {
    intent: 'ROLLBACK',
    request: request(),
    current: state({ imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}` }),
    previous: state()
  })
  assert.equal(rollback.status, 0, rollback.stderr)
  const rollbackPlan = JSON.parse(rollback.stdout)
  assert.equal(rollbackPlan.target.runtimeImageId, state().runtimeImageId)
  assert.deepEqual(rollbackPlan.secretVersionIds, state().secretVersionIds)
  assert.deepEqual(rollbackPlan.operations, ['preflight', 'backup', 'compose', 'health', 'state'])

  const restore = helper('resolve-intent', {
    intent: 'RESTORE',
    request: request(),
    current: state(),
    previous: null
  })
  assert.equal(restore.status, 0, restore.stderr)
  const restorePlan = JSON.parse(restore.stdout)
  assert.deepEqual(restorePlan.operations, ['preflight', 'compose', 'health', 'state'])
  assert.equal(restorePlan.operations.includes('pull'), false)
  assert.equal(restorePlan.operations.includes('backup'), false)
  assert.equal(restorePlan.operations.includes('migrate'), false)
  assert.deepEqual(restorePlan.target, state())

  const restoredBundleId = '1'.repeat(32)
  const restoredState = helper('make-restore-state', {
    original: state({
      databaseBackupPath: '/root/docker/kinvest/backups/restore-source.sqlite3',
      databaseBackupChecksum: '2'.repeat(64)
    }),
    approved: {
      secretProviderMode: state().secretProviderMode,
      secretVersionIds: state().secretVersionIds,
      secretMaterialFingerprints: state().secretMaterialFingerprints,
      secretBundleId: restoredBundleId
    }
  })
  assert.equal(restoredState.status, 0, restoredState.stderr)
  assert.deepEqual(JSON.parse(restoredState.stdout), {
    ...state({
      databaseBackupPath: '/root/docker/kinvest/backups/restore-source.sqlite3',
      databaseBackupChecksum: '2'.repeat(64)
    }),
    secretBundleId: restoredBundleId
  })

  const restoreMaterialMismatch = helper('make-restore-state', {
    original: state(),
    approved: {
      secretProviderMode: state().secretProviderMode,
      secretVersionIds: state().secretVersionIds,
      secretMaterialFingerprints: {
        ...state().secretMaterialFingerprints,
        deviceTokenHmac: '0'.repeat(64)
      },
      secretBundleId: restoredBundleId
    }
  })
  assert.notEqual(restoreMaterialMismatch.status, 0)
  assert.equal(restoreMaterialMismatch.stderr, 'RESTORE_STATE_MISMATCH\n')

  const approvedRecovery = {
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: {
      adminPasswordVerifier: 'v20260813-010',
      deviceTokenHmac: { accepted: ['v20260813-011'], active: 'v20260813-011' }
    },
    secretMaterialFingerprints: {
      adminPasswordVerifier: '3'.repeat(64),
      deviceTokenHmac: '4'.repeat(64)
    },
    secretBundleId: '5'.repeat(32)
  }
  const recoveryState = helper('make-recovery-state', {
    original: state({
      databaseBackupPath: '/root/docker/kinvest/backups/recovery-source.sqlite3',
      databaseBackupChecksum: '6'.repeat(64)
    }),
    approved: approvedRecovery
  })
  assert.equal(recoveryState.status, 0, recoveryState.stderr)
  assert.deepEqual(JSON.parse(recoveryState.stdout), {
    ...state({
      databaseBackupPath: '/root/docker/kinvest/backups/recovery-source.sqlite3',
      databaseBackupChecksum: '6'.repeat(64)
    }),
    ...approvedRecovery
  })

  for (const mismatch of [
    { imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}` },
    { commit: '9'.repeat(40) },
    { secretVersionIds: {
      adminPasswordVerifier: 'v20260813-009',
      deviceTokenHmac: { accepted: ['v20260813-002'], active: 'v20260813-002' }
    } }
  ]) {
    const failed = helper('resolve-intent', {
      intent: 'RESTORE',
      request: {
        ...request(),
        ...mismatch
      },
      current: state(),
      previous: null
    })
    assert.notEqual(failed.status, 0)
    assert.equal(failed.stderr, 'RESTORE_STATE_MISMATCH\n')
  }

  const disabledState = helper('canonical-state', state({
    secretProviderMode: 'disabled',
    secretVersionIds: {},
    secretBundleId: 'none',
    secretMaterialFingerprints: {}
  }))
  assert.equal(disabledState.status, 0, disabledState.stderr)

  for (const intent of ['FORWARD', 'ROLLBACK', 'RESTORE']) {
    const downgrade = helper('resolve-intent', {
      intent,
      request: request({
        secretProviderMode: 'disabled',
        secretVersionIds: {},
        secretMaterialFingerprints: {}
      }),
      current: state(),
      previous: intent === 'ROLLBACK' ? state() : null
    })
    assert.notEqual(downgrade.status, 0)
    assert.equal(downgrade.stderr, 'SECRET_PROVIDER_DOWNGRADE_FORBIDDEN\n')
  }

  const v3State = [
    'protocolVersion=3',
    `imageDigest=${state().imageDigest}`,
    `runtimeImageId=${state().runtimeImageId}`,
    `commit=${state().commit}`,
    'schemaVersion=0',
    'imageSchemaMin=0',
    'imageSchemaMax=0',
    'secretVersionIds={}',
    'releaseRecordSchemaVersion=2',
    'verificationRunId=123',
    'artifactSource=ghcr-public',
    'databaseBackupPath=none',
    'databaseBackupChecksum=none',
    'deployedAt=2026-08-13T00:00:00Z'
  ].join('\n') + '\n'
  const migrated = helper('parse-state', v3State)
  assert.equal(migrated.status, 0, migrated.stderr)
  assert.equal(JSON.parse(migrated.stdout).protocolVersion, 4)
  assert.equal(JSON.parse(migrated.stdout).secretProviderMode, 'disabled')

  const helperSource = fs.readFileSync(helperPath, 'utf8')
  assert.doesNotMatch(helperSource, /print\([^\n]*(admin_material|hmac_material)/i)

  const atomicDestination = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kinvest-v3-state-')), 'current.state')
  try {
    const atomic = spawnSync('python3', [helperPath, 'atomic-state', atomicDestination], {
      encoding: 'utf8',
      input: JSON.stringify(state())
    })
    assert.equal(atomic.status, 0, atomic.stderr)
    assert.equal(fs.statSync(atomicDestination).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(atomicDestination, 'utf8'), valid.stdout)
    assert.equal(fs.readdirSync(path.dirname(atomicDestination)).length, 1)

    const marker = path.join(path.dirname(atomicDestination), 'fail-once.marker')
    const failedAtomic = spawnSync('python3', [helperPath, 'atomic-state', atomicDestination], {
      encoding: 'utf8',
      input: JSON.stringify(state({ commit: '9'.repeat(40) })),
      env: {
        ...process.env,
        KINVEST_V3_TEST_FAIL_AFTER_REPLACE: atomicDestination,
        KINVEST_V3_TEST_FAIL_MARKER: marker
      }
    })
    assert.notEqual(failedAtomic.status, 0)
    assert.equal(failedAtomic.stderr, 'DEPLOY_V3_STATE_WRITE_FAILED\n')
    assert.equal(fs.readFileSync(atomicDestination, 'utf8'), valid.stdout)
    assert.equal(fs.statSync(atomicDestination).mode & 0o777, 0o600)
    assert.equal(
      fs.readdirSync(path.dirname(atomicDestination)).some((name) => name.includes('recovery-required')),
      false
    )

    const originalBytes = Buffer.from(valid.stdout)
    const committedBytes = Buffer.from(helper('canonical-state', state({ commit: '8'.repeat(40) })).stdout)
    const recoveryPath = path.join(path.dirname(atomicDestination), '.current.state.recovery-required')
    const recovery = {
      destinationExisted: true,
      format: 'kinvest-atomic-recovery-v1',
      gid: process.getgid(),
      mode: 0o600,
      newSha256: require('node:crypto').createHash('sha256').update(committedBytes).digest('hex'),
      sha256: require('node:crypto').createHash('sha256').update(originalBytes).digest('hex'),
      uid: process.getuid(),
      valueBase64: originalBytes.toString('base64')
    }
    fs.writeFileSync(atomicDestination, committedBytes, { mode: 0o600 })
    fs.writeFileSync(recoveryPath, JSON.stringify(recovery) + '\n', { mode: 0o600 })
    const reconciled = spawnSync('python3', [helperPath, 'reconcile-atomic-state', atomicDestination], {
      encoding: 'utf8'
    })
    assert.equal(reconciled.status, 0, reconciled.stderr)
    assert.equal(fs.existsSync(recoveryPath), false)
    assert.equal(fs.readFileSync(atomicDestination, 'utf8'), committedBytes.toString())

    const ambiguousBytes = Buffer.from(helper('canonical-state', state({ commit: '6'.repeat(40) })).stdout)
    fs.writeFileSync(atomicDestination, ambiguousBytes, { mode: 0o600 })
    fs.writeFileSync(recoveryPath, JSON.stringify(recovery) + '\n', { mode: 0o600 })
    const ambiguous = spawnSync('python3', [helperPath, 'reconcile-atomic-state', atomicDestination], {
      encoding: 'utf8'
    })
    assert.notEqual(ambiguous.status, 0)
    assert.equal(ambiguous.stderr, 'DEPLOY_V3_ATOMIC_RECOVERY_REQUIRED\n')
    assert.equal(fs.existsSync(recoveryPath), true)
  } finally {
    fs.rmSync(path.dirname(atomicDestination), { recursive: true, force: true })
  }


  const ledgerDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kinvest-v3-ledger-'))
  const ledger = path.join(ledgerDir, 'secret-version-ledger.json')
  try {
    const candidate = request()
    const initialCheck = spawnSync('python3', [helperPath, 'ledger-check', ledger], {
      encoding: 'utf8',
      input: JSON.stringify(candidate)
    })
    assert.equal(initialCheck.status, 0, initialCheck.stderr)
    const commitLedger = spawnSync('python3', [helperPath, 'ledger-commit', ledger], {
      encoding: 'utf8',
      input: JSON.stringify(candidate)
    })
    assert.equal(commitLedger.status, 0, commitLedger.stderr)
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600)
    const history = JSON.parse(fs.readFileSync(ledger, 'utf8'))
    assert.equal(history.adminPasswordVerifier['v20260813-001'], 'e'.repeat(64))
    assert.equal(history.deviceTokenHmac['v20260813-002'], 'f'.repeat(64))

    const historicalConflict = spawnSync('python3', [helperPath, 'ledger-check', ledger], {
      encoding: 'utf8',
      input: JSON.stringify(request({
        secretVersionIds: {
          adminPasswordVerifier: 'v20260813-001',
          deviceTokenHmac: { accepted: ['v20260813-099'], active: 'v20260813-099' }
        },
        secretMaterialFingerprints: {
          adminPasswordVerifier: '0'.repeat(64),
          deviceTokenHmac: '1'.repeat(64)
        }
      }))
    })
    assert.notEqual(historicalConflict.status, 0)
    assert.equal(historicalConflict.stderr, 'SECRET_VERSION_REUSE_CONFLICT\n')
  } finally {
    fs.rmSync(ledgerDir, { recursive: true, force: true })
  }
}

module.exports = { run, state }

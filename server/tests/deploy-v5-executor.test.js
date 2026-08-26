const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { spawn, spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const executorPath = path.join(rootDir, 'deploy/server/deploy-kinvest-v5')
const runtimeHelperPath = path.join(rootDir, 'deploy/server/deploy-v5-runtime.py')
const { run: runLinuxTmpfsIntegration } = require('./deploy-v5-linux-tmpfs-integration.test')

const DIGEST = `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`
const IMAGE_ID = `sha256:${'b'.repeat(64)}`
const CURRENT_DIGEST = `ghcr.io/zwphhxx/kinvest@sha256:${'c'.repeat(64)}`
const CURRENT_ID = `sha256:${'d'.repeat(64)}`
const COMMIT = 'e'.repeat(40)
const CURRENT_COMMIT = 'f'.repeat(40)
const TOKEN = 'synthetic-ifind-refresh-token-never-log'
const ADMIN_VERSION = 'v20260826-010'
const HMAC_VERSION = 'v20260826-011'
const ADMIN_JSON = JSON.stringify({
  digest: Buffer.alloc(32, 1).toString('base64url'),
  format: 'kinvest-admin-scrypt-v1', n: 65536, p: 1, r: 8,
  salt: Buffer.alloc(16, 2).toString('base64url')
})
const ADMIN_MATERIAL = Buffer.from(ADMIN_JSON).toString('base64url')
const HMAC_MATERIAL = Buffer.alloc(32, 3).toString('base64url')
const ACCESS_FINGERPRINTS = {
  adminPasswordVerifier: crypto.createHash('sha256').update(Buffer.from(ADMIN_MATERIAL, 'base64url')).digest('hex'),
  deviceTokenHmac: crypto.createHash('sha256').update(HMAC_MATERIAL).digest('hex')
}

function loadPrivateIfindBundleLoader() {
  const providerPath = path.join(rootDir, 'server/security/ifind-tmpfs-secret-provider.js')
  const source = fs.readFileSync(providerPath, 'utf8')
  const wrapper = new vm.Script([
    '(function (exports, require, module, __filename, __dirname) {',
    source,
    'module.exports.__testOnlyLoadBundle = loadIfindTmpfsSecretsFromBundle',
    '})'
  ].join('\n'), { filename: providerPath }).runInThisContext()
  const testModule = { exports: {} }
  wrapper(testModule.exports, createRequire(providerPath), testModule, providerPath, path.dirname(providerPath))
  return testModule.exports.__testOnlyLoadBundle
}

function createProviderFsAdapter(bundlePath) {
  const descriptors = new Map()
  const mapPath = (input) => {
    if (typeof input !== 'string') return input
    const match = input.match(/^\/proc\/self\/fd\/([0-9]+)(\/.*)?$/)
    if (!match) return input
    const root = descriptors.get(Number(match[1]))
    return root && match[2] ? path.join(root, match[2].slice(1)) : (root || input)
  }
  return {
    openSync(input, flags, mode) {
      const mapped = mapPath(input)
      const fd = fs.openSync(mapped, flags, mode)
      if (mapped === bundlePath && (flags & fs.constants.O_DIRECTORY) !== 0) descriptors.set(fd, bundlePath)
      return fd
    },
    closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd) },
    fstatSync: (fd, options) => fs.fstatSync(fd, options),
    lstatSync: (input, options) => fs.lstatSync(mapPath(input), options),
    readSync: (...args) => fs.readSync(...args),
    readdirSync: (input) => fs.readdirSync(mapPath(input))
  }
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function testRuntimeDurabilityPrimitives() {
  const script = String.raw`
import hashlib, importlib.util, json, os, pathlib, stat, sys, tempfile
spec = importlib.util.spec_from_file_location('deploy_v5_runtime', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
uid, gid = os.getuid(), os.getgid()
with tempfile.TemporaryDirectory() as temporary:
    os.environ['KINVEST_V5_TEST_ALLOW_NON_TMPFS'] = '1'
    run_root = pathlib.Path(temporary) / 'run'; run_root.mkdir(mode=0o755)
    legal = run_root / 'kinvest-v5.candidates.Abc123'
    value = {'accessId': 'none', 'ifindId': 'none', 'backupTemp': 'none',
             'backupFinal': 'none', 'backupChecksum': 'none'}
    legal.write_text('{"accessId":"none","backupChecksum":"none","backupFinal":"none","backupTemp":"none","ifindId":"none"}\n'); legal.chmod(0o600)
    module.write_registry(str(legal), str(run_root), value, uid, gid)
    assert module.read_registry(str(legal), str(run_root), uid, gid) == value
    reserved = pathlib.Path(module.reserve_registry(str(run_root), uid, gid))
    assert reserved.parent == run_root and module.read_registry(str(reserved), str(run_root), uid, gid) == value
    for invalid in (run_root / '../escape', run_root / 'bad-name'):
        try: module.write_registry(str(invalid), str(run_root), value, uid, gid)
        except module.RuntimeErrorCode: pass
        else: raise AssertionError('invalid registry name accepted')
    target = run_root / 'target'; target.write_text('{}'); target.chmod(0o600)
    link = run_root / 'kinvest-v5.candidates.Link123'; link.symlink_to(target)
    try: module.write_registry(str(link), str(run_root), value, uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('symlink registry overwritten')
    try: module.read_registry(str(link), str(run_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('symlink registry accepted')
    access_root = run_root / 'kinvest-secrets'; access_root.mkdir(mode=0o700)
    ifind_root = run_root / 'kinvest-ifind-secrets'; ifind_root.mkdir(mode=0o700)
    stale = run_root / 'kinvest-v5.state-before.Stale123'; stale.write_text('stale'); stale.chmod(0o600)
    module.cleanup_stale_sources(str(run_root), uid, gid)
    assert not stale.exists()
    outside = run_root / 'outside'; outside.write_text('keep')
    stale_link = run_root / 'kinvest-v5.journal.Link123'; stale_link.symlink_to(outside)
    try: module.cleanup_stale_sources(str(run_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('stale source symlink accepted')
    assert outside.read_text() == 'keep'

    state_root = pathlib.Path(temporary) / 'state'; state_root.mkdir(mode=0o700)
    events = []
    original_write, original_fsync, original_replace = os.write, os.fsync, os.replace
    def short_write(fd, data): return original_write(fd, data[:max(1, min(3, len(data)))])
    def record_fsync(fd):
        events.append('fsync-dir' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'fsync-file')
        return original_fsync(fd)
    def record_replace(source, target, *args, **kwargs):
        events.append('replace'); return original_replace(source, target, *args, **kwargs)
    os.write, os.fsync, os.replace = short_write, record_fsync, record_replace
    try: module.durable_state_write(str(state_root), 'current.state', b'complete-state\n', uid, gid)
    finally: os.write, os.fsync, os.replace = original_write, original_fsync, original_replace
    assert (state_root / 'current.state').read_bytes() == b'complete-state\n'
    assert events.index('fsync-file') < events.index('replace') < events.index('fsync-dir')
    events.clear()
    original_unlink, original_fsync = os.unlink, os.fsync
    def record_unlink(*args, **kwargs): events.append('unlink'); return original_unlink(*args, **kwargs)
    def record_delete_fsync(fd): events.append('fsync-dir'); return original_fsync(fd)
    os.unlink, os.fsync = record_unlink, record_delete_fsync
    try: module.durable_state_delete(str(state_root), ['current.state'], uid, gid)
    finally: os.unlink, os.fsync = original_unlink, original_fsync
    assert events == ['unlink', 'fsync-dir']

    journal = {'version': 2, 'phase': 'prepared', 'intent': 'FORWARD',
               'candidateAccessId': 'none', 'candidateIfindId': 'none',
               'pendingBackupPath': 'none', 'pendingBackupChecksum': 'none'}
    journal_bytes = (json.dumps(journal, separators=(',', ':'), sort_keys=True) + '\n').encode('ascii')
    module.durable_state_write(str(state_root), 'deploy-v5.journal', journal_bytes, uid, gid)
    journal_before = (state_root / 'deploy-v5.journal').read_bytes()
    try: module.durable_state_write(str(state_root), 'deploy-v5.journal', b'{"phase":"prepared"}\n', uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('malformed journal committed')
    assert (state_root / 'deploy-v5.journal').read_bytes() == journal_before
    try: module.durable_state_write(str(state_root), 'deploy-v5.journal', (json.dumps(journal) + '\n').encode(), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('non-canonical journal committed')
    assert (state_root / 'deploy-v5.journal').read_bytes() == journal_before
    journal_source = run_root / 'kinvest-v5.journal.Enospc123'
    journal_source.write_bytes(b''); journal_source.chmod(0o600)
    original_write = os.write
    def source_enospc(fd, data): raise OSError(28, 'synthetic source ENOSPC')
    os.write = source_enospc
    try:
        try:
            module.build_journal_source(
                str(journal_source), str(run_root), str(state_root), 'prepared', 'FORWARD',
                'none', 'none', 'none', 'none', uid, gid
            )
        except (module.RuntimeErrorCode, OSError): pass
        else: raise AssertionError('ENOSPC journal source accepted')
    finally: os.write = original_write
    module.remove_runtime_source(str(journal_source), str(run_root), uid, gid)
    assert not journal_source.exists() and (state_root / 'deploy-v5.journal').read_bytes() == journal_before
    original_write = os.write
    def enospc(fd, data): raise OSError(28, 'synthetic ENOSPC')
    os.write = enospc
    try:
        try: module.durable_state_write(str(state_root), 'deploy-v5.journal', journal_bytes, uid, gid)
        except (module.RuntimeErrorCode, OSError): pass
        else: raise AssertionError('ENOSPC journal write committed')
    finally: os.write = original_write
    assert (state_root / 'deploy-v5.journal').read_bytes() == journal_before

    backup_root = pathlib.Path(temporary) / 'backups'; backup_root.mkdir(mode=0o700)
    first_temp = backup_root / '.first'; first_temp.write_bytes(b'first'); first_temp.chmod(0o600)
    second_temp = backup_root / '.second'; second_temp.write_bytes(b'second'); second_temp.chmod(0o600)
    first = module.commit_backup_no_replace(str(backup_root), str(first_temp), 'same.sqlite', uid, gid)
    first_hash = hashlib.sha256(pathlib.Path(first).read_bytes()).hexdigest()
    second = module.commit_backup_no_replace(str(backup_root), str(second_temp), 'same.sqlite', uid, gid)
    assert first != second and pathlib.Path(first).read_bytes() == b'first'
    assert hashlib.sha256(pathlib.Path(first).read_bytes()).hexdigest() == first_hash
    module.verify_backup(str(first), first_hash, str(backup_root), uid, gid)
    pathlib.Path(first).chmod(0o640)
    try: module.verify_backup(str(first), first_hash, str(backup_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('wide backup mode accepted')
    pathlib.Path(first).chmod(0o600)
    try: module.verify_backup(str(first), first_hash, str(backup_root), uid + 1, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('wrong backup owner accepted')
    backup_root.chmod(0o755)
    try: module.verify_backup(str(first), first_hash, str(backup_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('wide backup root accepted')
    backup_root.chmod(0o700)
    (state_root / 'current.state').write_text(
        f'databaseBackupPath={first}\ndatabaseBackupChecksum={first_hash}\n'
    ); (state_root / 'current.state').chmod(0o600)
    manual = backup_root / 'manual.sqlite'; manual.write_bytes(b'manual'); manual.chmod(0o600)
    historical = backup_root / 'historical.sqlite'; historical.write_bytes(b'historical'); historical.chmod(0o600)
    module.recover_orphan_backups(str(backup_root), str(state_root), uid, gid)
    assert pathlib.Path(first).exists() and manual.exists() and historical.exists()

    protected = {item.name: item.read_bytes() for item in backup_root.iterdir()}
    (state_root / 'previous.state').write_text('databaseBackupPath=missing-only\n')
    (state_root / 'previous.state').chmod(0o600)
    try: module.recover_orphan_backups(str(backup_root), str(state_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('state with missing backup checksum accepted')
    assert {item.name: item.read_bytes() for item in backup_root.iterdir()} == protected

    (state_root / 'previous.state').write_text('malformed-state-line\n')
    try: module.recover_orphan_backups(str(backup_root), str(state_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('malformed state accepted')
    assert {item.name: item.read_bytes() for item in backup_root.iterdir()} == protected

    (state_root / 'previous.state').write_text(
        f'databaseBackupPath={historical}\ndatabaseBackupChecksum={'0' * 64}\n'
    )
    try: module.recover_orphan_backups(str(backup_root), str(state_root), uid, gid)
    except module.RuntimeErrorCode: pass
    else: raise AssertionError('partially invalid backup reference accepted')
    assert {item.name: item.read_bytes() for item in backup_root.iterdir()} == protected
    (state_root / 'previous.state').unlink()

    txn_temp = backup_root / '.backup-v5.crash'; txn_temp.write_bytes(b'crash'); txn_temp.chmod(0o600)
    txn_final = backup_root / 'crash.sqlite'; os.link(txn_temp, txn_final)
    txn_hash = hashlib.sha256(b'crash').hexdigest()
    registry_value = dict(value, backupTemp=txn_temp.name, backupFinal=txn_final.name,
                          backupChecksum=txn_hash)
    module.write_registry(str(reserved), str(run_root), registry_value, uid, gid)
    module.recover_registry(str(reserved), str(run_root), str(access_root), str(ifind_root),
                            str(backup_root), str(state_root), uid, gid)
    assert not txn_temp.exists() and not txn_final.exists()

    collision_registry = pathlib.Path(module.reserve_registry(str(run_root), uid, gid))
    collision_temp = backup_root / '.backup-v5.collision'; collision_temp.write_bytes(b'new'); collision_temp.chmod(0o600)
    collision_final = backup_root / 'collision.sqlite'; collision_final.write_bytes(b'existing'); collision_final.chmod(0o600)
    collision_value = dict(value, backupTemp=collision_temp.name, backupFinal=collision_final.name,
                           backupChecksum=hashlib.sha256(b'new').hexdigest())
    module.write_registry(str(collision_registry), str(run_root), collision_value, uid, gid)
    module.recover_registry(str(collision_registry), str(run_root), str(access_root), str(ifind_root),
                            str(backup_root), str(state_root), uid, gid)
    assert not collision_temp.exists() and collision_final.read_bytes() == b'existing'
    collision_final.unlink()

    same_registry = pathlib.Path(module.reserve_registry(str(run_root), uid, gid))
    same_temp = backup_root / '.backup-v5.samecollision'; same_temp.write_bytes(b'same'); same_temp.chmod(0o600)
    same_final = backup_root / 'same-collision.sqlite'; same_final.write_bytes(b'same'); same_final.chmod(0o600)
    assert os.stat(same_temp).st_ino != os.stat(same_final).st_ino
    same_value = dict(value, backupTemp=same_temp.name, backupFinal=same_final.name,
                      backupChecksum=hashlib.sha256(b'same').hexdigest())
    module.write_registry(str(same_registry), str(run_root), same_value, uid, gid)
    module.recover_registry(str(same_registry), str(run_root), str(access_root), str(ifind_root),
                            str(backup_root), str(state_root), uid, gid)
    assert not same_temp.exists() and same_final.read_bytes() == b'same' and not same_registry.exists()

    empty = run_root / 'kinvest-v5.candidates.Empty123'
    fd = os.open(empty, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600); os.fchown(fd, uid, gid); os.close(fd)
    module.recover_registry(str(empty), str(run_root), str(access_root), str(ifind_root),
                            str(backup_root), str(state_root), uid, gid)
    assert not empty.exists()
`
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script, runtimeHelperPath], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1' }
  })
  assert.equal(result.status, 0, result.stderr)
}

function canonicalState(contract, value) {
  const result = spawnSync(process.env.PYTHON || 'python3', [contract, 'canonical-state'], {
    encoding: 'utf8', input: `${JSON.stringify(value)}\n`,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function currentState(overrides = {}) {
  return {
    protocolVersion: 6, imageDigest: CURRENT_DIGEST, runtimeImageId: CURRENT_ID,
    commit: CURRENT_COMMIT, schemaVersion: 0, imageSchemaMin: 0, imageSchemaMax: 0,
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: {
      adminPasswordVerifier: ADMIN_VERSION,
      deviceTokenHmac: { accepted: [HMAC_VERSION], active: HMAC_VERSION }
    },
    secretBundleId: '1'.repeat(32), secretMaterialFingerprints: ACCESS_FINGERPRINTS,
    accessControlMode: 'device-approval', imageAccessControlContract: 1,
    trustedProxyAddresses: ['172.19.0.2'], trustedProxyConfigChecksum: '2'.repeat(64),
    ifindDiagnosticMode: 'disabled', ifindRefreshTokenVersionId: '',
    ifindSecretBundleId: 'none', ifindSecretMaterialFingerprint: '',
    releaseRecordSchemaVersion: 2, verificationRunId: '1', artifactSource: 'ghcr-public',
    databaseBackupPath: 'none', databaseBackupChecksum: 'none',
    deployedAt: '2026-08-26T00:00:00Z',
    ...overrides
  }
}

function diagnosticPayload() {
  return [
    'KINVEST_DEPLOY_V5', 'FORWARD', DIGEST, COMMIT,
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1', ADMIN_VERSION, HMAC_VERSION, ADMIN_MATERIAL, HMAC_MATERIAL,
    '{"accessControlMode":"device-approval","schemaVersion":1}',
    'diagnostic', 'v20260826-001', TOKEN, 'EOF'
  ].join('\n') + '\n'
}

function disabledPayload() {
  return [
    'KINVEST_DEPLOY_V5', 'FORWARD', DIGEST, COMMIT,
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1', ADMIN_VERSION, HMAC_VERSION, ADMIN_MATERIAL, HMAC_MATERIAL,
    '{"accessControlMode":"device-approval","schemaVersion":1}',
    'disabled', '', '', 'EOF'
  ].join('\n') + '\n'
}

function intentPayload(intent, digest, commit, verificationRunId = '999', ifindMode = 'diagnostic') {
  return [
    'KINVEST_DEPLOY_V5', intent, digest, commit,
    `{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"${verificationRunId}"}`,
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1', ADMIN_VERSION, HMAC_VERSION, ADMIN_MATERIAL, HMAC_MATERIAL,
    '{"accessControlMode":"device-approval","schemaVersion":1}',
    ifindMode, ifindMode === 'diagnostic' ? 'v20260826-001' : '',
    ifindMode === 'diagnostic' ? TOKEN : '', 'EOF'
  ].join('\n') + '\n'
}

function makeHarness(options = {}) {
  const linuxTmpfs = process.platform === 'linux' && fs.existsSync('/dev/shm') &&
    fs.statfsSync('/dev/shm').type === 0x01021994
  const temp = fs.mkdtempSync(path.join(linuxTmpfs ? '/dev/shm' : os.tmpdir(), 'kinvest-deploy-v5-test-'))
  const root = path.join(temp, 'root')
  const runRoot = path.join(temp, 'run')
  const bin = path.join(temp, 'bin')
  const libexec = path.join(temp, 'libexec')
  const operations = path.join(temp, 'operations.log')
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  fs.mkdirSync(runRoot)
  fs.chmodSync(path.join(root, 'state'), 0o700)
  fs.chmodSync(path.join(root, 'backups'), 0o700)
  fs.chmodSync(runRoot, 0o755)
  fs.mkdirSync(bin)
  fs.mkdirSync(libexec)
  fs.copyFileSync(path.join(rootDir, 'deploy/server/docker-compose-v5.yml'), path.join(root, 'docker-compose-v5.yml'))
  const sourceContract = path.join(rootDir, 'deploy/server/deploy-v5-contract.py')
  const contract = path.join(libexec, 'deploy-v5-contract.py')
  writeExecutable(contract, fs.readFileSync(sourceContract, 'utf8')
    .replace('/root/docker/kinvest/backups', path.join(root, 'backups')))
  const runtimeHelper = path.join(libexec, 'deploy-v5-runtime.py')
  let runtimeSource = fs.readFileSync(runtimeHelperPath, 'utf8')
  if (options.materializeFault) {
    runtimeSource = runtimeSource.replace(
      `# ${options.materializeFault}`,
      `raise RuntimeError("injected materialization failure")  # ${options.materializeFault}`
    )
  }
  if (options.runtimeTransform) runtimeSource = options.runtimeTransform(runtimeSource)
  writeExecutable(runtimeHelper, runtimeSource)
  const stateValue = currentState(options.currentStateOverrides)
  if (options.currentBackup === 'valid') {
    const backupPath = path.join(root, 'backups', 'current.sqlite')
    fs.writeFileSync(backupPath, 'trusted-backup')
    fs.chmodSync(backupPath, 0o600)
    stateValue.databaseBackupPath = backupPath
    stateValue.databaseBackupChecksum = crypto.createHash('sha256').update('trusted-backup').digest('hex')
  }
  if (options.currentBackup === 'symlink') {
    const outside = path.join(temp, 'outside.sqlite')
    const backupPath = path.join(root, 'backups', 'current.sqlite')
    fs.writeFileSync(outside, 'trusted-backup')
    fs.symlinkSync(outside, backupPath)
    stateValue.databaseBackupPath = backupPath
    stateValue.databaseBackupChecksum = crypto.createHash('sha256').update('trusted-backup').digest('hex')
  }
  fs.writeFileSync(path.join(root, 'state/current.state'), canonicalState(contract, stateValue))
  fs.chmodSync(path.join(root, 'state/current.state'), 0o600)
  if (options.previousState) {
    fs.writeFileSync(path.join(root, 'state/previous.state'), canonicalState(contract, options.previousState))
    fs.chmodSync(path.join(root, 'state/previous.state'), 0o600)
  }
  spawnSync(process.env.PYTHON || 'python3', ['-c',
    'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA user_version=0"); db.commit(); db.close()',
    path.join(root, 'data/kinvest.sqlite')], { encoding: 'utf8' })

  let transformed = fs.readFileSync(executorPath, 'utf8')
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("CONTRACT='/usr/local/libexec/kinvest-deploy-v5-contract'", `CONTRACT='${contract}'`)
    .replace("RUNTIME_HELPER='/usr/local/libexec/kinvest-deploy-v5-runtime'", `RUNTIME_HELPER='${runtimeHelper}'`)
    .replace("OFFLINE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'", `OFFLINE_ATTESTATION='${libexec}/attestation'`)
    .replace("NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `NETWORK_CONFIG='${temp}/network.conf'`)
    .replace("PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'", "PUBLIC_HEALTH_URL='https://example.invalid/api/health'")
    .replace("BUNDLE_UID='0'", `BUNDLE_UID='${process.getuid()}'`)
    .replace("BUNDLE_GID='10001'", `BUNDLE_GID='${process.getgid()}'`)
    .replace("ROOT_UID='0'", `ROOT_UID='${process.getuid()}'`)
    .replace("ROOT_GID='0'", `ROOT_GID='${process.getgid()}'`)
  if (!linuxTmpfs && !options.disableTmpfsMock) {
    transformed = transformed.replace('set -euo pipefail', 'set -euo pipefail\nexport KINVEST_V5_TEST_ALLOW_NON_TMPFS=1')
  }
  if (options.signalWindow) {
    transformed = transformed.replace(
      `# ${options.signalWindow}`,
      () => `kill -${options.signalType || 'TERM'} $$  # ${options.signalWindow}`
    )
  }
  const executor = path.join(temp, 'deploy-v5')
  writeExecutable(executor, transformed)
  fs.writeFileSync(path.join(temp, 'network.conf'), 'KINVEST_CONTAINER_IP=172.18.0.2\n')
  if (options.symlinkIfindRoot) {
    const escaped = path.join(runRoot, 'escaped-ifind')
    fs.mkdirSync(escaped, { mode: 0o700 })
    fs.symlinkSync(escaped, path.join(runRoot, 'kinvest-ifind-secrets'))
  }
  if (options.seedBundles) {
    for (const [rootName, ids] of [
      ['kinvest-secrets', ['1'.repeat(32), '9'.repeat(32)]],
      ['kinvest-ifind-secrets', ['8'.repeat(32)]]
    ]) {
      const bundleRoot = path.join(runRoot, rootName)
      fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 })
      for (const id of ids) fs.mkdirSync(path.join(bundleRoot, id), { mode: 0o550 })
    }
  }

  writeExecutable(path.join(bin, 'id'), '#!/bin/sh\necho 0\n')
  writeExecutable(path.join(bin, 'findmnt'), '#!/bin/sh\necho tmpfs\n')
  writeExecutable(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'shred'), '#!/bin/sh\nfor x in "$@"; do case "$x" in -*) ;; *) rm -f -- "$x" 2>/dev/null || true;; esac; done\n')
  writeExecutable(path.join(bin, 'install'), `#!/usr/bin/env bash
if [[ "\${FAKE_FAILURE:-}" == init-install ]]; then printf '%s\n' '${TOKEN}' 'Traceback /private/secret/path' >&2; exit 91; fi
after=false
mode=0700
for value in "$@"; do
  if [[ "$value" == -m ]]; then expect_mode=true; continue; fi
  if [[ "\${expect_mode:-false}" == true ]]; then mode="$value"; expect_mode=false; continue; fi
  if [[ "$after" == true ]]; then mkdir -p "$value"; fi
  if [[ "$after" == true ]]; then chmod "$mode" "$value"; fi
  [[ "$value" == -- ]] && after=true
done
exit 0
`)
  writeExecutable(path.join(bin, 'dd'), `#!/usr/bin/env bash
if [[ "\${FAKE_FAILURE:-}" == payload-dd ]]; then printf '%s\n' '${TOKEN}' 'dd: /private/secret/path' >&2; exit 92; fi
exec /bin/dd "$@"
`)
  writeExecutable(path.join(bin, 'mktemp'), `#!/usr/bin/env bash
if [[ "\${FAKE_FAILURE:-}" == file-mktemp && "$*" == *kinvest-v5.payload.* ]]; then printf '%s\n' '${TOKEN}' 'mktemp: /private/secret/path' >&2; exit 94; fi
exec /usr/bin/mktemp "$@"
`)
  writeExecutable(path.join(bin, 'chmod'), `#!/usr/bin/env bash
if [[ "\${FAKE_FAILURE:-}" == file-chmod && "$*" == *kinvest-v5.payload.* ]]; then printf '%s\n' '${TOKEN}' 'chmod: /private/secret/path' >&2; exit 95; fi
exec /bin/chmod "$@"
`)
  writeExecutable(path.join(bin, 'mv'), `#!/usr/bin/env bash
target="\${@: -1}"
case "\${FAKE_FAILURE:-}:$target" in
  backup-mv:*backups/*.sqlite|state-mv:*attempt.state)
    printf '%s\n' '${TOKEN}' 'Traceback /private/secret/path' >&2
    exit 93
    ;;
esac
exec /bin/mv "$@"
`)
  writeExecutable(path.join(bin, 'rm'), `#!/usr/bin/env bash
marker='${path.join(temp, 'rm-failure-consumed')}'
all="$*"
if [[ ! -e "$marker" ]]; then
  case "\${FAKE_RM_FAILURE:-}:$all" in
    capture-rm:*kinvest-v5.command-*) : >"$marker"; printf '%s\n' '${TOKEN}' 'rm: /private/capture/path' >&2; exit 96 ;;
    cleanup-rm:*kinvest-v5.payload.*) : >"$marker"; printf '%s\n' '${TOKEN}' 'rm: /private/payload/path' >&2; exit 97 ;;
    journal-rm:*deploy-v5.journal*) : >"$marker"; printf '%s\n' '${TOKEN}' 'rm: /private/journal/path' >&2; exit 98 ;;
  esac
fi
exec /bin/rm "$@"
`)
  writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'timeout'), `#!/usr/bin/env bash
while [[ "$#" -gt 0 ]]; do
  case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) exec "$@" ;; esac
done
exit 127
`)
  writeExecutable(path.join(libexec, 'attestation'), `#!/bin/sh
printf 'attestation %s\n' "$*" >>'${operations}'
printf '%s\n' "\${FAKE_ATTESTATION_ID:-${IMAGE_ID}}"
`)
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker' >>'${operations}'
printf ' %q' "$@" >>'${operations}'
printf '\n' >>'${operations}'
command="$1"; shift
if [[ "$command" == image && "$1" == inspect ]]; then
  ref="$2"; format="$4"
  if [[ "$ref" == '${CURRENT_ID}' || "$ref" == '${CURRENT_DIGEST}' ]]; then id='${CURRENT_ID}'; digest='${CURRENT_DIGEST}'; else id='${IMAGE_ID}'; digest='${DIGEST}'; fi
  case "$format" in
    *RepoDigests*) printf '["%s"]\n' "$digest" ;;
    *io.kinvest.schema.min*) echo "\${FAKE_SCHEMA_MIN:-0}" ;;
    *io.kinvest.schema.max*) echo "\${FAKE_SCHEMA_MAX:-0}" ;;
    *io.kinvest.access-control.contract*) echo 1 ;;
    *io.kinvest.ifind-secret-bootstrap*) echo "\${FAKE_IFIND_LABEL:-1}" ;;
    *) echo "$id" ;;
  esac
elif [[ "$command" == run ]]; then
  [[ " $* " == *' --network none '* && " $* " == *' --read-only '* && " $* " == *' --cap-drop ALL '* && " $* " == *' --user 10001:10001 '* ]] || exit 64
  if [[ "\${FAKE_FAILURE:-}" == ifind-preflight && "$*" == *"server/ifind-secret-preflight.js"* ]]; then exit 1; fi
  if [[ "\${FAKE_BLOCK:-}" == preflight ]]; then
    { printf 'argv:'; printf ' %q' "$0" "$@"; printf '\nenviron:\n'; env | LC_ALL=C sort; } >'${path.join(temp, 'process-observable')}'
    while [[ ! -e '${path.join(temp, 'process-release')}' ]]; do /bin/sleep 0.05; done
  fi
  exit 0
elif [[ "$command" == compose ]]; then
  if [[ "\${FAKE_FAILURE:-}" == compose-leak && ! -e '${path.join(temp, 'compose.failed')}' ]]; then
    touch '${path.join(temp, 'compose.failed')}'
    printf '%s\n' '${TOKEN}' 'Traceback: docker internals' >&2
    exit 91
  fi
  printf '%s\n' "$KINVEST_IMAGE" >'${path.join(temp, 'runtime-image')}'
  env | LC_ALL=C sort >'${path.join(temp, 'container-env.inspect')}'
  exit 0
elif [[ "$command" == inspect ]]; then
  format="$2"
  [[ "$format" == *Health.Status* ]] && echo healthy || cat '${path.join(temp, 'runtime-image')}'
else
  exit 1
fi
`)
  return {
    temp, root, runRoot, bin, executor, operations, contract, runtimeHelper,
    observable: path.join(temp, 'process-observable'),
    release: path.join(temp, 'process-release'),
    containerEnv: path.join(temp, 'container-env.inspect')
  }
}

function waitForFile(file, child, output, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer)
        resolve()
      } else if (child.exitCode !== null) {
        clearInterval(timer)
        reject(new Error(`controlled child exited before observation: ${output.stderr}`))
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for controlled fixture: ${path.basename(file)}`))
      }
    }, 25)
  })
}

function readProcessSurface(pid, controlledFallback) {
  if (process.platform === 'linux' && fs.existsSync(`/proc/${pid}`)) {
    return Buffer.concat([
      fs.readFileSync(`/proc/${pid}/cmdline`),
      fs.readFileSync(`/proc/${pid}/environ`)
    ]).toString('utf8')
  }
  // macOS has no /proc. ps eww is the controlled platform-equivalent view of
  // argv plus environment available to another same-user process.
  const result = spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (result.status === 0) return result.stdout
  // Sandboxed macOS can deny process-list access. The controlled child records
  // its own argv/environ, which is the same surface ps/env would expose.
  return fs.readFileSync(controlledFallback, 'utf8')
}

function cleanupHarness(harness) {
  for (const bundleRoot of ['kinvest-secrets', 'kinvest-ifind-secrets']) {
    const fullRoot = path.join(harness.runRoot, bundleRoot)
    if (fs.existsSync(fullRoot)) {
      for (const name of fs.readdirSync(fullRoot)) {
        try { fs.chmodSync(path.join(fullRoot, name), 0o700) } catch {}
      }
    }
  }
  fs.rmSync(harness.temp, { recursive: true, force: true })
}

function scanPersistentFiles(root) {
  const findings = []
  function visit(input) {
    const stat = fs.lstatSync(input)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(input)) visit(path.join(input, name))
    } else if (stat.isFile() && fs.readFileSync(input).includes(Buffer.from(TOKEN))) {
      findings.push(input)
    }
  }
  visit(root)
  return findings
}

async function run() {
  testRuntimeDurabilityPrimitives()
  assert.equal(fs.existsSync(executorPath), true, 'deploy-v5 executor must exist')
  const syntax = spawnSync('bash', ['-n', executorPath], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const source = fs.readFileSync(executorPath, 'utf8')
  const runtimeSource = fs.readFileSync(runtimeHelperPath, 'utf8')
  const implementation = `${source}\n${runtimeSource}`
  assert.match(source, /KINVEST_DEPLOY_PROTOCOL='5'/)
  assert.match(source, /BUNDLE_UID='0'/)
  assert.match(source, /BUNDLE_GID='10001'/)
  assert.match(implementation, /os\.fchmod\(/)
  assert.match(implementation, /TMPFS_MAGIC/)
  assert.match(implementation, /fstatfs|statfs_fd/)
  assert.match(implementation, /validate_tmpfs_bundle_root/)
  assert.match(implementation, /cleanup_stale_sources/)
  assert.match(implementation, /validate_journal_payload/)
  assert.match(implementation, /recover_orphan_backups/)
  assert.doesNotMatch(runtimeSource, /if not sys\.platform\.startswith\('linux'\):[\s\S]{0,180}return TMPFS_MAGIC/)
  assert.match(implementation, /MATERIALIZE_STAGE_(DIRECTORY|MANIFEST|MATERIAL)/)
  assert.match(implementation, /rollback_materialization/)
  assert.match(source, /KINVEST_DEPLOY_V5/)
  assert.match(source, /IFIND_BUNDLE_ROOT="\$RUN_ROOT\/kinvest-ifind-secrets"/)
  assert.match(source, /io\.kinvest\.ifind-secret-bootstrap/)
  assert.match(source, /server\/ifind-secret-preflight\.js/)
  assert.match(source, /--network none/)
  assert.match(source, /--read-only/)
  assert.match(source, /--cap-drop ALL/)
  assert.match(source, /--user 10001:10001/)
  assert.match(implementation, /O_NOFOLLOW/)
  assert.match(source, /ROLLBACK_REQUIRES_DB_RESTORE/)
  assert.match(source, /DEPLOY_V5_IFIND_PREFLIGHT_FAILED/)
  assert.match(source, /resolve_offline_image/)
  assert.match(source, /verify_repo_digest/)

  const preflightAt = source.indexOf('run_ifind_preflight')
  const backupAt = source.indexOf('create_database_backup')
  const composeAt = source.indexOf('compose_up')
  assert.ok(preflightAt >= 0 && backupAt > preflightAt && composeAt > backupAt,
    'iFinD preflight function must be defined before backup and compose')

  assert.match(source, /trap cleanup EXIT/)
  assert.match(source, /write_journal prepared/)
  assert.match(source, /write_journal compose-active/)
  assert.match(source, /write_journal state-committed/)
  assert.match(source, /reconcile_transaction_journal/)
  assert.match(source, /restore_previous_runtime/)
  assert.match(source, /prune_ifind_bundles/)
  assert.match(source, /prune_access_bundles/)
  assert.match(source, /collect_referenced_bundle_ids/)
  assert.match(source, /verify_state_backup_references/)
  assert.match(source, /run_stable_command/)
  assert.match(source, /cleanup-stale-sources/)
  assert.match(source, /recover-orphan-backups/)
  assert.match(source, /exec 3>&2/)
  assert.match(source, /exec 2>\/dev\/null/)
  assert.ok(source.indexOf('write_journal prepared') < source.indexOf('release-registry "$candidate_registry"'),
    'candidate registry must survive until prepared journal is durable')
  assert.match(source, /RESTORE/)
  assert.match(source, /ROLLBACK/)
  assert.match(source, /FORWARD/)

  const token = 'synthetic-ifind-refresh-token-never-log'
  for (const relative of [
    'deploy/server/deploy-kinvest-v5',
    'deploy/server/docker-compose-v5.yml',
    'server/ifind-secret-preflight.js'
  ]) {
    assert.equal(fs.readFileSync(path.join(rootDir, relative), 'utf8').includes(token), false)
  }

  const v4 = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-kinvest-v3.sh'), 'utf8')
  assert.match(v4, /if \[\[ "\$DEPLOY_PROTOCOL" == 4 \]\]/)
  assert.doesNotMatch(v4, /KINVEST_DEPLOY_PROTOCOL:-5/)

  const harness = makeHarness({ seedBundles: true })
  try {
    const backupRecoveryProbe = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('runtime', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.recover_orphan_backups(sys.argv[2], sys.argv[3], os.getuid(), os.getgid())
`, harness.runtimeHelper, path.join(harness.root, 'backups'), path.join(harness.root, 'state')], {
      encoding: 'utf8', env: { ...process.env, KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1', PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(backupRecoveryProbe.status, 0, backupRecoveryProbe.stderr)
    const probePayload = path.join(harness.runRoot, 'kinvest-v5.probe.payload')
    fs.writeFileSync(probePayload, diagnosticPayload(), { mode: 0o600 })
    const reserveProbe = spawnSync(process.env.PYTHON || 'python3', [
      harness.runtimeHelper, 'reserve-registry', harness.runRoot,
      String(process.getuid()), String(process.getgid())
    ], { encoding: 'utf8', env: { ...process.env, KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1' } })
    assert.equal(reserveProbe.status, 0, reserveProbe.stderr)
    const probeRegistry = reserveProbe.stdout.trim()
    const materializeProbe = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('runtime', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.materialize(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                   os.getuid(), os.getgid(), os.getuid(), os.getgid(), sys.argv[6])
`, harness.runtimeHelper, probePayload, harness.runRoot,
    path.join(harness.runRoot, 'kinvest-secrets'),
    path.join(harness.runRoot, 'kinvest-ifind-secrets'), probeRegistry], {
      encoding: 'utf8', env: { ...process.env, KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1', PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(materializeProbe.status, 0, materializeProbe.stderr)
    const recoverProbe = spawnSync(process.env.PYTHON || 'python3', [
      harness.runtimeHelper, 'recover', probeRegistry, harness.runRoot,
      path.join(harness.runRoot, 'kinvest-secrets'), path.join(harness.runRoot, 'kinvest-ifind-secrets'),
      path.join(harness.root, 'backups'), path.join(harness.root, 'state'),
      String(process.getuid()), String(process.getgid())
    ], { encoding: 'utf8', env: { ...process.env, KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1' } })
    assert.equal(recoverProbe.status, 0, recoverProbe.stderr)
    fs.rmSync(probePayload)
    const executable = process.env.KINVEST_TEST_TRACE === '1' ? 'bash' : harness.executor
    const args = process.env.KINVEST_TEST_TRACE === '1' ? ['-x', harness.executor] : []
    const deployed = spawnSync(executable, args, {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${harness.bin}:${process.env.PATH}` },
      maxBuffer: 1024 * 1024
    })
    assert.equal(deployed.status, 0, JSON.stringify({
      stderr: deployed.stderr, stdout: deployed.stdout, signal: deployed.signal,
      operations: fs.existsSync(harness.operations) ? fs.readFileSync(harness.operations, 'utf8') : ''
    }))
    assert.match(deployed.stdout, /KINVEST_DEPLOY_V5_OK/)
    assert.equal(deployed.stdout.includes(TOKEN), false)
    assert.equal(deployed.stderr.includes(TOKEN), false)
    const operations = fs.readFileSync(harness.operations, 'utf8')
    assert.equal(operations.includes(TOKEN), false)
    assert.match(operations, new RegExp(`attestation resolve ${DIGEST} ${COMMIT} 123`))
    assert.ok(operations.indexOf('attestation ') < operations.indexOf('docker image inspect'))
    assert.ok(operations.indexOf('server/ifind-secret-preflight.js') < operations.indexOf(' compose '))
    assert.deepEqual(scanPersistentFiles(harness.root), [])
    const state = fs.readFileSync(path.join(harness.root, 'state/current.state'), 'utf8')
    assert.match(state, /ifindDiagnosticMode=diagnostic/)
    assert.match(state, /ifindRefreshTokenVersionId=v20260826-001/)
    assert.doesNotMatch(state, new RegExp(TOKEN))
    const previous = spawnSync(process.env.PYTHON || 'python3', [
      path.join(harness.temp, 'libexec/deploy-v5-contract.py'), 'parse-state'
    ], {
      encoding: 'utf8', input: fs.readFileSync(path.join(harness.root, 'state/previous.state'), 'utf8'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(previous.status, 0, previous.stderr)
    assert.match(source, /atomic_state_from_text "\$candidate_state" "\$CURRENT_STATE" current/)
    const bundles = fs.readdirSync(path.join(harness.runRoot, 'kinvest-ifind-secrets'))
    assert.equal(bundles.length, 1)
    assert.equal(bundles.includes('8'.repeat(32)), false)
    const accessBundles = fs.readdirSync(path.join(harness.runRoot, 'kinvest-secrets')).filter(name => name !== 'disabled')
    assert.equal(accessBundles.includes('1'.repeat(32)), true)
    assert.equal(accessBundles.includes('9'.repeat(32)), false)
    for (const bundleId of accessBundles) {
      const accessPath = path.join(harness.runRoot, 'kinvest-secrets', bundleId)
      for (const name of fs.readdirSync(accessPath)) {
        const file = path.join(accessPath, name)
        if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(TOKEN)), false, file)
      }
    }
    assert.equal(fs.readFileSync(harness.containerEnv, 'utf8').includes(TOKEN), false)
    const bundlePath = path.join(harness.runRoot, 'kinvest-ifind-secrets', bundles[0])
    const provider = await loadPrivateIfindBundleLoader()({
      versionId: 'v20260826-001', bundlePath,
      expectedUid: process.getuid(), expectedGid: process.getgid(),
      fsApi: createProviderFsAdapter(bundlePath)
    })
    const loadedToken = provider.readRefreshToken()
    assert.equal(loadedToken.toString('ascii'), TOKEN)
    loadedToken.fill(0)
    provider.clear()
  } finally {
    cleanupHarness(harness)
  }

  const disabled = makeHarness()
  try {
    const deployed = spawnSync(disabled.executor, [], {
      encoding: 'utf8', input: disabledPayload(),
      env: { ...process.env, PATH: `${disabled.bin}:${process.env.PATH}` }
    })
    assert.equal(deployed.status, 0, JSON.stringify({
      stderr: deployed.stderr, stdout: deployed.stdout,
      operations: fs.existsSync(disabled.operations) ? fs.readFileSync(disabled.operations, 'utf8') : ''
    }))
    assert.equal(fs.readdirSync(path.join(disabled.runRoot, 'kinvest-ifind-secrets')).length, 0)
    const operations = fs.readFileSync(disabled.operations, 'utf8')
    assert.equal(operations.includes('server/ifind-secret-preflight.js'), false)
    assert.match(operations, /kinvest-disabled/)
  } finally {
    cleanupHarness(disabled)
  }

  const failed = makeHarness()
  try {
    const deployed = spawnSync(failed.executor, [], {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${failed.bin}:${process.env.PATH}`, FAKE_FAILURE: 'ifind-preflight' }
    })
    assert.notEqual(deployed.status, 0)
    assert.equal(deployed.stderr, 'DEPLOY_V5_IFIND_PREFLIGHT_FAILED\n')
    assert.equal(fs.readdirSync(path.join(failed.root, 'backups')).length, 0)
    assert.equal(fs.readdirSync(path.join(failed.runRoot, 'kinvest-ifind-secrets')).length, 0)
    assert.match(fs.readFileSync(path.join(failed.root, 'state/current.state'), 'utf8'),
      new RegExp(`runtimeImageId=${CURRENT_ID}`))
  } finally {
    cleanupHarness(failed)
  }

  for (const stage of [
    'CREATE_CANDIDATE_AFTER_MKDIR', 'CREATE_CANDIDATE_AFTER_OPEN',
    'CREATE_CANDIDATE_AFTER_CHOWN', 'CREATE_CANDIDATE_AFTER_STATFS',
    'MATERIALIZE_STAGE_DIRECTORY', 'MATERIALIZE_STAGE_MANIFEST', 'MATERIALIZE_STAGE_MATERIAL'
  ]) {
    const faulted = makeHarness({ materializeFault: stage })
    try {
      const result = spawnSync(faulted.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${faulted.bin}:${process.env.PATH}`, KINVEST_V5_TEST_ALLOW_NON_TMPFS: '1' }
      })
      assert.notEqual(result.status, 0, `${stage} must fail`)
      assert.equal(result.stderr, 'DEPLOY_V5_BUNDLE_CREATE_FAILED\n')
      assert.deepEqual(fs.readdirSync(path.join(faulted.runRoot, 'kinvest-secrets')), [])
      assert.deepEqual(fs.readdirSync(path.join(faulted.runRoot, 'kinvest-ifind-secrets')), [])
    } finally { cleanupHarness(faulted) }
  }

  for (const signalType of ['TERM', 'KILL']) {
    const interrupted = makeHarness({
      signalWindow: 'HELPER_WINDOW_AFTER_SUCCESS_BEFORE_ID_RECORD', signalType
    })
    try {
      const first = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.notEqual(first.status, 0, signalType)
      fs.writeFileSync(interrupted.executor,
        fs.readFileSync(interrupted.executor, 'utf8').replace(
          new RegExp(`kill -${signalType} \\$\\$  # HELPER_WINDOW_AFTER_SUCCESS_BEFORE_ID_RECORD`),
          ':  # HELPER_WINDOW_AFTER_SUCCESS_BEFORE_ID_RECORD'
        ), { mode: 0o755 })
      const recovered = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: disabledPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.equal(recovered.status, 0, recovered.stderr)
      assert.deepEqual(fs.readdirSync(path.join(interrupted.runRoot, 'kinvest-ifind-secrets')), [])
      assert.equal(fs.readdirSync(interrupted.runRoot).some(name => name.startsWith('kinvest-v5.candidates.')), false)
    } finally { cleanupHarness(interrupted) }
  }

  for (const window of [
    'HELPER_WINDOW_AFTER_SUCCESS_BEFORE_ID_RECORD',
    'REGISTRY_WINDOW_AFTER_ID_RECORD',
    'REGISTRY_WINDOW_BEFORE_PREPARED_JOURNAL',
    'REGISTRY_WINDOW_AFTER_PREPARED_BEFORE_DELETE'
  ]) {
    const interrupted = makeHarness({ signalWindow: window, signalType: 'KILL' })
    try {
      const first = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.notEqual(first.status, 0, window)
      fs.writeFileSync(interrupted.executor,
        fs.readFileSync(interrupted.executor, 'utf8').replace(
          new RegExp(`kill -KILL \\$\\$  # ${window}`), `:  # ${window}`
        ), { mode: 0o755 })
      const recovered = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: disabledPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.equal(recovered.status, 0, `${window}: ${recovered.stderr}`)
      assert.deepEqual(fs.readdirSync(path.join(interrupted.runRoot, 'kinvest-ifind-secrets')), [])
      assert.equal(fs.readdirSync(interrupted.runRoot).some(name => name.startsWith('kinvest-v5.candidates.')), false)
    } finally { cleanupHarness(interrupted) }
  }

  for (const [failure, expected] of [
    ['init-install', 'DEPLOY_V5_INITIALIZE_FAILED\n'],
    ['file-mktemp', 'DEPLOY_V5_PAYLOAD_FILE_FAILED\n'],
    ['file-chmod', 'DEPLOY_V5_PAYLOAD_FILE_FAILED\n'],
    ['payload-dd', 'DEPLOY_V5_PAYLOAD_READ_FAILED\n'],
    ['backup-mv', 'DEPLOY_V5_DATABASE_BACKUP_FAILED\n'],
    ['state-mv', 'DEPLOY_V5_STATE_WRITE_FAILED\n']
  ]) {
    const operationFailure = makeHarness()
    try {
      const result = spawnSync(operationFailure.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${operationFailure.bin}:${process.env.PATH}`, FAKE_FAILURE: failure }
      })
      assert.notEqual(result.status, 0, failure)
      assert.equal(result.stderr, expected, failure)
      assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false, failure)
      assert.equal(result.stderr.includes('Traceback') || result.stderr.includes('/private/'), false, failure)
    } finally { cleanupHarness(operationFailure) }
  }

  for (const [failure, expected] of [
    ['capture-rm', 'DEPLOY_V5_CAPTURE_CLEANUP_FAILED\n'],
    ['cleanup-rm', 'DEPLOY_V5_IFIND_PREFLIGHT_FAILED\n'],
    ['journal-rm', 'DEPLOY_V5_JOURNAL_CLEANUP_FAILED\nDEPLOY_V5_RECOVERY_FAILED\n']
  ]) {
    const removalFailure = makeHarness()
    try {
      const env = {
        ...process.env, PATH: `${removalFailure.bin}:${process.env.PATH}`,
        FAKE_RM_FAILURE: failure,
        ...(failure === 'cleanup-rm' ? { FAKE_FAILURE: 'ifind-preflight' } : {})
      }
      const result = spawnSync(removalFailure.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(), env
      })
      assert.notEqual(result.status, 0, failure)
      assert.equal(result.stderr, expected, failure)
      assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false, failure)
      assert.equal(result.stderr.includes('/private/') || result.stderr.includes('rm:'), false, failure)
      const leftovers = fs.readdirSync(removalFailure.runRoot).filter(name =>
        /^kinvest-v5\.(command-|payload\.|candidates\.)/.test(name))
      assert.deepEqual(leftovers, [], `${failure}: ${leftovers.join(',')}`)
    } finally { cleanupHarness(removalFailure) }
  }

  const observable = makeHarness()
  let observedChild
  try {
    const output = { stdout: '', stderr: '' }
    const child = spawn(observable.executor, [], {
      env: { ...process.env, PATH: `${observable.bin}:${process.env.PATH}`, FAKE_BLOCK: 'preflight' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    observedChild = child
    child.stdout.on('data', chunk => { output.stdout += chunk })
    child.stderr.on('data', chunk => { output.stderr += chunk })
    child.stdin.end(diagnosticPayload())
    await waitForFile(observable.observable, child, output)
    assert.equal(readProcessSurface(child.pid, observable.observable).includes(TOKEN), false)
    fs.writeFileSync(observable.release, '')
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('controlled process observation timed out')) }, 10000)
      child.on('close', code => { clearTimeout(timer); resolve({ code, ...output }) })
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false)
    assert.equal(fs.readFileSync(observable.containerEnv, 'utf8').includes(TOKEN), false)
  } finally {
    if (observedChild && observedChild.exitCode === null) observedChild.kill('SIGKILL')
    cleanupHarness(observable)
  }

  for (const [name, options, expected] of [
    ['symlink-root', { symlinkIfindRoot: true }, 'DEPLOY_V5_BUNDLE_CREATE_FAILED\n'],
    ['non-tmpfs-root', { disableTmpfsMock: true }, 'DEPLOY_V5_RUNTIME_SOURCE_RECOVERY_FAILED\n']
  ]) {
    const invalidRoot = makeHarness(options)
    try {
      const result = spawnSync(invalidRoot.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${invalidRoot.bin}:${process.env.PATH}` }
      })
      assert.notEqual(result.status, 0, name)
      assert.equal(result.stderr, expected)
    } finally { cleanupHarness(invalidRoot) }
  }

  const provenance = makeHarness()
  try {
    const result = spawnSync(provenance.executor, [], {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${provenance.bin}:${process.env.PATH}`, FAKE_ATTESTATION_ID: CURRENT_ID }
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_V5_IMAGE_PROVENANCE_INVALID\n')
    assert.match(fs.readFileSync(provenance.operations, 'utf8'), /attestation resolve/)
  } finally { cleanupHarness(provenance) }

  const leaked = makeHarness()
  try {
    const result = spawnSync(leaked.executor, [], {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${leaked.bin}:${process.env.PATH}`, FAKE_FAILURE: 'compose-leak' }
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_V5_COMPOSE_FAILED\n', JSON.stringify({
      stdout: result.stdout,
      operations: fs.existsSync(leaked.operations) ? fs.readFileSync(leaked.operations, 'utf8') : '',
      stateFiles: fs.readdirSync(path.join(leaked.root, 'state'))
    }))
    assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false)
    assert.equal(result.stderr.includes('Traceback'), false)
  } finally { cleanupHarness(leaked) }

  const badBackup = makeHarness({ currentBackup: 'symlink' })
  try {
    const result = spawnSync(badBackup.executor, [], {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${badBackup.bin}:${process.env.PATH}` }
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_V5_BACKUP_RECOVERY_FAILED\n')
    assert.equal(fs.existsSync(badBackup.operations) &&
      fs.readFileSync(badBackup.operations, 'utf8').includes(' compose '), false)
  } finally { cleanupHarness(badBackup) }

  for (const window of [
    'TRANSACTION_WINDOW_BEFORE_COMPOSE',
    'TRANSACTION_WINDOW_AFTER_COMPOSE_BEFORE_CURRENT',
    'TRANSACTION_WINDOW_AFTER_CURRENT_BEFORE_KEEP'
  ]) {
    const interrupted = makeHarness({ signalWindow: window })
    try {
      const first = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.notEqual(first.status, 0, `${window} must interrupt`)
      fs.writeFileSync(interrupted.executor,
        fs.readFileSync(interrupted.executor, 'utf8').replace(`kill -TERM $$  # ${window}`, `:  # ${window}`),
        { mode: 0o755 })
      const recovered = spawnSync(interrupted.executor, [], {
        encoding: 'utf8', input: diagnosticPayload(),
        env: { ...process.env, PATH: `${interrupted.bin}:${process.env.PATH}` }
      })
      assert.equal(recovered.status, 0, `${window}: ${recovered.stderr}`)
      assert.equal(fs.existsSync(path.join(interrupted.root, 'state/deploy-v5.journal')), false)
      assert.equal(fs.existsSync(path.join(interrupted.root, 'state/deploy-v5-current.before')), false)
    } finally { cleanupHarness(interrupted) }
  }


  const deployedState = currentState({
    imageDigest: DIGEST, runtimeImageId: IMAGE_ID, commit: COMMIT,
    verificationRunId: '123', secretBundleId: '3'.repeat(32),
    ifindDiagnosticMode: 'diagnostic', ifindRefreshTokenVersionId: 'v20260826-001',
    ifindSecretBundleId: '4'.repeat(32), ifindSecretMaterialFingerprint: crypto.createHash('sha256').update(TOKEN).digest('hex')
  })
  const rollback = makeHarness({ currentStateOverrides: deployedState, previousState: currentState() })
  try {
    const result = spawnSync(rollback.executor, [], {
      encoding: 'utf8', input: intentPayload('ROLLBACK', CURRENT_DIGEST, CURRENT_COMMIT),
      env: { ...process.env, PATH: `${rollback.bin}:${process.env.PATH}`, FAKE_ATTESTATION_ID: CURRENT_ID }
    })
    assert.equal(result.status, 0, result.stderr)
    const operations = fs.readFileSync(rollback.operations, 'utf8')
    assert.match(operations, new RegExp(`attestation resolve ${CURRENT_DIGEST} ${CURRENT_COMMIT} 1`))
    const state = fs.readFileSync(path.join(rollback.root, 'state/current.state'), 'utf8')
    assert.match(state, /verificationRunId=1/)
    assert.match(state, new RegExp(`runtimeImageId=${CURRENT_ID}`))
  } finally { cleanupHarness(rollback) }

  const restore = makeHarness({ currentStateOverrides: deployedState, currentBackup: 'valid' })
  try {
    const result = spawnSync(restore.executor, [], {
      encoding: 'utf8', input: intentPayload('RESTORE', DIGEST, COMMIT),
      env: { ...process.env, PATH: `${restore.bin}:${process.env.PATH}` }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(fs.readFileSync(restore.operations, 'utf8'), new RegExp(`attestation resolve ${DIGEST} ${COMMIT} 123`))
    assert.deepEqual(fs.readdirSync(path.join(restore.root, 'backups')), ['current.sqlite'])
    const restoredState = fs.readFileSync(path.join(restore.root, 'state/current.state'), 'utf8')
    assert.match(restoredState, /databaseBackupPath=.*current\.sqlite/)
    assert.match(restoredState, /databaseBackupChecksum=[0-9a-f]{64}/)
  } finally { cleanupHarness(restore) }

  const incompatible = makeHarness({ currentStateOverrides: deployedState, previousState: currentState() })
  try {
    const result = spawnSync(incompatible.executor, [], {
      encoding: 'utf8', input: intentPayload('ROLLBACK', CURRENT_DIGEST, CURRENT_COMMIT),
      env: { ...process.env, PATH: `${incompatible.bin}:${process.env.PATH}`, FAKE_ATTESTATION_ID: CURRENT_ID, FAKE_SCHEMA_MIN: '2' }
    })
    assert.equal(result.status, 75)
    assert.equal(result.stderr, 'ROLLBACK_REQUIRES_DB_RESTORE\n')
  } finally { cleanupHarness(incompatible) }

  const providerIncompatible = makeHarness({ currentStateOverrides: deployedState, previousState: currentState() })
  try {
    const result = spawnSync(providerIncompatible.executor, [], {
      encoding: 'utf8', input: intentPayload('ROLLBACK', CURRENT_DIGEST, CURRENT_COMMIT),
      env: { ...process.env, PATH: `${providerIncompatible.bin}:${process.env.PATH}`, FAKE_ATTESTATION_ID: CURRENT_ID, FAKE_IFIND_LABEL: '0' }
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_V5_IFIND_PROVIDER_INCOMPATIBLE\n')
  } finally { cleanupHarness(providerIncompatible) }

  await runLinuxTmpfsIntegration()
}

module.exports = { run }

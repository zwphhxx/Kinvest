const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const ownedGroups = new WeakMap()

function fixture(blocked) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-installer-lifecycle-'))
  fs.chmodSync(base, 0o700)
  const bin = path.join(base, 'bin')
  fs.mkdirSync(bin)
  const script = path.join(base, 'installer.sh')
  const groupFile = path.join(base, 'owned-group')
  const descendantFile = path.join(base, 'owned-descendant')
  fs.writeFileSync(script, blocked ? `#!/bin/bash
printf '%s\\n' "$$" >"$LIFECYCLE_GROUP_FILE"
"$LIFECYCLE_NODE" -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 &
printf '%s\\n' "$!" >"$LIFECYCLE_CHILD_FILE"
while :; do sleep 1; done
` : "#!/bin/bash\nprintf 'installer-fixture\\n'\nprintf 'fixture-stderr\\n' >&2\nexit 7\n", { mode: 0o700 })
  return {
    base, bin, script, groupFile, descendantFile,
    fixtureSource: base,
    fsyncTrace: path.join(base, 'fsync.trace')
  }
}

function overrides(context) {
  return {
    LIFECYCLE_NODE: process.execPath,
    LIFECYCLE_GROUP_FILE: context.groupFile,
    LIFECYCLE_CHILD_FILE: context.descendantFile
  }
}

function ownedGroup(context) {
  const cached = ownedGroups.get(context)
  if (cached !== undefined) return cached
  const text = fs.readFileSync(context.groupFile, 'utf8').trim()
  assert.match(text, /^[0-9]+$/)
  const pid = Number(text)
  assert.equal(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, true)
  ownedGroups.set(context, pid)
  return pid
}

function groupExists(groupId) {
  const result = spawnSync('pgrep', ['-g', String(groupId)], {
    encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 65536
  })
  assert.equal(result.error, undefined, 'owned test group probe failed')
  assert.equal(result.signal, null)
  if (result.status === 1 && result.stdout.trim() === '') return false
  assert.equal(result.status, 0, 'owned test group probe failed')
  assert.match(result.stdout.trim(), /^[0-9]+(?:\s+[0-9]+)*$/)
  return true
}

// Independent fallback owns only the group recorded by our private fixture shell.
// It is also used after the deliberate termination-denied test, never on user processes.
async function removeOwnedFixture(context) {
  const groupId = ownedGroups.get(context) ?? (fs.existsSync(context.groupFile) ? ownedGroup(context) : undefined)
  if (groupId !== undefined) {
    if (groupExists(groupId)) {
      try { process.kill(-groupId, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const deadline = performance.now() + 5000
    while (groupExists(groupId)) {
      assert.ok(performance.now() < deadline, 'owned fixture group failed to terminate')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  fs.rmSync(context.base, { recursive: true, force: true })
  ownedGroups.delete(context)
}

async function run() {
  for (const version of ['v4', 'v5']) {
    const api = require(`./deploy-${version}-installer.test.js`)
    assert.equal(typeof api.executeInstallerForTest, 'function', `${version}: managed execute entry is required`)
    assert.equal(typeof api.cleanupInstallerFixtureForTest, 'function', `${version}: guarded fixture cleanup is required`)

    const normal = fixture(false)
    try {
      const result = await api.executeInstallerForTest(normal, overrides(normal))
      assert.deepEqual({ status: result.status, signal: result.signal }, { status: 7, signal: null })
      assert.equal(result.stdout, 'installer-fixture\n')
      assert.equal(result.stderr, 'fixture-stderr\n')
      await api.cleanupInstallerFixtureForTest(normal)
      assert.equal(fs.existsSync(normal.base), false)
    } finally {
      await removeOwnedFixture(normal)
    }

    const timedOut = fixture(true)
    try {
      await assert.rejects(api.executeInstallerForTest(timedOut, overrides(timedOut), {
        label: `${version}-installer-owned-timeout`, completionTimeoutMs: 3000
      }), /DEPLOY_TEST_EXIT_TIMEOUT/)
      assert.match(fs.readFileSync(timedOut.descendantFile, 'utf8').trim(), /^[0-9]+$/)
      assert.equal(groupExists(ownedGroup(timedOut)), false, 'timeout must reap descendants before returning')
      await api.cleanupInstallerFixtureForTest(timedOut)
      assert.equal(fs.existsSync(timedOut.base), false)
    } finally {
      await removeOwnedFixture(timedOut)
    }

    const denied = fixture(true)
    try {
      await assert.rejects(api.executeInstallerForTest(denied, overrides(denied), {
        label: `${version}-installer-cleanup-denied`, completionTimeoutMs: 3000,
        terminate: () => { throw Object.assign(new Error('controlled termination denial'), { code: 'EPERM' }) }
      }), /DEPLOY_TEST_TERMINATE_FAILED/)
      const groupId = ownedGroup(denied)
      assert.equal(groupExists(groupId), true)
      await assert.rejects(api.cleanupInstallerFixtureForTest(denied), /DEPLOY_TEST_TERMINATE_FAILED/)
      assert.equal(fs.existsSync(denied.base), true, 'failed cleanup must preserve the fixture')
      // Simulate a broken cleanup deleting its ownership metadata before fallback runs.
      fs.rmSync(denied.base, { recursive: true, force: true })
      await removeOwnedFixture(denied)
      assert.equal(groupExists(groupId), false, 'fallback must reap its cached group after fixture deletion')
    } finally {
      await removeOwnedFixture(denied)
    }
  }
  process.stdout.write('installer-execution-lifecycle: PASS\n')
}

module.exports = { run }

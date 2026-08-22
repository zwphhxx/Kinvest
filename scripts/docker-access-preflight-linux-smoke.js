const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { runAccessPreflight } = require('../server/access-preflight')

async function run() {
  assert.equal(process.platform, 'linux')
  assert.equal(fs.statSync('/proc/self/fd').isDirectory(), true)
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    'kinvest-linux-preflight-'
  )))
  const candidatePath = path.join(directory, 'candidate.sqlite')
  const productionPath = path.join(directory, 'production.sqlite')
  const candidate = new DatabaseSync(candidatePath)
  candidate.exec(`
    PRAGMA application_id = 1263099478;
    CREATE TABLE linux_smoke_marker (value INTEGER NOT NULL);
    INSERT INTO linux_smoke_marker VALUES (1);
  `)
  candidate.close()
  const sourceBefore = fs.readFileSync(candidatePath)
  let stdout = ''
  let stderr = ''
  try {
    const exitCode = await runAccessPreflight({
      env: {
        KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
        KINVEST_DB_PATH: productionPath
      },
      databasePath: candidatePath,
      prepare: async ({ openDatabase, closeDatabase }) => {
        const database = openDatabase()
        try {
          assert.equal(database.prepare(
            'SELECT value FROM linux_smoke_marker'
          ).get().value, 1)
        } finally {
          closeDatabase(database)
        }
        return {
          status: {
            mode: 'device-approval',
            references: 2,
            database: 'ready',
            proxy: 'ready'
          },
          clear() {}
        }
      },
      stdout: { write: (value) => { stdout += String(value) } },
      stderr: { write: (value) => { stderr += String(value) } },
      processRef: new EventEmitter()
    })
    assert.equal(exitCode, 0)
    assert.equal(
      stdout,
      'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n'
    )
    assert.equal(stderr, '')
    assert.deepStrictEqual(fs.readFileSync(candidatePath), sourceBefore)
    fs.writeFileSync('/tmp/kinvest-access-preflight-linux-smoke-ok', 'ok\n')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

run().catch(() => {
  process.exitCode = 1
})

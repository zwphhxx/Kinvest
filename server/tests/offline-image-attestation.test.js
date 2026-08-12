const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const pythonTest = path.join(__dirname, 'offline-image-attestation.test.py')

async function run() {
  const result = spawnSync('python3', [pythonTest, '-v'], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.signal, null)
}

module.exports = { run }

const assert = require('assert')
const fs = require('fs')
const path = require('path')

async function runBuildArtifactsExist() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const expectedArtifacts = [
    'dist/server/server.js',
    'dist/server/services/health.js',
    'dist/public/index.html',
    'dist/public/research.html',
    'dist/public/app.css',
    'dist/public/app.js'
  ]

  for (const artifact of expectedArtifacts) {
    assert.ok(
      fs.existsSync(path.join(repositoryRoot, artifact)),
      `Expected build artifact to exist: ${artifact}`
    )
  }
}

module.exports = { run: runBuildArtifactsExist }

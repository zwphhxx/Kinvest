const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function listRelativeFiles(directory, prefix = '') {
  const files = []
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(path.join(directory, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files
}

async function runBuildArtifactsExist() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const fixturePath = path.join(repositoryRoot, 'server', 'data', 'build-leak.log')
  const expectedArtifacts = [
    'package.json',
    'public/app.css',
    'public/app.js',
    'public/index.html',
    'public/research.html',
    'server/adapters/ifindAdapter.js',
    'server/data/mockData.js',
    'server/db/refresh-db.js',
    'server/server.js',
    'server/services/health.js',
    'server/services/refresh-rules.js',
    'server/utils/refresh-policy.js'
  ]

  try {
    fs.writeFileSync(fixturePath, 'build leak fixture\n')
    execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build.js')], {
      cwd: repositoryRoot
    })

    assert.strictEqual(
      fs.existsSync(path.join(repositoryRoot, 'dist', 'server', 'data', 'build-leak.log')),
      false,
      'Build must not copy files outside the runtime allowlist'
    )
    assert.deepStrictEqual(
      listRelativeFiles(path.join(repositoryRoot, 'dist')),
      expectedArtifacts
    )
  } finally {
    fs.rmSync(fixturePath, { force: true })
  }
}

module.exports = { run: runBuildArtifactsExist }

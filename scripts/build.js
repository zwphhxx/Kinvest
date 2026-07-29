const fs = require('fs')
const path = require('path')

const repositoryRoot = path.resolve(__dirname, '..')
const distDirectory = path.join(repositoryRoot, 'dist')
const runtimeFiles = [
  'server/server.js',
  'server/adapters/ifindAdapter.js',
  'server/data/mockData.js',
  'server/db/refresh-db.js',
  'server/services/health.js',
  'server/services/refresh-rules.js',
  'server/utils/refresh-policy.js',
  'public/index.html',
  'public/research.html',
  'public/app.css',
  'public/app.js',
  'public/finance-contract.js'
].sort()

fs.rmSync(distDirectory, { recursive: true, force: true })

for (const relativePath of runtimeFiles) {
  const sourcePath = path.join(repositoryRoot, relativePath)
  const destinationPath = path.join(distDirectory, relativePath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.copyFileSync(sourcePath, destinationPath)
}

const packageJson = require(path.join(repositoryRoot, 'package.json'))
const distPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  private: packageJson.private,
  type: packageJson.type,
  engines: packageJson.engines,
  scripts: {
    start: packageJson.scripts.start
  }
}

fs.writeFileSync(
  path.join(distDirectory, 'package.json'),
  `${JSON.stringify(distPackageJson, null, 2)}\n`
)

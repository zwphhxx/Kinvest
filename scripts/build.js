const fs = require('fs')
const path = require('path')

const repositoryRoot = path.resolve(__dirname, '..')
const distDirectory = path.join(repositoryRoot, 'dist')

function shouldCopy(filename) {
  return !filename.endsWith('.sqlite') && !filename.endsWith('.sqlite-journal')
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })

  const entries = fs
    .readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!shouldCopy(entry.name)) {
      continue
    }

    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

fs.rmSync(distDirectory, { recursive: true, force: true })
copyDirectory(
  path.join(repositoryRoot, 'server'),
  path.join(distDirectory, 'server')
)
copyDirectory(
  path.join(repositoryRoot, 'public'),
  path.join(distDirectory, 'public')
)
fs.rmSync(path.join(distDirectory, 'server', 'tests'), {
  recursive: true,
  force: true
})

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

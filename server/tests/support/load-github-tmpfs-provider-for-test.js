const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const providerPath = path.resolve(
  __dirname,
  '..',
  '..',
  'security',
  'github-tmpfs-secret-provider.js'
)

function loadPrivateBundleLoader() {
  const source = fs.readFileSync(providerPath, 'utf8')
  const wrappedSource = [
    '(function (exports, require, module, __filename, __dirname) {',
    source,
    'module.exports.__testOnlyLoadBundle = loadGithubTmpfsSecretsFromBundle',
    '})'
  ].join('\n')
  const wrapper = new vm.Script(wrappedSource, {
    filename: providerPath
  }).runInThisContext()
  const testModule = { exports: {} }
  wrapper(
    testModule.exports,
    createRequire(providerPath),
    testModule,
    providerPath,
    path.dirname(providerPath)
  )
  return testModule.exports.__testOnlyLoadBundle
}

function createGithubTmpfsSecretLoaderForTest({
  bundlePath,
  expectedUid,
  expectedGid
}) {
  const loadBundle = loadPrivateBundleLoader()
  const directoryDescriptors = new Map()
  const mapProcPath = (input) => {
    if (typeof input !== 'string') return input
    const match = input.match(/^\/proc\/self\/fd\/([0-9]+)(\/.*)?$/)
    if (!match) return input
    const root = directoryDescriptors.get(Number(match[1]))
    if (!root) return input
    return match[2]
      ? path.join(root, match[2].slice(1))
      : root
  }
  const fsAdapter = {
    constants: fs.constants,
    openSync(input, flags, mode) {
      const mapped = mapProcPath(input)
      const descriptor = fs.openSync(mapped, flags, mode)
      if (mapped === bundlePath && (flags & fs.constants.O_DIRECTORY) !== 0) {
        directoryDescriptors.set(descriptor, bundlePath)
      }
      return descriptor
    },
    closeSync(descriptor) {
      directoryDescriptors.delete(descriptor)
      return fs.closeSync(descriptor)
    },
    fstatSync: (descriptor) => fs.fstatSync(descriptor),
    lstatSync: (input) => fs.lstatSync(mapProcPath(input)),
    readSync: (descriptor, buffer, offset, length, position) =>
      fs.readSync(descriptor, buffer, offset, length, position),
    readdirSync: (input) => fs.readdirSync(mapProcPath(input))
  }
  return ({ references }) => loadBundle({
    references,
    bundlePath,
    expectedUid,
    expectedGid,
    fsApi: fsAdapter
  })
}

module.exports = { createGithubTmpfsSecretLoaderForTest }

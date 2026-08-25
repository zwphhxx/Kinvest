const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const VERSION_ID = 'v20260826-001'
const MANIFEST_FILE = 'manifest.json'
const TOKEN_FILE = 'refresh-token'
const FORMAT = 'kinvest-ifind-tmpfs-v1'
const TOKEN = Buffer.from('synthetic-ifind-refresh-token-for-tests')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalManifest(token = TOKEN, overrides = {}) {
  return JSON.stringify({
    format: FORMAT,
    refreshToken: {
      file: TOKEN_FILE,
      versionId: VERSION_ID,
      sha256: sha256(token)
    },
    ...overrides
  })
}

function createBundle(root, mutate = () => {}) {
  const bundlePath = path.join(root, 'bundle-sensitive-path-marker')
  const token = Buffer.from(TOKEN)
  fs.mkdirSync(bundlePath, { mode: 0o700 })
  fs.writeFileSync(path.join(bundlePath, TOKEN_FILE), token, { mode: 0o600 })
  fs.writeFileSync(
    path.join(bundlePath, MANIFEST_FILE),
    canonicalManifest(token),
    { mode: 0o600 }
  )
  mutate({ bundlePath, token })
  for (const name of fs.readdirSync(bundlePath)) {
    const filePath = path.join(bundlePath, name)
    if (fs.lstatSync(filePath).isFile()) fs.chmodSync(filePath, 0o440)
  }
  fs.chmodSync(bundlePath, 0o550)
  return { bundlePath, token }
}

async function withBundle(mutate, assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-ifind-provider-test-'))
  try {
    await assertion(createBundle(root, mutate), root)
  } finally {
    try { fs.chmodSync(path.join(root, 'bundle-sensitive-path-marker'), 0o700) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function loadPrivateBundleLoader() {
  const providerPath = path.resolve(__dirname, '..', 'security', 'ifind-tmpfs-secret-provider.js')
  const source = fs.readFileSync(providerPath, 'utf8')
  const wrapper = new vm.Script([
    '(function (exports, require, module, __filename, __dirname) {',
    source,
    'module.exports.__testOnlyLoadBundle = loadIfindTmpfsSecretsFromBundle',
    '})'
  ].join('\n'), { filename: providerPath }).runInThisContext()
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

function createFsAdapter(bundlePath, overrides = {}) {
  const directoryDescriptors = new Map()
  const mapProcPath = (input) => {
    if (typeof input !== 'string') return input
    const match = input.match(/^\/proc\/self\/fd\/([0-9]+)(\/.*)?$/)
    if (!match) return input
    const root = directoryDescriptors.get(Number(match[1]))
    if (!root) return input
    return match[2] ? path.join(root, match[2].slice(1)) : root
  }
  const adapter = {
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
    fstatSync: (descriptor, options) => fs.fstatSync(descriptor, options),
    lstatSync: (input, options) => fs.lstatSync(mapProcPath(input), options),
    readSync: (descriptor, buffer, offset, length, position) =>
      fs.readSync(descriptor, buffer, offset, length, position),
    readdirSync: (input) => fs.readdirSync(mapProcPath(input))
  }
  return { ...adapter, ...overrides }
}

function loadTestBundle(bundlePath, options = {}) {
  return loadPrivateBundleLoader()({
    versionId: options.versionId || VERSION_ID,
    bundlePath,
    expectedUid: options.expectedUid === undefined ? process.getuid() : options.expectedUid,
    expectedGid: options.expectedGid === undefined ? process.getgid() : options.expectedGid,
    fsApi: options.fsApi || createFsAdapter(bundlePath)
  })
}

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code
}

async function assertInvalidMutation(mutate, options = {}) {
  await withBundle(mutate, async ({ bundlePath, token }) => {
    let failure
    try {
      await loadTestBundle(bundlePath, options)
    } catch (error) {
      failure = error
    }
    assert.equal(hasCode('IFIND_TMPFS_BUNDLE_INVALID')(failure), true)
    const serialized = `${failure.name}:${failure.message}:${failure.code}`
    for (const marker of [
      bundlePath,
      VERSION_ID,
      TOKEN.toString('utf8'),
      token.toString('utf8'),
      sha256(token),
      'sensitive-path-marker'
    ]) {
      assert.equal(serialized.includes(marker), false)
    }
    assert.equal('cause' in failure, false)
  })
}

async function run() {
  const production = require('../security/ifind-tmpfs-secret-provider')
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'security', 'ifind-tmpfs-secret-provider.js'),
    'utf8'
  )
  assert.equal(source.includes('fs.readFileSync'), false)
  assert.equal(source.includes('fs.constants.O_NOFOLLOW'), true)
  assert.equal(source.includes("'/proc/self/fd/'"), true)
  assert.deepEqual(Object.keys(production).sort(), [
    'BUNDLE_DIRECTORY_MODE',
    'BUNDLE_FILE_MODE',
    'BUNDLE_GROUP_GID',
    'BUNDLE_OWNER_UID',
    'BUNDLE_PATH',
    'IfindTmpfsSecretProviderError',
    'loadIfindTmpfsSecrets'
  ])
  assert.equal(production.BUNDLE_PATH, '/run/secrets/kinvest-ifind')
  assert.equal(production.BUNDLE_OWNER_UID, 0)
  assert.equal(production.BUNDLE_GROUP_GID, 10001)
  assert.equal(production.BUNDLE_DIRECTORY_MODE, 0o550)
  assert.equal(production.BUNDLE_FILE_MODE, 0o440)

  const originalOpenSync = fs.openSync
  fs.openSync = () => { throw new Error('disabled mode performed filesystem I/O') }
  try {
    assert.equal(await production.loadIfindTmpfsSecrets({ mode: 'disabled' }), null)
  } finally {
    fs.openSync = originalOpenSync
  }
  await assert.rejects(
    production.loadIfindTmpfsSecrets({
      mode: 'admin-diagnostic',
      versionId: VERSION_ID,
      bundlePath: '/tmp/not-production'
    }),
    hasCode('IFIND_SECRET_CONFIG_INVALID')
  )

  await withBundle(() => {}, async ({ bundlePath, token }) => {
    const originalBufferFrom = Buffer.from
    const originalBufferToString = Buffer.prototype.toString
    const ownedCandidates = []
    let tokenDecodeCalls = 0
    Buffer.from = function from(...args) {
      const value = originalBufferFrom.apply(Buffer, args)
      if (Buffer.isBuffer(args[0]) && args[0].equals(token) && args[0] !== token) {
        ownedCandidates.push(value)
      }
      return value
    }
    Buffer.prototype.toString = function toString(...args) {
      if (this.equals(token)) {
        tokenDecodeCalls += 1
        throw new Error('secret token bytes were decoded as text')
      }
      return originalBufferToString.apply(this, args)
    }
    let provider
    try {
      provider = await loadTestBundle(bundlePath)
    } finally {
      Buffer.from = originalBufferFrom
      Buffer.prototype.toString = originalBufferToString
    }
    assert.equal(tokenDecodeCalls, 0)
    assert.equal(Reflect.ownKeys(provider).length, 0)
    const first = provider.readRefreshToken()
    const second = provider.readRefreshToken()
    assert.notStrictEqual(first, second)
    assert.equal(first.equals(token), true)
    first.fill(0)
    assert.equal(second.equals(token), true)
    const owned = ownedCandidates.find((value) => value.equals(token))
    assert.equal(Boolean(owned), true)
    provider.clear()
    provider.clear()
    assert.equal(owned.every((byte) => byte === 0), true)
    assert.throws(() => provider.readRefreshToken(), hasCode('IFIND_REFRESH_TOKEN_UNAVAILABLE'))
  })

  const tokenMutations = [
    Buffer.alloc(0),
    Buffer.alloc(4097, 65),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('token\0value'),
    Buffer.from('token\nvalue'),
    Buffer.from('token\rvalue'),
    Buffer.from([0x74, 0x6f, 0x01, 0x6b, 0x65, 0x6e]),
    Buffer.from([0x74, 0x6f, 0xc2, 0x80, 0x6b, 0x65, 0x6e])
  ]
  for (const invalidToken of tokenMutations) {
    await assertInvalidMutation(({ bundlePath }) => {
      fs.writeFileSync(path.join(bundlePath, TOKEN_FILE), invalidToken)
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), canonicalManifest(invalidToken))
    })
  }

  const manifestMutations = [
    ({ bundlePath, token }) => fs.writeFileSync(
      path.join(bundlePath, MANIFEST_FILE),
      JSON.stringify(JSON.parse(canonicalManifest(token)), null, 2)
    ),
    ({ bundlePath, token }) => fs.writeFileSync(
      path.join(bundlePath, MANIFEST_FILE),
      canonicalManifest(token, { extra: true })
    ),
    ({ bundlePath, token }) => {
      const manifest = JSON.parse(canonicalManifest(token))
      manifest.format = 'wrong-format'
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    },
    ({ bundlePath, token }) => {
      const manifest = JSON.parse(canonicalManifest(token))
      manifest.refreshToken.file = 'current'
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    },
    ({ bundlePath, token }) => {
      const manifest = JSON.parse(canonicalManifest(token))
      manifest.refreshToken.versionId = 'previous'
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    },
    ({ bundlePath, token }) => {
      const manifest = JSON.parse(canonicalManifest(token))
      manifest.refreshToken.sha256 = '0'.repeat(64)
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    }
  ]
  for (const mutate of manifestMutations) await assertInvalidMutation(mutate)

  const filesystemMutations = [
    ({ bundlePath }) => fs.writeFileSync(path.join(bundlePath, 'extra'), 'extra'),
    ({ bundlePath }) => fs.rmSync(path.join(bundlePath, MANIFEST_FILE)),
    ({ bundlePath }) => {
      fs.rmSync(path.join(bundlePath, TOKEN_FILE))
      fs.symlinkSync(path.join(bundlePath, MANIFEST_FILE), path.join(bundlePath, TOKEN_FILE))
    },
    ({ bundlePath }) => fs.linkSync(
      path.join(bundlePath, TOKEN_FILE),
      path.join(path.dirname(bundlePath), 'hard-link-sensitive-path-marker')
    ),
    ({ bundlePath }) => {
      fs.rmSync(path.join(bundlePath, TOKEN_FILE))
      fs.mkdirSync(path.join(bundlePath, TOKEN_FILE))
    }
  ]
  for (const mutate of filesystemMutations) await assertInvalidMutation(mutate)

  await withBundle(() => {}, async ({ bundlePath }) => {
    fs.chmodSync(bundlePath, 0o700)
    await assert.rejects(loadTestBundle(bundlePath), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })
  await withBundle(() => {}, async ({ bundlePath }) => {
    fs.chmodSync(path.join(bundlePath, TOKEN_FILE), 0o600)
    await assert.rejects(loadTestBundle(bundlePath), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })
  await withBundle(() => {}, async ({ bundlePath }) => {
    await assert.rejects(loadTestBundle(bundlePath, {
      expectedUid: process.getuid() + 1
    }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
    await assert.rejects(loadTestBundle(bundlePath, {
      expectedGid: process.getgid() + 1
    }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })
  await withBundle(() => {}, async ({ bundlePath }) => {
    await assert.rejects(loadTestBundle(bundlePath, {
      versionId: 'v20260826-002'
    }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })

  await withBundle(() => {}, async ({ bundlePath }) => {
    const adapter = createFsAdapter(bundlePath)
    const originalLstat = adapter.lstatSync
    let tokenStats = 0
    adapter.lstatSync = (input, options) => {
      const stat = originalLstat(input, options)
      if (String(input).endsWith(`/${TOKEN_FILE}`) && ++tokenStats === 2) {
        const one = typeof stat.ino === 'bigint' ? 1n : 1
        Object.defineProperty(stat, 'ino', { value: stat.ino + one })
      }
      return stat
    }
    await assert.rejects(loadTestBundle(bundlePath, { fsApi: adapter }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })
  await withBundle(() => {}, async ({ bundlePath }) => {
    const adapter = createFsAdapter(bundlePath)
    const originalLstat = adapter.lstatSync
    let directoryStats = 0
    adapter.lstatSync = (input, options) => {
      const stat = originalLstat(input, options)
      if (input === bundlePath && ++directoryStats === 2) {
        const one = typeof stat.ino === 'bigint' ? 1n : 1
        Object.defineProperty(stat, 'ino', { value: stat.ino + one })
      }
      return stat
    }
    await assert.rejects(loadTestBundle(bundlePath, { fsApi: adapter }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
  })

  await withBundle(() => {}, async ({ bundlePath }) => {
    const originalAlloc = Buffer.alloc
    const scratch = []
    let fstatCalls = 0
    Buffer.alloc = function alloc(...args) {
      const value = originalAlloc.apply(Buffer, args)
      if (args[0] === 4097) scratch.push(value)
      return value
    }
    const adapter = createFsAdapter(bundlePath)
    adapter.fstatSync = (descriptor, options) => {
      const stat = fs.fstatSync(descriptor, options)
      fstatCalls += 1
      if (fstatCalls === 5) {
        Object.defineProperty(stat, 'nlink', {
          value: typeof stat.nlink === 'bigint' ? 2n : 2
        })
      }
      return stat
    }
    try {
      await assert.rejects(loadTestBundle(bundlePath, { fsApi: adapter }), hasCode('IFIND_TMPFS_BUNDLE_INVALID'))
      assert.equal(scratch.length >= 2, true)
      assert.equal(scratch.every((value) => value.every((byte) => byte === 0)), true)
    } finally {
      Buffer.alloc = originalAlloc
    }
  })

  for (const rewrite of [
    (tokenPath, token) => {
      fs.chmodSync(tokenPath, 0o640)
      fs.appendFileSync(tokenPath, Buffer.from('x'))
      fs.truncateSync(tokenPath, token.length)
      fs.utimesSync(tokenPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'))
      fs.chmodSync(tokenPath, 0o440)
    },
    (tokenPath, token) => {
      fs.chmodSync(tokenPath, 0o640)
      fs.writeFileSync(tokenPath, Buffer.alloc(token.length, 0x78))
      fs.writeFileSync(tokenPath, token)
      fs.utimesSync(tokenPath, new Date('2021-01-01T00:00:00.000Z'), new Date('2021-01-01T00:00:00.000Z'))
      fs.chmodSync(tokenPath, 0o440)
    }
  ]) {
    await withBundle(() => {}, async ({ bundlePath, token }) => {
      const tokenPath = path.join(bundlePath, TOKEN_FILE)
      const initialStat = fs.statSync(tokenPath, { bigint: true })
      const adapter = createFsAdapter(bundlePath)
      const originalOpen = adapter.openSync
      let didRewrite = false
      adapter.openSync = (input, flags, mode) => {
        if (!didRewrite && String(input).endsWith(`/${TOKEN_FILE}`)) {
          didRewrite = true
          rewrite(tokenPath, token)
          const rewrittenStat = fs.statSync(tokenPath, { bigint: true })
          assert.equal(rewrittenStat.ino, initialStat.ino)
        }
        return originalOpen(input, flags, mode)
      }
      await assert.rejects(
        loadTestBundle(bundlePath, { fsApi: adapter }),
        hasCode('IFIND_TMPFS_BUNDLE_INVALID')
      )
      assert.equal(didRewrite, true)
    })
  }
}

module.exports = { run }

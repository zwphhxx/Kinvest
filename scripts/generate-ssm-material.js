const readline = require('node:readline/promises')
const { Writable } = require('node:stream')
const { spawn } = require('node:child_process')
const {
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret
} = require('../server/security/secret-bootstrap-contract')

const MODES = new Set([
  'admin-password-verifier',
  'device-token-hmac'
])

class SsmMaterialGeneratorError extends Error {
  constructor(code) {
    const messages = {
      ADMIN_PASSWORD_MISMATCH: 'The administrator password entries do not match',
      SSM_MATERIAL_CLI_USAGE_INVALID: 'The material generator command is invalid',
      SSM_MATERIAL_CLIPBOARD_FAILED: 'The macOS clipboard operation failed',
      SSM_MATERIAL_TTY_REQUIRED: 'An interactive terminal is required'
    }
    super(messages[code] || 'SSM material generation failed')
    this.name = 'SsmMaterialGeneratorError'
    this.code = code
  }
}

/** @param {unknown} error */
function stableErrorCode(error) {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? code
    : 'SSM_MATERIAL_GENERATION_FAILED'
}

/** @param {any} input @param {any} output @param {string} promptText */
async function readHiddenLine(input, output, promptText) {
  output.write(promptText)
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    }
  })
  const prompt = readline.createInterface({ input, output: mutedOutput, terminal: true })
  try {
    return await prompt.question('')
  } finally {
    prompt.close()
    output.write('\n')
  }
}

/** @param {any} input @param {any} output */
async function waitForClipboardClear(input, output) {
  const prompt = readline.createInterface({ input, output, terminal: true })
  try {
    await prompt.question('Paste the value into Tencent Cloud SSM, then press Enter here to clear the clipboard. ')
  } finally {
    prompt.close()
  }
}

/**
 * @param {string | Buffer} value
 * @param {typeof spawn} [spawnImpl]
 * @param {NodeJS.Platform} [platform]
 */
function writeMacClipboard(value, spawnImpl = spawn, platform = process.platform) {
  if (platform !== 'darwin') {
    return Promise.reject(new SsmMaterialGeneratorError('SSM_MATERIAL_CLIPBOARD_FAILED'))
  }
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(value)
    let child
    let settled = false
    const finish = (error) => {
      payload.fill(0)
      if (settled) return
      settled = true
      if (error) reject(new SsmMaterialGeneratorError('SSM_MATERIAL_CLIPBOARD_FAILED'))
      else resolve()
    }
    try {
      child = spawnImpl('/usr/bin/pbcopy', [], {
        stdio: ['pipe', 'ignore', 'ignore']
      })
    } catch {
      finish(new Error('clipboard spawn failed'))
      return
    }
    child.once('error', finish)
    child.once('close', (code) => finish(code === 0 ? null : new Error('clipboard failed')))
    child.stdin.once('error', finish)
    child.stdin.end(payload)
  })
}

/** @param {any} [options] */
async function runGenerator({
  mode,
  input = process.stdin,
  output = process.stdout,
  promptHidden = (promptText) => readHiddenLine(input, output, promptText),
  waitForClear = () => waitForClipboardClear(input, output),
  writeClipboard = writeMacClipboard,
  randomBytes
} = {}) {
  if (!MODES.has(mode)) {
    throw new SsmMaterialGeneratorError('SSM_MATERIAL_CLI_USAGE_INVALID')
  }
  if (!input || input.isTTY !== true || !output || output.isTTY !== true) {
    throw new SsmMaterialGeneratorError('SSM_MATERIAL_TTY_REQUIRED')
  }

  /** @type {Buffer | undefined} */
  let material
  let copied = false
  try {
    if (mode === 'admin-password-verifier') {
      const password = await promptHidden('Administrator password: ')
      const confirmation = await promptHidden('Administrator password again: ')
      if (password !== confirmation) {
        throw new SsmMaterialGeneratorError('ADMIN_PASSWORD_MISMATCH')
      }
      material = Buffer.from(generateAdminPasswordVerifier(password, randomBytes))
    } else {
      material = Buffer.from(generateDeviceHmacSecret(randomBytes))
    }

    await writeClipboard(material)
    copied = true
    output.write('SSM material copied to the macOS clipboard.\n')
    await waitForClear()
    return Object.freeze({ kind: mode })
  } finally {
    if (material) material.fill(0)
    if (copied) {
      await writeClipboard('')
      output.write('Clipboard cleared.\n')
    }
  }
}

/** @param {any} [options] */
async function runGeneratorCli({ argv = process.argv.slice(2), ...options } = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || !MODES.has(argv[0])) {
    throw new SsmMaterialGeneratorError('SSM_MATERIAL_CLI_USAGE_INVALID')
  }
  await runGenerator({ ...options, mode: argv[0] })
  return 0
}

if (require.main === module) {
  runGeneratorCli().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    process.stderr.write(`${stableErrorCode(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  SsmMaterialGeneratorError,
  readHiddenLine,
  runGenerator,
  runGeneratorCli,
  stableErrorCode,
  waitForClipboardClear,
  writeMacClipboard
}

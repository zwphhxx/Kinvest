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
const GENERATOR_ERROR_CODES = new Set([
  'ADMIN_PASSWORD_INVALID',
  'ADMIN_PASSWORD_MISMATCH',
  'ADMIN_VERIFIER_GENERATION_FAILED',
  'SSM_MATERIAL_CLI_USAGE_INVALID',
  'SSM_MATERIAL_CLIPBOARD_FAILED',
  'SSM_MATERIAL_TTY_REQUIRED'
])
const CLIPBOARD_TIMEOUT_MS = 5000
const CLIPBOARD_KILL_GRACE_MS = 250

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
  return typeof code === 'string' && GENERATOR_ERROR_CODES.has(code)
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
 * @param {object} [options]
 * @param {(command: string, args: string[], options: any) => any} [options.spawnImpl]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(handler: () => void, timeoutMs: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 */
function writeMacClipboard(value, {
  spawnImpl = spawn,
  platform = process.platform,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (platform !== 'darwin') {
    return Promise.reject(new SsmMaterialGeneratorError('SSM_MATERIAL_CLIPBOARD_FAILED'))
  }
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(value)
    let child
    let settled = false
    let operationTimer
    let killGraceTimer
    let stdin
    let terminationStarted = false
    let payloadCleared = false
    const clearPayload = () => {
      if (payloadCleared) return
      payloadCleared = true
      payload.fill(0)
    }
    const clearOperationTimer = () => {
      if (operationTimer === undefined) return
      clearTimer(operationTimer)
      operationTimer = undefined
    }
    const clearKillGraceTimer = () => {
      if (killGraceTimer === undefined) return
      clearTimer(killGraceTimer)
      killGraceTimer = undefined
    }
    const removeListeners = () => {
      if (child) {
        child.removeListener('error', handleChildError)
        child.removeListener('close', handleClose)
      }
      if (stdin) stdin.removeListener('error', handleStdinError)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      clearPayload()
      clearOperationTimer()
      clearKillGraceTimer()
      removeListeners()
      if (error) reject(new SsmMaterialGeneratorError('SSM_MATERIAL_CLIPBOARD_FAILED'))
      else resolve()
    }
    const terminateAndWaitForClose = () => {
      if (settled || terminationStarted) return
      terminationStarted = true
      clearOperationTimer()
      if (child && typeof child.kill === 'function') {
        try { child.kill('SIGKILL') } catch {
          // Best effort: the grace timer still clears buffers and rejects safely.
        }
      }
      // OS-level SIGKILL normally produces close; this bounds a malicious or
      // broken child implementation that never emits it.
      killGraceTimer = setTimer(
        () => finish(new Error('clipboard failed')),
        CLIPBOARD_KILL_GRACE_MS
      )
    }
    const handleChildError = () => terminateAndWaitForClose()
    const handleStdinError = () => terminateAndWaitForClose()
    const handleClose = (code) => {
      if (!terminationStarted && code === 0) finish()
      else finish(new Error('clipboard failed'))
    }
    try {
      child = spawnImpl('/usr/bin/pbcopy', [], {
        stdio: ['pipe', 'ignore', 'ignore']
      })
    } catch {
      finish(new Error('clipboard spawn failed'))
      return
    }
    stdin = child.stdin
    child.once('error', handleChildError)
    child.once('close', handleClose)
    stdin.once('error', handleStdinError)
    operationTimer = setTimer(terminateAndWaitForClose, CLIPBOARD_TIMEOUT_MS)
    try {
      stdin.end(payload, clearPayload)
    } catch {
      terminateAndWaitForClose()
    }
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
  let clipboardWriteAttempted = false
  let primaryError
  let result
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

    clipboardWriteAttempted = true
    await writeClipboard(material)
    output.write('SSM material copied to the macOS clipboard.\n')
    await waitForClear()
    result = Object.freeze({ kind: mode })
  } catch (error) {
    primaryError = error
  } finally {
    if (material) material.fill(0)
    if (clipboardWriteAttempted) {
      try {
        await writeClipboard(Buffer.alloc(0))
        output.write('Clipboard cleared.\n')
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError
      }
    }
  }
  if (primaryError) throw primaryError
  return result
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

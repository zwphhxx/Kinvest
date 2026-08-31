'use strict'

const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 32
const MAX_STRING_LENGTH = 16_384
const ESCAPES = Object.freeze({
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
})

function invalid() {
  throw new Error('The iFinD report-period JSON is invalid')
}

function digit(code) { return code >= 48 && code <= 57 }

function hexDigit(code) {
  if (digit(code)) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  invalid()
}

// Validate the complete bounded JSON grammar before JSON.parse can collapse keys.
// Each object owns its decoded-key set, including objects nested inside arrays.
// This guard is used only by the fixed report-period business response.
function assertReportPeriodDiagnosticJson(source) {
  if (typeof source !== 'string' || source.length > MAX_BYTES ||
      Buffer.byteLength(source, 'utf8') > MAX_BYTES) invalid()
  let offset = 0

  function whitespace() {
    while (offset < source.length) {
      const code = source.charCodeAt(offset)
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break
      offset += 1
    }
  }

  function stringValue() {
    if (source[offset] !== '"') invalid()
    offset += 1
    const decoded = []
    while (offset < source.length) {
      const code = source.charCodeAt(offset)
      let character = source[offset]
      offset += 1
      if (code === 34) return decoded.join('')
      if (code < 32) invalid()
      if (code === 92) {
        const escaped = source[offset]
        offset += 1
        if (escaped === 'u') {
          if (offset + 4 > source.length) invalid()
          let unit = 0
          for (let index = 0; index < 4; index += 1) {
            unit = unit * 16 + hexDigit(source.charCodeAt(offset))
            offset += 1
          }
          character = String.fromCharCode(unit)
        } else {
          if (!Object.hasOwn(ESCAPES, escaped)) invalid()
          character = ESCAPES[escaped]
        }
      }
      if (decoded.length >= MAX_STRING_LENGTH) invalid()
      decoded.push(character)
    }
    invalid()
  }

  function numberValue() {
    if (source[offset] === '-') offset += 1
    if (source[offset] === '0') {
      offset += 1
    } else {
      const first = source.charCodeAt(offset)
      if (first < 49 || first > 57 || !Number.isFinite(first)) invalid()
      while (digit(source.charCodeAt(offset))) offset += 1
    }
    if (source[offset] === '.') {
      offset += 1
      if (!digit(source.charCodeAt(offset))) invalid()
      while (digit(source.charCodeAt(offset))) offset += 1
    }
    if (source[offset] === 'e' || source[offset] === 'E') {
      offset += 1
      if (source[offset] === '+' || source[offset] === '-') offset += 1
      if (!digit(source.charCodeAt(offset))) invalid()
      while (digit(source.charCodeAt(offset))) offset += 1
    }
  }

  function value(depth) {
    whitespace()
    const character = source[offset]
    if (character === '{') {
      if (depth >= MAX_DEPTH) invalid()
      offset += 1
      whitespace()
      if (source[offset] === '}') { offset += 1; return }
      const keys = new Set()
      while (true) {
        whitespace()
        const key = stringValue()
        if (keys.has(key)) invalid()
        keys.add(key)
        whitespace()
        if (source[offset] !== ':') invalid()
        offset += 1
        value(depth + 1)
        whitespace()
        if (source[offset] === '}') { offset += 1; return }
        if (source[offset] !== ',') invalid()
        offset += 1
      }
    }
    if (character === '[') {
      if (depth >= MAX_DEPTH) invalid()
      offset += 1
      whitespace()
      if (source[offset] === ']') { offset += 1; return }
      while (true) {
        value(depth + 1)
        whitespace()
        if (source[offset] === ']') { offset += 1; return }
        if (source[offset] !== ',') invalid()
        offset += 1
      }
    }
    if (character === '"') { stringValue(); return }
    if (character === '-' || digit(source.charCodeAt(offset))) { numberValue(); return }
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, offset)) { offset += literal.length; return }
    }
    invalid()
  }

  value(0)
  whitespace()
  if (offset !== source.length) invalid()
}

module.exports = { assertReportPeriodDiagnosticJson }

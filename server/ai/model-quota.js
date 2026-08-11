const crypto = require('node:crypto')

const ATTEMPT_KINDS = Object.freeze(['generation', 'retry', 'format_repair'])
const LIMIT_KEYS = Object.freeze([
  'maxAttempts',
  'maxSuccesses',
  'maxInputTokens',
  'maxOutputTokens',
  'maxEstimatedCostMicros',
  'maxConcurrent'
])

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function assertLimits(limits) {
  if (!limits || typeof limits !== 'object') throw new Error('MODEL_LIMITS_REQUIRED')
  for (const key of LIMIT_KEYS) {
    if (!isNonNegativeInteger(limits[key])) throw new Error(`MODEL_LIMIT_INVALID:${key}`)
  }
  if (limits.maxConcurrent < 1) throw new Error('MODEL_LIMIT_INVALID:maxConcurrent')
}

/**
 * @param {{
 *   limits: Record<string, number>,
 *   now?: () => Date,
 *   idFactory?: () => string
 * }} options
 */
function createModelQuotaLedger({ limits, now = () => new Date(), idFactory = () => crypto.randomUUID() }) {
  assertLimits(limits)
  const dailyStates = new Map()
  const reservations = new Map()
  const activeReservations = new Set()

  function getDayKey() {
    return now().toISOString().slice(0, 10)
  }

  function getState(dayKey = getDayKey()) {
    if (!dailyStates.has(dayKey)) {
      dailyStates.set(dayKey, {
        attempts: 0,
        successes: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicros: 0,
        failedAttempts: 0,
        successfulAttempts: 0,
        completedRequestIds: new Set()
      })
    }
    return dailyStates.get(dayKey)
  }

  function reject(code) {
    return { ok: false, code }
  }

  function reserveAttempt(input) {
    const validInput = input &&
      typeof input.requestId === 'string' &&
      input.requestId.length > 0 &&
      ATTEMPT_KINDS.includes(input.attemptKind) &&
      isNonNegativeInteger(input.estimatedInputTokens) &&
      isNonNegativeInteger(input.maxOutputTokens) &&
      isNonNegativeInteger(input.estimatedCostMicros)
    if (!validInput) return reject('MODEL_RESERVATION_INVALID')

    const dayKey = getDayKey()
    const state = getState(dayKey)
    if (activeReservations.size >= limits.maxConcurrent) {
      return reject('MODEL_CONCURRENCY_LIMIT')
    }
    if (state.successes >= limits.maxSuccesses) return reject('MODEL_SUCCESS_LIMIT')
    if (state.attempts + 1 > limits.maxAttempts) return reject('MODEL_ATTEMPT_LIMIT')
    if (state.inputTokens + input.estimatedInputTokens > limits.maxInputTokens) {
      return reject('MODEL_INPUT_TOKEN_LIMIT')
    }
    if (state.outputTokens + input.maxOutputTokens > limits.maxOutputTokens) {
      return reject('MODEL_OUTPUT_TOKEN_LIMIT')
    }
    if (state.estimatedCostMicros + input.estimatedCostMicros > limits.maxEstimatedCostMicros) {
      return reject('MODEL_COST_LIMIT')
    }

    const reservationId = idFactory()
    const reservation = {
      reservationId,
      requestId: input.requestId,
      attemptKind: input.attemptKind,
      dayKey,
      estimatedInputTokens: input.estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      active: true
    }
    reservations.set(reservationId, reservation)
    activeReservations.add(reservationId)
    state.attempts += 1
    state.inputTokens += input.estimatedInputTokens
    state.outputTokens += input.maxOutputTokens
    state.estimatedCostMicros += input.estimatedCostMicros
    return { ok: true, reservationId, attemptKind: input.attemptKind }
  }

  function settleAttempt(reservationId, result) {
    const reservation = reservations.get(reservationId)
    if (!reservation || !reservation.active) return reject('MODEL_RESERVATION_NOT_ACTIVE')
    const validStatus = result && ['succeeded', 'failed'].includes(result.status)
    if (!validStatus) return reject('MODEL_SETTLEMENT_INVALID')

    const actualInputTokens = result.actualInputTokens === undefined
      ? reservation.estimatedInputTokens
      : result.actualInputTokens
    const actualOutputTokens = result.actualOutputTokens === undefined
      ? reservation.maxOutputTokens
      : result.actualOutputTokens
    const actualCostMicros = result.actualCostMicros === undefined
      ? reservation.estimatedCostMicros
      : result.actualCostMicros
    if (![actualInputTokens, actualOutputTokens, actualCostMicros].every(isNonNegativeInteger)) {
      return reject('MODEL_SETTLEMENT_INVALID')
    }

    const state = getState(reservation.dayKey)
    state.inputTokens += actualInputTokens - reservation.estimatedInputTokens
    state.outputTokens += actualOutputTokens - reservation.maxOutputTokens
    state.estimatedCostMicros += actualCostMicros - reservation.estimatedCostMicros
    state[result.status === 'succeeded' ? 'successfulAttempts' : 'failedAttempts'] += 1
    reservation.active = false
    reservation.status = result.status
    activeReservations.delete(reservationId)

    const exceededReservation = actualInputTokens > reservation.estimatedInputTokens ||
      actualOutputTokens > reservation.maxOutputTokens ||
      actualCostMicros > reservation.estimatedCostMicros
    const exceededDailyLimit = state.inputTokens > limits.maxInputTokens ||
      state.outputTokens > limits.maxOutputTokens ||
      state.estimatedCostMicros > limits.maxEstimatedCostMicros
    if (exceededReservation || exceededDailyLimit) {
      return reject('MODEL_USAGE_EXCEEDED_RESERVATION')
    }
    return { ok: true, status: result.status }
  }

  function recordResearchSuccess(requestId) {
    const state = getState()
    if (state.completedRequestIds.has(requestId)) return { ok: true, idempotent: true }
    if (state.successes >= limits.maxSuccesses) return reject('MODEL_SUCCESS_LIMIT')
    state.completedRequestIds.add(requestId)
    state.successes += 1
    return { ok: true, idempotent: false }
  }

  function getUsage(dayKey = getDayKey()) {
    const state = getState(dayKey)
    return {
      dayKey,
      attempts: state.attempts,
      successes: state.successes,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      estimatedCostMicros: state.estimatedCostMicros,
      failedAttempts: state.failedAttempts,
      successfulAttempts: state.successfulAttempts,
      activeReservations: activeReservations.size
    }
  }

  return {
    getUsage,
    recordResearchSuccess,
    reserveAttempt,
    settleAttempt
  }
}

module.exports = {
  ATTEMPT_KINDS,
  createModelQuotaLedger
}

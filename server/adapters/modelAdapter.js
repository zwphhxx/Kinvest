const {
  buildResearchModelRequest,
  validateResearchOutput
} = require('../ai/research-safety')

/**
 * @typedef {{
 *   baseUrl?: string,
 *   model?: string,
 *   apiKeyVersionId?: string,
 *   pricing?: {
 *     inputMicrosPerMillionTokens: number,
 *     outputMicrosPerMillionTokens: number
 *   }
 * }} ModelConfig
 */

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasHttpsBaseUrl(value) {
  if (!isNonEmptyString(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function hasPricing(pricing) {
  return pricing &&
    Number.isFinite(pricing.inputMicrosPerMillionTokens) &&
    pricing.inputMicrosPerMillionTokens >= 0 &&
    Number.isFinite(pricing.outputMicrosPerMillionTokens) &&
    pricing.outputMicrosPerMillionTokens >= 0
}

/** @param {ModelConfig} [config] */
function getModelAvailability(config = {}) {
  const missing = []
  if (!hasHttpsBaseUrl(config.baseUrl)) missing.push('baseUrl')
  if (!isNonEmptyString(config.model)) missing.push('model')
  if (!isNonEmptyString(config.apiKeyVersionId)) missing.push('apiKeyVersionId')
  if (!hasPricing(config.pricing)) missing.push('pricing')
  return missing.length > 0
    ? {
        enabled: false,
        sourceMode: 'mock',
        mode: 'safe_mock',
        modelCalled: false,
        reason: 'MODEL_CONFIGURATION_INCOMPLETE',
        missing
      }
    : {
        enabled: true,
        sourceMode: 'real',
        mode: 'real',
        modelCalled: false,
        reason: null,
        missing: []
      }
}

function estimateCostMicros(inputTokens, outputTokens, pricing) {
  return Math.ceil(
    (inputTokens * pricing.inputMicrosPerMillionTokens +
      outputTokens * pricing.outputMicrosPerMillionTokens) / 1_000_000
  )
}

/**
 * @param {{
 *   config?: ModelConfig,
 *   quotaLedger?: any,
 *   transport?: (request: any) => Promise<any>
 * }} [options]
 */
function createModelAdapter({ config = {}, quotaLedger, transport } = {}) {
  const configuredAvailability = getModelAvailability(config)
  const runtimeReady = quotaLedger &&
    typeof quotaLedger.reserveAttempt === 'function' &&
    typeof quotaLedger.settleAttempt === 'function' &&
    typeof quotaLedger.recordResearchSuccess === 'function' &&
    typeof transport === 'function'
  const availability = configuredAvailability.enabled && !runtimeReady
    ? {
        enabled: false,
        sourceMode: 'mock',
        mode: 'safe_mock',
        modelCalled: false,
        reason: 'MODEL_RUNTIME_INCOMPLETE',
        missing: ['quotaLedgerOrTransport']
      }
    : configuredAvailability
  const pricing = config.pricing || {
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0
  }

  async function generateResearch({
    snapshot,
    requestId,
    attemptKind = 'generation',
    estimatedInputTokens,
    maxOutputTokens
  }) {
    if (!availability.enabled) {
      return {
        status: 'safe_mock',
        sourceMode: 'mock',
        modelCalled: false,
        reason: availability.reason
      }
    }

    let request
    try {
      request = buildResearchModelRequest(snapshot, config.model || '')
    } catch {
      return { status: 'rejected', code: 'RESEARCH_SNAPSHOT_INVALID', modelCalled: false }
    }
    const estimatedCostMicros = estimateCostMicros(
      estimatedInputTokens,
      maxOutputTokens,
      pricing
    )
    const reservation = quotaLedger.reserveAttempt({
      requestId,
      attemptKind,
      estimatedInputTokens,
      maxOutputTokens,
      estimatedCostMicros
    })
    if (!reservation.ok) {
      return { status: 'rejected', code: reservation.code, modelCalled: false }
    }

    let providerResponse
    try {
      providerResponse = await transport(request.providerRequest)
    } catch {
      quotaLedger.settleAttempt(reservation.reservationId, { status: 'failed' })
      return { status: 'failed', code: 'MODEL_PROVIDER_FAILED', modelCalled: true }
    }

    const usage = providerResponse && providerResponse.usage
    const settlement = quotaLedger.settleAttempt(reservation.reservationId, {
      status: 'succeeded',
      actualInputTokens: usage && usage.inputTokens,
      actualOutputTokens: usage && usage.outputTokens,
      actualCostMicros: usage && usage.costMicros
    })
    if (!settlement.ok) {
      return { status: 'rejected', code: settlement.code, modelCalled: true }
    }

    const validated = validateResearchOutput(
      providerResponse && providerResponse.output,
      request.validationContext
    )
    if (!validated.ok) {
      return { status: 'rejected', code: validated.code, modelCalled: true }
    }
    const success = quotaLedger.recordResearchSuccess(requestId)
    if (!success.ok) {
      return { status: 'rejected', code: success.code, modelCalled: true }
    }
    return {
      status: 'ready',
      sourceMode: 'real',
      modelCalled: true,
      output: validated.output
    }
  }

  return {
    availability,
    generateResearch
  }
}

module.exports = {
  createModelAdapter,
  estimateCostMicros,
  getModelAvailability
}

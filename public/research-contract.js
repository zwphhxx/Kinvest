/* global module */

(function initResearchContract(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }
  if (root) {
    (/** @type {any} */ (root)).KinvestResearch = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createResearchContract() {
  const securityCodePattern = /^[A-Z0-9]{1,12}\.(HK|US|SH|SZ)$/

  function normalizeSecurityCode(value) {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toUpperCase()
    return securityCodePattern.test(normalized) ? normalized : null
  }

  function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }

  function isValidDate(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
  }

  function isValidVersion(value) {
    return (typeof value === 'string' && value.length > 0) || Number.isFinite(value)
  }

  function isValidCount(value) {
    return Number.isInteger(value) && value >= 0
  }

  async function parseJsonResponse(response) {
    const validResponse = response &&
      typeof response === 'object' &&
      typeof response.ok === 'boolean' &&
      typeof response.json === 'function'
    if (!validResponse) {
      throw new Error('研究接口响应不可用')
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new Error('研究接口返回格式不可用')
    }

    if (!response.ok) {
      const message = body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof body.error === 'string' &&
        body.error.trim()
        ? body.error.trim().slice(0, 200)
        : '研究接口请求失败'
      throw new Error(message)
    }

    return body
  }

  function normalizeResearchResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: '研究接口返回格式不可用' }
    }

    if (payload.success !== true) {
      const message = typeof payload.data?.message === 'string'
        ? payload.data.message
        : '无可用研究'
      return { ok: false, message }
    }

    const research = payload.data
    const sections = research?.sections
    const valid = research &&
      typeof research === 'object' &&
      (research.nameZh === undefined || typeof research.nameZh === 'string') &&
      isValidVersion(research.version) &&
      isValidDate(research.snapshotTime) &&
      isValidDate(research.generatedAt) &&
      isValidCount(research.citedAnnouncementsCount) &&
      isValidCount(research.citedNewsCount) &&
      isStringArray(research.tags) &&
      sections &&
      typeof sections === 'object' &&
      typeof sections.thesis === 'string' &&
      isStringArray(sections.bulls) &&
      isStringArray(sections.bears) &&
      isStringArray(sections.catalysts) &&
      isStringArray(sections.invalidation)

    if (!valid) {
      return { ok: false, message: '研究快照结构不完整，已停止展示' }
    }

    return { ok: true, data: research }
  }

  return {
    normalizeResearchResponse,
    normalizeSecurityCode,
    parseJsonResponse
  }
})

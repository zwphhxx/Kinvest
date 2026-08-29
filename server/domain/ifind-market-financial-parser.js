'use strict'

const { types } = require('node:util')
const { getIfindMarketCase } = require('./ifind-market-cases')

const METRIC_KEYS = Object.freeze([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
])

const VERIFICATION_FIELDS = Object.freeze([
  'issuerIdentityStatus',
  'vendorCodeStatus',
  'entitlementStatus',
  'currencyStatus',
  'unitStatus',
  'reportPeriodStatus',
  'scopeStatus',
  'sourceMode'
])

const EVIDENCE_STATUSES = new Set([
  'unverified',
  'verified',
  'failed',
  'not_applicable'
])

const FAILED_VERIFICATION = Object.freeze({
  issuerIdentityStatus: 'failed',
  vendorCodeStatus: 'failed',
  entitlementStatus: 'failed',
  currencyStatus: 'failed',
  unitStatus: 'failed',
  reportPeriodStatus: 'failed',
  scopeStatus: 'failed',
  sourceMode: 'failed'
})

const CURRENCY_EVIDENCE_FIELDS = Object.freeze([
  'caseId',
  'listingId',
  'currency',
  'evidenceStatus',
  'sourceIdentity',
  'sourceReference',
  'verifiedAt'
])

const SENSITIVE_EVIDENCE_TEXT = /token|secret|password|authorization|cookie|requestid/i

function catalogIdentity(caseId) {
  const marketCase = getIfindMarketCase(caseId)
  if (!marketCase) throw new Error('Fixed iFinD financial profile is missing its catalog case')
  return Object.freeze({
    caseId: marketCase.caseId,
    listingId: marketCase.listingId,
    displayCode: marketCase.displayCode
  })
}

function metricIds(market) {
  return Object.freeze({
    revenue: 'TEST_ONLY_' + market + '_REVENUE',
    grossProfit: 'TEST_ONLY_' + market + '_GROSS_PROFIT',
    attributableNetProfit: 'TEST_ONLY_' + market + '_NET_PROFIT',
    operatingCashFlow: 'TEST_ONLY_' + market + '_OPERATING_CASH_FLOW',
    receivables: 'TEST_ONLY_' + market + '_RECEIVABLES',
    inventory: 'TEST_ONLY_' + market + '_INVENTORY',
    interestBearingDebt: 'TEST_ONLY_' + market + '_INTEREST_BEARING_DEBT'
  })
}

function metadataIds(market) {
  return Object.freeze({
    currency: 'TEST_ONLY_' + market + '_CURRENCY',
    unit: 'TEST_ONLY_' + market + '_UNIT',
    reportPeriod: 'TEST_ONLY_' + market + '_REPORT_PERIOD',
    reportDate: 'TEST_ONLY_' + market + '_REPORT_DATE',
    periodType: 'TEST_ONLY_' + market + '_PERIOD_TYPE',
    disclosureScope: 'TEST_ONLY_' + market + '_DISCLOSURE_SCOPE',
    sourceTime: 'TEST_ONLY_' + market + '_SOURCE_TIME',
    fetchTime: 'TEST_ONLY_' + market + '_FETCH_TIME',
    sourceMode: 'TEST_ONLY_' + market + '_SOURCE_MODE'
  })
}

function ownDataRecord(value, allowedKeys, requiredKeys = allowedKeys) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null
    }
    const names = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length > allowedKeys.length) {
      return null
    }
    const allowed = new Set(allowedKeys)
    const descriptors = {}
    for (const name of names) {
      if (!allowed.has(name)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null
      }
      descriptors[name] = descriptor
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) return null
    return descriptors
  } catch {
    return null
  }
}

function ownAllowedDescriptors(value, allowedKeys) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null
    }
    const names = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length > allowedKeys.length) {
      return null
    }
    const allowed = new Set(allowedKeys)
    const descriptors = {}
    for (const name of names) {
      if (!allowed.has(name)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor) return null
      descriptors[name] = descriptor
    }
    return descriptors
  } catch {
    return null
  }
}

function ownDataDescriptor(descriptors, key) {
  const descriptor = descriptors[key]
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor
    : null
}

function ownDataArrayRange(value, minimumLength, maximumLength) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < minimumLength || lengthDescriptor.value > maximumLength) {
      return null
    }
    const length = lengthDescriptor.value
    const names = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== length + 1) {
      return null
    }
    const values = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null
      }
      values.push(descriptor.value)
    }
    return values
  } catch {
    return null
  }
}

function ownDataArray(value, expectedLength) {
  return ownDataArrayRange(value, expectedLength, expectedLength)
}

function descriptorValue(descriptors, key) {
  return descriptors[key].value
}

function parseCalendarDate(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 2000 || year > 2099) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day) return null
  return Object.freeze({ value, year, month, day })
}

function parseStrictTimestamp(value) {
  if (typeof value !== 'string' || value.length > 35) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return null
  const date = parseCalendarDate(match[1] + '-' + match[2] + '-' + match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = match[7] === undefined ? 0 : Number(match[7])
  if (!date || hour > 23 || minute > 59 || second > 59) return null

  let offsetMinutes = 0
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10])
    const offsetMinute = Number(match[11])
    if (offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)) return null
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[9] === '+' ? 1 : -1)
  }

  const milliseconds = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
    millisecond
  ) - offsetMinutes * 60 * 1000
  if (!Number.isFinite(milliseconds)) return null
  return Object.freeze({ value, milliseconds })
}

const TIMEZONE_FORMATTERS = Object.freeze({
  'Asia/Shanghai': new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }),
  'America/New_York': new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
})

function calendarDateInTimeZone(milliseconds, timeZone) {
  const formatter = TIMEZONE_FORMATTERS[timeZone]
  if (!formatter) return null
  const parts = formatter.formatToParts(new Date(milliseconds))
  const values = {}
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = part.value
    }
  }
  if (!values.year || !values.month || !values.day) return null
  return values.year + '-' + values.month + '-' + values.day
}

function isLastSaturday(date, month) {
  if (!date || date.month !== month) return false
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day))
  const daysInMonth = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate()
  return candidate.getUTCDay() === 6 && date.day + 7 > daysInMonth
}

function classifyAlibaba(reportPeriod, periodType, reportDate) {
  let match
  if (periodType === 'annual' && reportDate.month === 3 && reportDate.day === 31) {
    match = /^FY(\d{4})$/.exec(reportPeriod)
    return Boolean(match && Number(match[1]) === reportDate.year)
  }
  if (periodType === 'interim' && reportDate.month === 9 && reportDate.day === 30) {
    match = /^H1-FY(\d{4})$/.exec(reportPeriod)
    return Boolean(match && Number(match[1]) === reportDate.year + 1)
  }
  return false
}

function classifyApple(reportPeriod, periodType, reportDate) {
  let match
  if (periodType === 'annual' && isLastSaturday(reportDate, 9)) {
    match = /^FY(\d{4})$/.exec(reportPeriod)
    return Boolean(match && Number(match[1]) === reportDate.year)
  }
  if (periodType !== 'interim') return false
  match = /^Q([1-3])-FY(\d{4})$/.exec(reportPeriod)
  if (!match) return false
  const quarter = Number(match[1])
  const fiscalYear = Number(match[2])
  const month = quarter === 1 ? 12 : quarter === 2 ? 3 : 6
  const calendarYear = quarter === 1 ? fiscalYear - 1 : fiscalYear
  return reportDate.year === calendarYear && isLastSaturday(reportDate, month)
}

function classifyMoutai(reportPeriod, periodType, reportDate) {
  let match
  if (periodType === 'annual' && reportDate.month === 12 && reportDate.day === 31) {
    match = /^(\d{4})A$/.exec(reportPeriod)
    return Boolean(match && Number(match[1]) === reportDate.year)
  }
  if (periodType !== 'interim') return false
  match = /^(\d{4})(Q1|H1|Q3)$/.exec(reportPeriod)
  if (!match || Number(match[1]) !== reportDate.year) return false
  const monthDay = match[2] === 'Q1'
    ? [3, 31]
    : match[2] === 'H1' ? [6, 30] : [9, 30]
  return reportDate.month === monthDay[0] && reportDate.day === monthDay[1]
}

function profile(identity, market, vendorCode, scope, timeZone, classifyPeriod) {
  return Object.freeze({
    ...identity,
    market,
    vendorCode,
    scope,
    timeZone,
    unit: 'million',
    metricIds: metricIds(market),
    metadataIds: metadataIds(market),
    classifyPeriod
  })
}

const PROFILES = Object.freeze({
  HK_ALIBABA_9988: profile(
    catalogIdentity('HK_ALIBABA_9988'),
    'HK',
    'TEST_ONLY_HK_CODE',
    'consolidated',
    'Asia/Shanghai',
    classifyAlibaba
  ),
  US_APPLE_AAPL: profile(
    catalogIdentity('US_APPLE_AAPL'),
    'US',
    'TEST_ONLY_US_CODE',
    'issuer_consolidated',
    'America/New_York',
    classifyApple
  ),
  CN_MOUTAI_600519: profile(
    catalogIdentity('CN_MOUTAI_600519'),
    'CN',
    'TEST_ONLY_CN_CODE',
    'consolidated',
    'Asia/Shanghai',
    classifyMoutai
  )
})

function verificationSnapshot(value) {
  const descriptors = ownDataRecord(value, VERIFICATION_FIELDS)
  if (!descriptors) return null
  const snapshot = {}
  for (const field of VERIFICATION_FIELDS) {
    const status = descriptorValue(descriptors, field)
    if (field === 'sourceMode') {
      if (!['real', 'unverified', 'failed'].includes(status)) return null
    } else if (!EVIDENCE_STATUSES.has(status)) {
      return null
    }
    snapshot[field] = status
  }
  return Object.freeze(snapshot)
}

function hasApprovedVerification(verification) {
  return verification.sourceMode === 'real' &&
    VERIFICATION_FIELDS.slice(0, -1).every((field) => verification[field] === 'verified')
}

function unavailableVerification(verification, failedFields = []) {
  if (!verification) return FAILED_VERIFICATION
  const snapshot = { ...verification }
  for (const field of failedFields) snapshot[field] = 'failed'
  if (snapshot.sourceMode === 'real') {
    snapshot.sourceMode = VERIFICATION_FIELDS.slice(0, -1)
      .some((field) => snapshot[field] === 'failed') ? 'failed' : 'unverified'
  }
  return Object.freeze(snapshot)
}

function verificationWithCurrencyEvidence(verification, evidenceStatus) {
  const snapshot = {
    ...verification,
    currencyStatus: evidenceStatus
  }
  if (snapshot.sourceMode === 'real' && evidenceStatus !== 'verified') {
    snapshot.sourceMode = evidenceStatus === 'failed' ? 'failed' : 'unverified'
  }
  return Object.freeze(snapshot)
}

function safeEvidenceText(value, maximumLength, pattern) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    pattern.test(value) &&
    !SENSITIVE_EVIDENCE_TEXT.test(value)
}

function reportingCurrencyEvidenceSnapshot(value, profileDefinition) {
  const descriptors = ownDataRecord(value, CURRENCY_EVIDENCE_FIELDS)
  if (!descriptors) return { failedFields: ['currencyStatus'] }

  const caseId = descriptorValue(descriptors, 'caseId')
  const listingId = descriptorValue(descriptors, 'listingId')
  if (caseId !== profileDefinition.caseId || listingId !== profileDefinition.listingId) {
    return { failedFields: ['issuerIdentityStatus'] }
  }

  const evidenceStatus = descriptorValue(descriptors, 'evidenceStatus')
  const currency = descriptorValue(descriptors, 'currency')
  if (!['verified', 'unverified', 'failed'].includes(evidenceStatus)) {
    return { failedFields: ['currencyStatus'] }
  }
  const validCurrency = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
  if ((evidenceStatus === 'verified' && !validCurrency) ||
    (evidenceStatus !== 'verified' && currency !== null && !validCurrency)) {
    return { failedFields: ['currencyStatus'] }
  }

  const sourceIdentity = descriptorValue(descriptors, 'sourceIdentity')
  const sourceReference = descriptorValue(descriptors, 'sourceReference')
  const verifiedAt = parseStrictTimestamp(descriptorValue(descriptors, 'verifiedAt'))
  if (!safeEvidenceText(sourceIdentity, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/) ||
    !safeEvidenceText(sourceReference, 256, /^[A-Za-z0-9][A-Za-z0-9._:/#?-]*$/) ||
    !verifiedAt) {
    return { failedFields: ['currencyStatus'] }
  }

  return {
    evidence: Object.freeze({
      caseId,
      listingId,
      currency,
      evidenceStatus,
      verifiedAtMilliseconds: verifiedAt.milliseconds
    })
  }
}

function financialResult(profileDefinition, source, availability, verification, points) {
  return Object.freeze({
    caseId: profileDefinition ? profileDefinition.caseId : null,
    listingId: profileDefinition ? profileDefinition.listingId : null,
    displayCode: profileDefinition ? profileDefinition.displayCode : null,
    source,
    availability,
    verification,
    points: Object.freeze(points)
  })
}

function unavailable(profileDefinition, verification, failedFields = []) {
  return financialResult(
    profileDefinition,
    'unavailable',
    'unavailable',
    unavailableVerification(verification, failedFields),
    []
  )
}

function metadataArray(fieldDescriptors, indicatorId, periodCount, failedField) {
  const descriptor = ownDataDescriptor(fieldDescriptors, indicatorId)
  if (!descriptor) return { failedFields: [failedField] }
  const values = ownDataArray(descriptor.value, periodCount)
  return values ? { values } : { failedFields: [failedField] }
}

function parsePayload(profileDefinition, payload, verification, currencyEvidence) {
  const payloadDescriptors = ownDataRecord(
    payload,
    ['errorcode', 'tables', 'dataVol'],
    []
  )
  if (!payloadDescriptors) return { failedFields: ['scopeStatus'] }
  if (!payloadDescriptors.errorcode) return { failedFields: ['entitlementStatus'] }
  const errorCode = descriptorValue(payloadDescriptors, 'errorcode')
  if (!Number.isSafeInteger(errorCode)) return { failedFields: ['entitlementStatus'] }
  if (errorCode !== 0) return { failedFields: ['entitlementStatus'] }
  if (!payloadDescriptors.tables || !payloadDescriptors.dataVol) {
    return { failedFields: ['scopeStatus'] }
  }

  const tables = ownDataArray(descriptorValue(payloadDescriptors, 'tables'), 1)
  if (!tables) return { failedFields: ['scopeStatus'] }
  const tableDescriptors = ownDataRecord(tables[0], ['thscode', 'table'], [])
  if (!tableDescriptors) return { failedFields: ['scopeStatus'] }
  if (!tableDescriptors.thscode ||
    descriptorValue(tableDescriptors, 'thscode') !== profileDefinition.vendorCode) {
    return { failedFields: ['vendorCodeStatus'] }
  }
  if (!tableDescriptors.table) return { failedFields: ['scopeStatus'] }

  const metricIndicatorIds = METRIC_KEYS.map((metricKey) =>
    profileDefinition.metricIds[metricKey]
  )
  const metadataIndicatorIds = Object.values(profileDefinition.metadataIds)
  const fieldDescriptors = ownAllowedDescriptors(
    descriptorValue(tableDescriptors, 'table'),
    [...metricIndicatorIds, ...metadataIndicatorIds]
  )
  if (!fieldDescriptors) return { failedFields: ['scopeStatus'] }

  const reportPeriodId = profileDefinition.metadataIds.reportPeriod
  const reportPeriodDescriptor = ownDataDescriptor(fieldDescriptors, reportPeriodId)
  if (!reportPeriodDescriptor) {
    return { failedFields: ['reportPeriodStatus'] }
  }
  const reportPeriods = ownDataArrayRange(
    reportPeriodDescriptor.value,
    3,
    16
  )
  if (!reportPeriods) return { failedFields: ['reportPeriodStatus'] }
  const periodCount = reportPeriods.length

  const metadata = { reportPeriod: reportPeriods }
  const metadataDefinitions = [
    ['currency', 'currencyStatus'],
    ['unit', 'unitStatus'],
    ['reportDate', 'reportPeriodStatus'],
    ['periodType', 'reportPeriodStatus'],
    ['disclosureScope', 'scopeStatus'],
    ['sourceMode', 'scopeStatus'],
    ['sourceTime', 'scopeStatus'],
    ['fetchTime', 'scopeStatus']
  ]
  for (const [field, failedField] of metadataDefinitions) {
    const parsed = metadataArray(
      fieldDescriptors,
      profileDefinition.metadataIds[field],
      periodCount,
      failedField
    )
    if (!parsed.values) return parsed
    metadata[field] = parsed.values
  }

  let expectedDataVol = periodCount * Object.keys(profileDefinition.metadataIds).length
  const metricValues = {}
  for (const metricKey of METRIC_KEYS) {
    const indicatorId = profileDefinition.metricIds[metricKey]
    if (!fieldDescriptors[indicatorId]) {
      metricValues[metricKey] = null
      continue
    }
    const metricDescriptor = ownDataDescriptor(fieldDescriptors, indicatorId)
    if (!metricDescriptor) return { failedFields: ['scopeStatus'] }
    const values = ownDataArray(metricDescriptor.value, periodCount)
    if (!values) return { failedFields: ['scopeStatus'] }
    for (const value of values) {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { failedFields: ['scopeStatus'] }
      }
    }
    metricValues[metricKey] = values
    expectedDataVol += values.length
  }

  const dataVol = descriptorValue(payloadDescriptors, 'dataVol')
  if (!Number.isSafeInteger(dataVol) || dataVol !== expectedDataVol) {
    return { failedFields: ['scopeStatus'] }
  }

  const seenLabels = new Set()
  const seenDates = new Set()
  const acceptedPeriods = []
  for (let index = 0; index < periodCount; index += 1) {
    if (metadata.currency[index] !== currencyEvidence.currency) {
      return { failedFields: ['currencyStatus'] }
    }
    if (metadata.unit[index] !== profileDefinition.unit) {
      return { failedFields: ['unitStatus'] }
    }

    const reportPeriod = metadata.reportPeriod[index]
    const periodType = metadata.periodType[index]
    const reportDate = parseCalendarDate(metadata.reportDate[index])
    if (typeof reportPeriod !== 'string' ||
      reportPeriod.length < 1 ||
      reportPeriod.length > 64 ||
      reportPeriod.trim() !== reportPeriod ||
      !reportDate ||
      !profileDefinition.classifyPeriod(reportPeriod, periodType, reportDate)) {
      return { failedFields: ['reportPeriodStatus'] }
    }

    const dateIdentity = periodType + '\u0000' + reportDate.value
    if (seenLabels.has(reportPeriod) || seenDates.has(dateIdentity)) {
      return { failedFields: ['reportPeriodStatus'] }
    }
    seenLabels.add(reportPeriod)
    seenDates.add(dateIdentity)

    if (metadata.disclosureScope[index] !== profileDefinition.scope ||
      metadata.sourceMode[index] !== 'real') {
      return { failedFields: ['scopeStatus'] }
    }

    const sourceTime = parseStrictTimestamp(metadata.sourceTime[index])
    const fetchTime = parseStrictTimestamp(metadata.fetchTime[index])
    if (!sourceTime || !fetchTime) return { failedFields: ['scopeStatus'] }

    const sourceIssuerDate = calendarDateInTimeZone(
      sourceTime.milliseconds,
      profileDefinition.timeZone
    )
    const fetchIssuerDate = calendarDateInTimeZone(
      fetchTime.milliseconds,
      profileDefinition.timeZone
    )
    if (!sourceIssuerDate || !fetchIssuerDate) return { failedFields: ['scopeStatus'] }
    if (reportDate.value >= fetchIssuerDate) {
      return { failedFields: ['reportPeriodStatus'] }
    }
    if (sourceIssuerDate <= reportDate.value ||
      sourceTime.milliseconds > fetchTime.milliseconds) {
      return { failedFields: ['scopeStatus'] }
    }

    acceptedPeriods.push(Object.freeze({
      index,
      reportDate: reportDate.value,
      periodType
    }))
  }

  const annualPeriods = acceptedPeriods
    .filter((candidate) => candidate.periodType === 'annual')
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
  const interimPeriods = acceptedPeriods
    .filter((candidate) => candidate.periodType === 'interim')
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
  if (annualPeriods.length < 2 || interimPeriods.length < 1) {
    return { failedFields: ['reportPeriodStatus'] }
  }
  const selectedPeriods = [annualPeriods[0], annualPeriods[1], interimPeriods[0]]

  const points = []
  const seenMetricPeriods = new Set()
  for (const metricKey of METRIC_KEYS) {
    for (const selectedPeriod of selectedPeriods) {
      const index = selectedPeriod.index
      const pointIdentity = metricKey + '\u0000' + metadata.reportPeriod[index]
      if (seenMetricPeriods.has(pointIdentity)) {
        return { failedFields: ['reportPeriodStatus'] }
      }
      seenMetricPeriods.add(pointIdentity)
      const values = metricValues[metricKey]
      const value = values ? values[index] : null
      points.push(Object.freeze({
        metricKey,
        indicatorId: profileDefinition.metricIds[metricKey],
        value,
        currency: metadata.currency[index],
        unit: metadata.unit[index],
        reportPeriod: metadata.reportPeriod[index],
        reportDate: metadata.reportDate[index],
        periodType: metadata.periodType[index],
        disclosureScope: metadata.disclosureScope[index],
        sourceTime: metadata.sourceTime[index],
        fetchTime: metadata.fetchTime[index],
        verification,
        availability: value === null ? 'missing' : 'available'
      }))
    }
  }
  return { points }
}

function parseIfindMarketFinancials(input) {
  const inputDescriptors = ownDataRecord(
    input,
    ['caseId', 'payload', 'verification', 'financialReportingCurrencyEvidence'],
    ['caseId', 'payload', 'verification']
  )
  if (!inputDescriptors) return unavailable(null, null)

  const caseId = descriptorValue(inputDescriptors, 'caseId')
  const profileDefinition = typeof caseId === 'string' && Object.hasOwn(PROFILES, caseId)
    ? PROFILES[caseId]
    : null
  if (!profileDefinition) return unavailable(null, null)

  const verification = verificationSnapshot(descriptorValue(inputDescriptors, 'verification'))
  if (!verification) return unavailable(profileDefinition, null)
  if (!hasApprovedVerification(verification)) return unavailable(profileDefinition, verification)

  if (!inputDescriptors.financialReportingCurrencyEvidence) {
    return unavailable(profileDefinition, verification, ['currencyStatus'])
  }
  const evidenceResult = reportingCurrencyEvidenceSnapshot(
    descriptorValue(inputDescriptors, 'financialReportingCurrencyEvidence'),
    profileDefinition
  )
  if (!evidenceResult.evidence) {
    return unavailable(profileDefinition, verification, evidenceResult.failedFields)
  }
  if (evidenceResult.evidence.evidenceStatus !== 'verified') {
    return unavailable(
      profileDefinition,
      verificationWithCurrencyEvidence(
        verification,
        evidenceResult.evidence.evidenceStatus
      )
    )
  }

  const parsed = parsePayload(
    profileDefinition,
    descriptorValue(inputDescriptors, 'payload'),
    verification,
    evidenceResult.evidence
  )
  if (!parsed.points) {
    return unavailable(profileDefinition, verification, parsed.failedFields)
  }
  return financialResult(
    profileDefinition,
    'real',
    'available',
    verification,
    parsed.points
  )
}

module.exports = { parseIfindMarketFinancials }

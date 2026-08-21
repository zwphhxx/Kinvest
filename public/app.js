const state = {
  watchlist: [],
  selectedCode: null,
  currentCompany: null,
  financeMode: 'annual'
}

const financeContracts = /** @type {any} */ (window).KinvestFinance
const valuationContracts = /** @type {any} */ (window).KinvestValuation
const authContracts = /** @type {any} */ (window).KinvestAuth
const authUi = /** @type {any} */ (window).KinvestAuthUi

const el = {
  globalStatus: document.getElementById('global-status'),
  watchlist: document.getElementById('watchlist'),
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  searchHint: document.getElementById('search-hint'),
  searchResults: document.getElementById('search-results'),
  companyEmpty: document.getElementById('company-empty'),
  companyContent: document.getElementById('company-content'),
  companyHead: document.getElementById('company-head'),
  marketStatus: document.getElementById('market-status'),
  marketData: document.getElementById('market-data'),
  thermo: document.getElementById('valuation-thermometer'),
  financeButtons: Array.from(document.querySelectorAll('.chip-btn')),
  financeTableWrap: document.getElementById('finance-table-wrap'),
  anomalyList: document.getElementById('anomaly-list'),
  breakdownTable: document.getElementById('breakdown-table'),
  announcementList: document.getElementById('announcement-list'),
  newsList: document.getElementById('news-list'),
  macroTable: document.getElementById('macro-table'),
  refreshBtn: document.getElementById('refresh-btn'),
  researchLink: document.getElementById('research-link')
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d)
}

function classifyStatus(raw) {
  if (raw === 'trading') return '交易中'
  if (raw === 'closed') return '休市/非交易时段'
  return raw || '未知'
}

function percent(v) {
  if (v === null || v === undefined) return '—'
  return `${Number(v).toFixed(2)}%`
}

async function getJson(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 401 && body.error === 'AUTH_REQUIRED') {
      clearInvestmentState()
      authUi.showGate()
      throw new Error('访问许可已失效，请重新申请。')
    }
    throw new Error(body.error || `请求失败：${res.status}`)
  }
  return res.json()
}

function clearInvestmentState() {
  state.watchlist = []
  state.selectedCode = null
  state.currentCompany = null
  for (const node of [
    el.watchlist,
    el.searchResults,
    el.companyHead,
    el.marketStatus,
    el.marketData,
    el.thermo,
    el.financeTableWrap,
    el.anomalyList,
    el.breakdownTable,
    el.announcementList,
    el.newsList,
    el.macroTable
  ]) node.replaceChildren()
  el.companyContent.classList.add('hidden')
  el.companyEmpty.classList.remove('hidden')
  el.globalStatus.textContent = '设备访问许可已失效。'
}

function renderGlobalStatus(companiesCount) {
  el.globalStatus.textContent = `看板可运行：当前 mock 数据 ${companiesCount} 家。默认页不展示 AI 投资观点，行情失败将回退最近成功数据。`
}

function renderWatchlistItem(item, list, selectedCode) {
  const card = document.createElement('article')
  card.className = `watchlist-card ${selectedCode === item.securityCode ? 'active' : ''}`
  const stateText = item.refreshState.isTrading ? '交易中' : '已休市'
  card.innerHTML = `
    <h4 class="watchlist-title">${item.nameZh}</h4>
    <p>${item.securityCode} · ${item.market} · ${item.sector || item.industry || ''}</p>
    <p class="muted">行情：${item.quote.lastPrice.toFixed(2)} ${item.quote.currency}，${percent(item.quote.changePct)}（${stateText}）</p>
    <p class="muted">来源：${item.refreshState.marketLabel} / ${item.refreshState.autoRefreshCycleMinutes}分钟</p>
    <p class="hint">下次自动刷新：${formatDateTime(item.refreshState.nextAutoRefreshAt)}</p>
  `
  card.addEventListener('click', () => loadCompany(item.securityCode))
  list.appendChild(card)
}

function renderRefreshHint(refreshState) {
  const lines = [
    `行情时间：${formatDateTime(refreshState.dataSourceTime)}`,
    `缓存状态：${refreshState.fromCache ? '缓存命中' : '新请求结果'}`,
    `市场状态：${classifyStatus(refreshState.marketState)}`,
    `下次自动更新时间：${formatDateTime(refreshState.nextAutoRefreshAt)}`,
    `手动刷新：${refreshState.manualCooldownRemainingSeconds > 0 ? `${refreshState.manualCooldownRemainingSeconds}s后可再刷新` : refreshState.canManualRefresh ? '可立即刷新' : '不满足'}`,
    `每日手动额度：${refreshState.dailyManualUsed}/${refreshState.dailyManualLimit}`
  ]
  return lines.join('｜')
}

function renderCompanyHead(company) {
  el.companyHead.innerHTML = `
    <h2 class="company-title">${company.nameZh}（${company.securityCode}）</h2>
    <p class="muted">行业：${company.industry} ｜ 交易所：${company.market} ｜ 币种：${company.quote.currency}</p>
    <p class="tag meta">数据页标签：原始来源数据 / 确定性计算</p>
  `
}

function renderMarket(company) {
  const { quote, valuation, refreshState } = company
  el.marketStatus.textContent = renderRefreshHint(refreshState)
  el.marketData.innerHTML = `
    <div class="kpi"><div class="kpi-label">最新价</div><div class="kpi-value">${quote.lastPrice.toFixed(2)}</div></div>
    <div class="kpi"><div class="kpi-label">3年高低点</div><div class="kpi-value">${quote.low3Y} ~ ${quote.high3Y}</div></div>
    <div class="kpi"><div class="kpi-label">当前变化</div><div class="kpi-value">${percent(quote.changePct)}</div></div>
    <div class="kpi"><div class="kpi-label">成交量</div><div class="kpi-value">${Number(quote.volume).toLocaleString('zh-CN')}</div></div>
    <div class="kpi"><div class="kpi-label">估值</div><div class="kpi-value">PE ${valuation.pe} ｜ PB ${valuation.pb}</div></div>
    <div class="kpi"><div class="kpi-label">估值位置</div><div class="kpi-value">${valuation.positionIn3Y}</div></div>
  `
  const valuationPosition = valuationContracts.prepareValuationPosition(quote)
  if (!valuationPosition.available) {
    delete el.thermo.dataset.position
    el.thermo.classList.add('unavailable')
    el.thermo.textContent = '估值温度尺：区间不可用'
    return
  }

  el.thermo.classList.remove('unavailable')
  el.thermo.dataset.position = String(valuationPosition.markerPosition)
  el.thermo.textContent = `估值温度尺：${valuationPosition.ratio}%（区间低位/中部/高位）`
}

function renderFinance(company) {
  const prepared = financeContracts.prepareFinanceRows(company.financials, state.financeMode)
  const rows = prepared.rows
  if (prepared.totalCount === 0) {
    el.financeTableWrap.innerHTML = '<p class="muted">当前口径未返回数据。</p>'
    return
  }
  if (!rows.length) {
    el.financeTableWrap.innerHTML = '<p class="muted">该报告期来源口径未验证，未展示数据。</p>'
    return
  }

  const columns = [
    ['revenue', '营业收入'],
    ['grossMargin', '毛利率'],
    ['operatingIncome', '经营利润'],
    ['netIncome', '归母净利润'],
    ['eps', '每股收益'],
    ['cash', '现金及等价物'],
    ['interestBearingDebt', '有息负债'],
    ['netCashFlow', '经营现金流'],
    ['capex', '资本开支'],
    ['fcf', '自由现金流'],
    ['roe', 'ROE'],
    ['netMargin', '净利率'],
    ['debtToAsset', '资产负债率']
  ].filter(([k]) => rows.some((r) => r.values?.[k] !== undefined))

  const header = `<tr>
    <th>期间</th><th>数据身份</th><th>报告日</th><th>币种</th><th>单位</th><th>口径来源</th><th>获取时间</th>
    ${columns.map((item) => `<th>${item[1]}</th>`).join('')}
  </tr>`
  const body = rows.map((r) => {
    const cols = columns.map(([key]) => {
      const value = r.values[key]
      const formatted = typeof value === 'number' ? (Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN')) : '—'
      return `<td>${formatted}</td>`
    }).join('')
    return `<tr>
      <td>${r.period}</td><td>${r.dataMode === 'mock' ? 'Mock（非真实）' : '真实来源（已验）'}</td>
      <td>${r.reportDate}</td><td>${r.currency}</td><td>${r.unit}</td>
      <td>${r.source.sourceName}</td><td>${formatDateTime(r.source.fetchTime)}</td>${cols}
    </tr>`
  }).join('')
  const mockCount = rows.filter((r) => r.dataMode === 'mock').length
  const mockSummary = mockCount > 0 ? `，其中 ${mockCount} 条为 Mock 模拟数据` : ''
  const rejectedSummary = prepared.rejectedCount > 0
    ? `<p class="muted">该报告期来源口径未验证，未展示数据（${prepared.rejectedCount} 条）。</p>`
    : ''

  el.financeTableWrap.innerHTML = `
    <p class="muted">已展示 ${rows.length} 条通过展示契约的财务记录${mockSummary}。</p>
    ${rejectedSummary}
    <table>
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>
  `
}

function renderAnomalies(items) {
  el.anomalyList.innerHTML = items.map((it) => {
    const severityClass = it.triggered ? (it.severity === 'high' ? 'high' : 'warn') : 'info'
    const status = it.triggered ? '触发' : '未触发'
    return `
      <article class="anomaly ${severityClass}">
        <p>
          <span class="tag ${it.triggered ? 'critical' : 'ok'}">${status}</span>
          <span class="tag">规则：${it.rule}</span>
          <span class="tag">版本：${it.version}</span>
        </p>
        <p class="muted">公式：${it.formula}</p>
        <p class="muted">输入：${JSON.stringify(it.input)} ｜ 阈值：${JSON.stringify(it.threshold)}</p>
      </article>
    `
  }).join('')
}

function renderBreakdown(company) {
  const rows = company.businessBreakdown.rows || []
  if (!rows.length) {
    el.breakdownTable.innerHTML = '<p class="muted">分部口径未返回。系统不进行字段映射推算。</p>'
    return
  }
  const header = `<tr>
    <th>维度类型</th><th>维度</th><th>收入</th><th>占比%</th><th>同比%</th><th>毛利率%</th>
  </tr>`
  const body = rows.map((r) => `
    <tr>
      <td>${r.dimensionType}</td><td>${r.dimensionName}</td><td>${r.revenue.toLocaleString('zh-CN')}</td>
      <td>${r.revenueRatioPct}</td><td>${r.yoyPct}</td><td>${r.grossMarginPct}</td>
    </tr>
  `).join('')
  el.breakdownTable.innerHTML = `
    <p class="tag meta">来源：${company.businessBreakdown.sourceName} ｜ 时间：${formatDateTime(company.businessBreakdown.sourceTime)} ｜ 币种：${company.businessBreakdown.currency}</p>
    <table>
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>
  `
}

function renderAnnouncements(items) {
  if (!items.length) {
    el.announcementList.innerHTML = '<p class="muted">未返回公告元数据。</p>'
    return
  }
  el.announcementList.innerHTML = items.map((it) => `
    <article class="watchlist-card">
      <p><strong>${it.title}</strong></p>
      <p class="muted">类型：${it.type} ｜ 日期：${formatDateTime(it.date)} ｜ 发布：${formatDateTime(it.publishTime)}</p>
      <p class="tag meta">来源完整性：${it.integrity.completeness}</p>
      <a href="${it.pdf}" target="_blank" rel="noreferrer">查看公告 PDF</a>
    </article>
  `).join('')
}

function renderNews(items) {
  if (!items.length) {
    el.newsList.innerHTML = '<p class="muted">无授信来源新闻。</p>'
    return
  }
  el.newsList.innerHTML = items.map((it) => `
    <article class="watchlist-card">
      <p><strong>${it.title}</strong></p>
      <p class="muted">来源：${it.source}（${it.sourceLevel}）｜发布时间：${formatDateTime(it.publishTime)}</p>
      <p class="muted">关键词：${(it.matchedKeywords || []).join('，')}</p>
      <p class="tag meta">覆盖范围：${it.coverageRange} ｜ 正文权限：${it.integrity.hasBody ? '可见' : '仅元数据'}</p>
      <a href="${it.link}" target="_blank" rel="noreferrer">原文</a>
    </article>
  `).join('')
}

function renderMacro(list) {
  if (!list.length) {
    el.macroTable.innerHTML = '<p class="muted">未配置宏观映射。</p>'
    return
  }
  const rows = list.map((it) => `
    <tr>
      <td>${it.name}</td>
      <td>${it.currentValue} ${it.unit}</td>
      <td>${formatDateTime(it.sourceTime)}</td>
      <td>${it.source}</td>
    </tr>
  `).join('')
  el.macroTable.innerHTML = `
    <table>
      <thead><tr><th>指标</th><th>值</th><th>来源时间</th><th>来源</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderCompany(company) {
  state.currentCompany = company
  state.selectedCode = company.securityCode
  el.companyEmpty.classList.add('hidden')
  el.companyContent.classList.remove('hidden')

  renderCompanyHead(company)
  const researchLink = /** @type {HTMLAnchorElement} */ (el.researchLink)
  researchLink.href = `/research.html?code=${company.securityCode}`
  renderMarket(company)
  renderFinance(company)
  renderAnomalies(company.anomalies || [])
  renderBreakdown(company)
  renderAnnouncements(company.announcements || [])
  renderNews(company.news || [])
  renderMacro(company.macro || [])
  const refreshButton = /** @type {HTMLButtonElement} */ (el.refreshBtn)
  refreshButton.disabled = !company.refreshState.canManualRefresh
}

function renderSearchResults(items) {
  el.searchResults.innerHTML = ''
  if (!items.length) {
    el.searchResults.innerHTML = '<p class="muted">未匹配到本地索引，默认不返回网页抓取结果。</p>'
    return
  }
  items.forEach((item) => {
    const row = document.createElement('article')
    row.className = 'watchlist-card'
    const aliases = Array.isArray(item.formatAliases) && item.formatAliases.length
      ? ` · 格式别名 ${item.formatAliases.join('、')}`
      : ''
    const availability = item.configured === false ? ' · 未收录' : ''
    row.innerHTML = `<p><strong>${item.nameZh}（${item.securityCode}）</strong></p><p class="muted">${item.market} · ${item.symbol || ''}${aliases}${availability}</p>`
    if (item.configured !== false) {
      row.addEventListener('click', () => loadCompany(item.securityCode))
    } else {
      row.setAttribute('aria-disabled', 'true')
    }
    el.searchResults.appendChild(row)
  })
}

async function loadWatchlist() {
  const data = await getJson('/api/watchlist')
  state.watchlist = data.data
  el.watchlist.innerHTML = ''
  data.data.forEach((item) => {
    renderWatchlistItem(item, el.watchlist, state.selectedCode)
  })
  renderGlobalStatus(data.data.length)
}

async function loadCompany(code) {
  const data = await getJson(`/api/company/${code}`)
  state.currentCompany = data.data
  renderCompany(data.data)
  document.querySelectorAll('.watchlist-card').forEach((elNode) => {
    if (elNode.textContent.includes(code)) {
      elNode.classList.add('active')
    } else {
      elNode.classList.remove('active')
    }
  })
}

async function doRefresh() {
  if (!state.currentCompany) return
  try {
    const data = await getJson(`/api/company/${state.currentCompany.securityCode}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    if (data.success) {
      renderCompany(data.data)
      await loadWatchlist()
    }
  } catch (err) {
    alert(err.message || '刷新失败')
  }
}

function bindEvents() {
  el.searchBtn.addEventListener('click', async () => {
    const q = /** @type {HTMLInputElement} */ (el.searchInput).value.trim()
    if (!q) {
      el.searchResults.innerHTML = ''
      return
    }
    const data = await getJson(`/api/search?q=${encodeURIComponent(q)}`)
    renderSearchResults(data.data)
  })

  el.searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      el.searchBtn.click()
    }
  })

  el.refreshBtn.addEventListener('click', doRefresh)

  el.financeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      el.financeButtons.forEach((x) => x.classList.remove('active'))
      btn.classList.add('active')
      state.financeMode = /** @type {HTMLElement} */ (btn).dataset.tab
      if (state.currentCompany) {
        renderFinance(state.currentCompany)
      }
    })
  })
}

async function bootstrap() {
  const authStatus = authContracts.normalizeAuthStatus(
    await getJson('/api/auth/status', { credentials: 'same-origin' })
  )
  if (!authStatus.authorized) {
    authUi.showGate()
    return
  }
  authUi.showDashboard()
  bindEvents()
  await loadWatchlist()
  if (state.watchlist[0]) {
    await loadCompany(state.watchlist[0].securityCode)
  } else {
    el.companyEmpty.textContent = '关注清单为空：请先搜索并手动添加公司。'
  }
}

bootstrap().catch(() => {
  authUi.showUnavailable()
})

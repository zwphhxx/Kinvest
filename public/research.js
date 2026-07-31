const params = new URLSearchParams(window.location.search)
const requestedCode = params.get('code') || '9988.HK'

function byId(id) {
  return document.getElementById(id)
}

function appendTextElement(parent, tagName, text, className = '') {
  const element = document.createElement(tagName)
  element.textContent = text
  if (className) element.className = className
  parent.appendChild(element)
}

function renderList(elementId, items) {
  const list = byId(elementId)
  list.replaceChildren()
  for (const item of items) {
    appendTextElement(list, 'li', item)
  }
}

function getResearchContracts() {
  const contracts = /** @type {any} */ (window).KinvestResearch
  const valid = contracts &&
    typeof contracts.normalizeResearchResponse === 'function' &&
    typeof contracts.normalizeSecurityCode === 'function' &&
    typeof contracts.parseJsonResponse === 'function'
  if (!valid) {
    throw new Error('研究页面依赖加载失败')
  }
  return contracts
}

async function safeGet(url, contracts, options = {}) {
  const response = await fetch(url, options)
  return contracts.parseJsonResponse(response)
}

function renderUnavailable(message) {
  byId('research-header').textContent = message
  byId('research-body').classList.add('hidden')
}

async function loadResearch() {
  const researchContracts = getResearchContracts()
  const code = researchContracts.normalizeSecurityCode(requestedCode)
  if (!code) {
    renderUnavailable('证券代码格式无效')
    return
  }

  const payload = await safeGet(`/api/research/${encodeURIComponent(code)}`, researchContracts)
  const normalized = researchContracts.normalizeResearchResponse(payload)
  if (!normalized.ok) {
    renderUnavailable(normalized.message)
    return
  }

  const research = normalized.data
  byId('research-header').textContent = `${research.nameZh || code} · 版本 ${research.version} · 数据快照 ${new Date(research.snapshotTime).toLocaleString('zh-CN')}`
  byId('research-body').classList.remove('hidden')

  const meta = byId('research-meta')
  meta.replaceChildren()
  appendTextElement(meta, 'p', `生成时间：${new Date(research.generatedAt).toLocaleString('zh-CN')}`, 'muted')
  appendTextElement(meta, 'p', `引用公告：${research.citedAnnouncementsCount} 条｜引用资讯：${research.citedNewsCount} 条`, 'muted')
  appendTextElement(meta, 'p', `标签：${research.tags.join(' / ')}`, 'tag ai')

  byId('thesis').textContent = research.sections.thesis
  renderList('bulls', research.sections.bulls)
  renderList('bears', research.sections.bears)

  const catalysts = byId('catalysts')
  catalysts.replaceChildren()
  appendTextElement(catalysts, 'p', `催化剂：${research.sections.catalysts.join('；')}`, 'muted')
  appendTextElement(catalysts, 'p', `待证伪：${research.sections.invalidation.join('；')}`, 'muted')

  byId('invalidation').textContent = research.sections.invalidation.join('；')
  const backLink = /** @type {HTMLAnchorElement} */ (byId('back-link'))
  backLink.href = `/?code=${encodeURIComponent(code)}#company-content`
}

loadResearch().catch((err) => {
  renderUnavailable(`加载失败：${err.message}`)
})

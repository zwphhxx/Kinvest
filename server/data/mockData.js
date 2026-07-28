const now = new Date('2026-07-28T15:42:00.000Z')

const watchlist = [
  '09888.HK',
  'AAPL.US'
]

function mkPeriod(type, period, fields) {
  return {
    periodType: type,
    period,
    source: {
      sourceName: fields.sourceName,
      sourceTime: new Date(fields.sourceTime),
      fetchTime: new Date(fields.fetchTime)
    },
    currency: fields.currency,
    unit: fields.unit,
    reportDate: fields.reportDate,
    values: fields.values
  }
}

const companies = [
  {
    securityCode: '09888.HK',
    isin: 'CHN09888HK',
    market: 'HK',
    symbol: 'BABA',
    nameZh: '阿里巴巴',
    industry: '互联网',
    sector: '消费互联网',
    homepage: 'https://www.alibabagroup.com',
    pricingSource: 'iFinD Realtime',
    watchReasons: ['家庭关注清单', 'AI 观点不展示于默认页'],
    marketSnapshot: {
      sourceTime: new Date('2026-07-28T15:38:00.000Z'),
      fetchedAt: new Date('2026-07-28T15:40:10.000Z'),
      lastSuccessAt: new Date('2026-07-28T15:40:10.000Z'),
      lastManualRefreshAt: new Date('2026-07-28T15:38:30.000Z'),
      dailyManualCount: 12,
      dailyManualLimit: 100,
      fromCache: true,
      isOpen: true,
      nextAutoRefreshAt: new Date('2026-07-28T15:48:00.000Z')
    },
    quote: {
      lastPrice: 91.6,
      currency: 'HKD',
      changePct: -1.72,
      volume: 1531200,
      high3Y: 124.4,
      low3Y: 56.3,
      latestHighDate: new Date('2026-06-01'),
      latestLowDate: new Date('2026-01-20')
    },
    valuation: {
      pe: 22.8,
      pb: 1.9,
      ps: 1.8,
      peg: 0.9,
      positionIn3Y: 'near_mid',
      priceRange3Y: {
        min: 56.3,
        max: 124.4,
        median: 89.1
      }
    },
    financials: {
      annual: [
        mkPeriod('annual', '2024', {
          sourceName: 'iFinD company 指标',
          sourceTime: '2026-07-27T20:13:00.000Z',
          fetchTime: '2026-07-28T03:10:00.000Z',
          currency: 'HKD',
          unit: '百万元',
          reportDate: '2026-03-31',
          values: {
            revenue: 129000,
            grossMargin: 27.9,
            operatingIncome: 21000,
            netIncome: 12000,
            eps: 3.2,
            netCashFlow: 8400,
            capex: 3200,
            fcf: 5200,
            opex: 6200,
            roe: 11.5,
            roc: 8.4,
            netMargin: 9.3,
            debtToAsset: 42.0
          }
        }),
        mkPeriod('annual', '2025', {
          sourceName: 'iFinD company 指标',
          sourceTime: '2026-07-27T20:13:00.000Z',
          fetchTime: '2026-07-28T03:10:00.000Z',
          currency: 'HKD',
          unit: '百万元',
          reportDate: '2025-03-31',
          values: {
            revenue: 128000,
            grossMargin: 29.6,
            operatingIncome: 19000,
            netIncome: 11200,
            eps: 3.1,
            netCashFlow: 9000,
            capex: 2700,
            fcf: 6300,
            opex: 6000,
            roe: 11.1,
            roc: 8.1,
            netMargin: 8.8,
            debtToAsset: 41.1
          }
        })
      ],
      quarterly: [
        mkPeriod('quarter', '2026-Q1', {
          sourceName: 'iFinD company 指标',
          sourceTime: '2026-07-27T20:13:00.000Z',
          fetchTime: '2026-07-28T03:10:00.000Z',
          currency: 'HKD',
          unit: '百万元',
          reportDate: '2026-03-31',
          values: {
            revenue: 32500,
            grossMargin: 29.1,
            operatingIncome: 4700,
            netIncome: 3100,
            eps: 2.9,
            netCashFlow: 2200,
            capex: 850,
            fcf: 1350
          }
        })
      ]
    },
    businessBreakdown: {
      sourceName: 'iFinD data-pool 经营构成报表（已验）',
      sourceTime: new Date('2026-07-24T12:00:00.000Z'),
      unit: '百万元',
      currency: 'HKD',
      rows: [
        {
          dimensionType: '产品',
          dimensionName: '本地生活',
          revenue: 62000,
          revenueRatioPct: 48.1,
          yoyPct: -4.2,
          grossProfit: 17800,
          grossMarginPct: 28.7,
          cost: 44200
        },
        {
          dimensionType: '产品',
          dimensionName: '云智能',
          revenue: 39000,
          revenueRatioPct: 30.2,
          yoyPct: 9.6,
          grossProfit: 13100,
          grossMarginPct: 33.6,
          cost: 25900
        },
        {
          dimensionType: '区域',
          dimensionName: '中国',
          revenue: 93000,
          revenueRatioPct: 72.1,
          yoyPct: -1.1,
          grossProfit: 26000,
          grossMarginPct: 28.0,
          cost: 67000
        }
      ]
    },
    anomalies: [
      {
        rule: '收入与利润背离',
        severity: 'warn',
        version: 'v2026-07-28-r1',
        formula: '收入增速 -3.2%，净利润增速 -4.8%，偏离幅度 1.6pp',
        input: { revenueGrowth: -3.2, netProfitGrowth: -4.8 },
        threshold: { maxDeltaPpt: 0.5 },
        triggered: false,
        note: '数据不完全等于利好或利空，需结合现金流与现金分配结构复核。'
      },
      {
        rule: '毛利率骤变',
        severity: 'warn',
        version: 'v2026-07-28-r1',
        formula: '|本期毛利率-上期毛利率| > 3.0%',
        input: { currentGrossMargin: 27.9, priorGrossMargin: 29.6, deltaPpt: -1.7 },
        threshold: { maxDeltaPpt: 3 },
        triggered: false,
        note: '与行业规则版本一致，仅给出规则和偏离，不输出投资结论。'
      },
      {
        rule: '经营现金流与净利背离',
        severity: 'high',
        version: 'v2026-07-28-r1',
        formula: '经营现金流 / 净利润 < 0.85',
        input: { cfo: 8400, netIncome: 12000, ratio: 0.7 },
        threshold: { minRatio: 0.85 },
        triggered: true,
        note: '持续偏离，可能说明利润质量与现金回收压力，需要观察应收账款与库存。'
      },
      {
        rule: '应收/存货异常',
        severity: 'info',
        version: 'v2026-07-28-r1',
        formula: '应收+存货同比增速 > 收入同比增速 + 10pp',
        input: { arYoY: 12.6, invYoY: 5.3, revenueYoY: -3.2 },
        threshold: { maxDeltaPpt: 10 },
        triggered: true,
        note: '缺失完整库存序列时标注“部分缺失”；当前为“部分可判断”。'
      }
    ],
    announcements: [
      {
        date: new Date('2026-06-30T00:00:00.000Z'),
        publishTime: new Date('2026-06-30T06:24:00.000Z'),
        code: '09888.HK',
        title: '年度业绩公告（暂不含摘要）',
        type: '年度业绩',
        pdf: 'https://example.local/announcements/09888-2026-annual.pdf',
        integrity: { requested: true, fetched: true, completeness: 'partial' },
        source: 'iFinD公告'
      },
      {
        date: new Date('2026-06-15T00:00:00.000Z'),
        publishTime: new Date('2026-06-15T07:10:00.000Z'),
        code: '09888.HK',
        title: '监管及股份流通公告',
        type: '监管',
        pdf: 'https://example.local/announcements/09888-compliance.pdf',
        integrity: { requested: true, fetched: true, completeness: 'full' },
        source: '交易所'
      }
    ],
    news: [
      {
        publishTime: new Date('2026-07-20T08:10:00.000Z'),
        source: '监管披露站',
        sourceLevel: '官方',
        title: '阿里发布 2026Q1 经营提示信息',
        matchedKeywords: ['阿里巴巴', '电商', '现金流'],
        link: 'https://example.local/news/2026-07-20-1',
        coverageRange: '近 30 天',
        integrity: { coverage: '授权源', hasBody: false, deduplicated: true }
      },
      {
        publishTime: new Date('2026-07-18T12:00:00.000Z'),
        source: 'A 股主流资讯',
        sourceLevel: '主流',
        title: '行业研究：中美消费与云服务投资趋势',
        matchedKeywords: ['消费', '云服务'],
        link: 'https://example.local/news/2026-07-18-2',
        coverageRange: '近 90 天',
        integrity: { coverage: '授权源', hasBody: true, deduplicated: true }
      }
    ],
    macro: [
      {
        name: '恒生指数',
        source: '官方宏观序列',
        currentValue: 21340.6,
        period: '日度',
        sourceTime: new Date('2026-07-28'),
        fetchedAt: new Date('2026-07-28T15:10:00.000Z'),
        unit: '点'
      },
      {
        name: '香港利率',
        source: '央行公开序列',
        currentValue: 2.75,
        period: '周度',
        sourceTime: new Date('2026-07-24'),
        fetchedAt: new Date('2026-07-28T15:10:00.000Z'),
        unit: '%'
      }
    ],
    research: {
      generatedAt: new Date('2026-07-21T10:30:00.000Z'),
      version: 'v1',
      state: 'ready',
      tags: ['AI生成', '快照绑定'],
      snapshotTime: new Date('2026-07-28T10:20:00.000Z'),
      citedAnnouncementsCount: 2,
      citedNewsCount: 1,
      viewUrl: '/research.html?code=09888.HK'
    },
    researchCandidates: {
      includedAnnouncements: 2,
      skippedAnnouncements: 1,
      includedNews: 2,
      skippedNews: 3
    }
  },
  {
    securityCode: 'AAPL.US',
    isin: 'US0378331005',
    market: 'US',
    symbol: 'AAPL',
    nameZh: '苹果公司',
    industry: '硬件与服务',
    sector: '消费电子',
    watchReasons: ['关注品牌端增长与现金回收'],
    pricingSource: 'iFinD Realtime',
    marketSnapshot: {
      sourceTime: new Date('2026-07-28T07:40:00.000Z'),
      fetchedAt: new Date('2026-07-28T07:42:00.000Z'),
      lastSuccessAt: new Date('2026-07-28T07:42:00.000Z'),
      lastManualRefreshAt: new Date('2026-07-28T05:10:00.000Z'),
      dailyManualCount: 2,
      dailyManualLimit: 100,
      fromCache: true,
      isOpen: false,
      nextAutoRefreshAt: new Date('2026-07-28T13:40:00.000Z')
    },
    quote: {
      lastPrice: 198.2,
      currency: 'USD',
      changePct: 0.84,
      volume: 482901,
      high3Y: 240.9,
      low3Y: 121.4,
      latestHighDate: new Date('2026-05-20'),
      latestLowDate: new Date('2026-02-09')
    },
    valuation: {
      pe: 29.1,
      pb: 44.3,
      ps: 6.1,
      peg: 1.4,
      positionIn3Y: 'mid',
      priceRange3Y: {
        min: 121.4,
        max: 240.9,
        median: 186.6
      }
    },
    financials: {
      annual: [
        mkPeriod('annual', '2025', {
          sourceName: 'iFinD company 指标',
          sourceTime: '2026-07-27T20:13:00.000Z',
          fetchTime: '2026-07-28T03:10:00.000Z',
          currency: 'USD',
          unit: '百万美元',
          reportDate: '2025-12-31',
          values: {
            revenue: 385000,
            grossMargin: 38.7,
            operatingIncome: 112000,
            netIncome: 96000,
            eps: 6.2,
            netCashFlow: 110000,
            capex: 10900,
            fcf: 99100,
            opex: 76000,
            roe: 29.8,
            roc: 27.4,
            netMargin: 24.9,
            debtToAsset: 28.2
          }
        })
      ],
      quarterly: []
    },
    businessBreakdown: {
      sourceName: 'iFinD data-pool 经营构成报表（部分可用）',
      sourceTime: new Date('2026-07-24T12:00:00.000Z'),
      unit: '百万美元',
      currency: 'USD',
      rows: [
        {
          dimensionType: '产品',
          dimensionName: 'iPhone',
          revenue: 190000,
          revenueRatioPct: 49.4,
          yoyPct: 2.1,
          grossProfit: 79000,
          grossMarginPct: 41.6,
          cost: 111000
        },
        {
          dimensionType: '产品',
          dimensionName: '服务',
          revenue: 95000,
          revenueRatioPct: 24.7,
          yoyPct: 8.4,
          grossProfit: 61000,
          grossMarginPct: 64.2,
          cost: 34000
        }
      ]
    },
    anomalies: [
      {
        rule: '债务与利息压力',
        severity: 'info',
        version: 'v2026-07-28-r1',
        formula: '有息负债增长率 > 营业收入增长率 + 5%',
        input: { debtGrowth: 1.8, revenueGrowth: 2.2 },
        threshold: { marginPpt: 5 },
        triggered: false,
        note: '当前版本不触发该项。'
      }
    ],
    announcements: [],
    news: [],
    macro: [],
    research: { state: 'not_requested' },
    researchCandidates: { includedAnnouncements: 0, skippedAnnouncements: 0, includedNews: 0, skippedNews: 0 }
  }
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function getCompany(code) {
  return companies.find(item => item.securityCode === code) || null
}

function getWatchlist() {
  return watchlist.slice()
}

function listCompanies() {
  return companies.map(item => ({
    securityCode: item.securityCode,
    nameZh: item.nameZh,
    symbol: item.symbol,
    market: item.market,
    industry: item.industry
  }))
}

function applyManualRefresh(company) {
  const snapshot = clone(company.marketSnapshot)
  const lastManual = new Date(snapshot.lastManualRefreshAt || now)
  snapshot.lastManualRefreshAt = new Date(now)
  snapshot.fetchedAt = new Date(now)
  snapshot.sourceTime = new Date(now)
  snapshot.lastSuccessAt = new Date(now)
  snapshot.fromCache = false
  snapshot.dailyManualCount = (snapshot.dailyManualCount || 0) + 1
  snapshot.lastError = null
  return snapshot
}

function getServerNow() {
  return new Date()
}

module.exports = {
  now,
  getWatchlist,
  listCompanies,
  getCompany,
  applyManualRefresh,
  getServerNow
}

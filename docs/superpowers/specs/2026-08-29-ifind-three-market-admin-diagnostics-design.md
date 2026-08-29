# Kinvest iFinD 三市场管理员真实数据诊断设计

## 1. 目标与范围

本设计在已经通过生产验证的 iFinD 双级基础诊断之上，增加港股、美股和 A 股各一个管理员限定的真实行情与财务指标案例。首批固定案例为：

| 市场模板 | 参考公司 | Kinvest 展示代码 |
|---|---|---|
| `HK_EQUITY_V1` | 阿里巴巴集团 | `9988.HK` |
| `US_EQUITY_V1` | Apple Inc. | `AAPL.US` |
| `CN_EQUITY_V1` | 贵州茅台酒股份有限公司 | `600519.SH` |

首阶段只在管理员页面显示真实结果。家庭看板继续使用 Mock，不读取管理员诊断快照，也不因为某个参考案例成功而自动开放任何真实数据。

长期方向采用“固定市场查询模板 + 管理员维护的已验证公司清单”。固定的是允许调用的 iFinD 路由、指标集合和市场口径；公司清单在完成发行人、供应商代码、权限、币种、单位和报告期验证后可以扩展。

## 2. 非目标

- 不提供任意 iFinD 路径、证券代码、指标 ID 或请求参数代理。
- 不提供“一键运行全部市场”。
- 不在首阶段开放家庭真实数据、后台自动刷新或批量公司查询。
- 不引入新的 Secret、CAM、SSM、TCR、模型调用或第三方数据源。
- 不猜测 iFinD 供应商代码、行情字段或财务指标 ID。
- 不进行跨币种换算、季度年化、缺失值推算或 Mock 回填。
- 不保存 iFinD 原始完整响应、请求头、`errmsg` 或 RequestId。

## 3. 官方接口依据

首批真实查询只允许以下官方 HTTP 路由：

| 用途 | HTTP 路由 |
|---|---|
| 获取临时访问令牌 | `/api/v1/get_access_token` |
| 实时行情 | `/api/v1/real_time_quotation` |
| 公司与财务指标 | `/api/v1/basic_data_service` |

参考资料：

- [iFinD HTTP 接口帮助中心](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)
- [iFinD HTTP 官方示例](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html)
- [Kinvest iFinD 管理员基础诊断契约](../../operations/ifind-admin-diagnostic-contract.md)

所有供应商指标 ID 必须先在 iFinD 官方指标查询工具或明确的官方文档中验证。验证记录至少包含指标名称、指标 ID、适用市场、定义、单位说明、查询日期和验证人，不包含账户标识或凭据。

## 4. 分阶段架构

### 4.1 R1：三市场参考案例诊断

R1 新增三个固定案例、市场专属解析器、管理员 API、SQLite 诊断快照和三张独立诊断卡片。每次管理员操作只执行一个案例。

R1 的真实结果不会进入现有 `/api/watchlist`、`/api/search`、`/api/company/*` 或家庭页面。

本规格之后创建的首份实施计划只覆盖 R1。R2、R3 和 R4 必须分别经过新的设计复核、实施计划和用户批准，不得借 R1 的总体批准提前实现或上线。

### 4.2 R2：已验证公司准入

R2 新增管理员候选公司和已验证公司注册表。管理员为候选公司选择一个固定市场模板，验证发行人身份和 iFinD 代码后，运行行情与财务最小查询。只有全部必要状态通过后，才能批准进入已验证公司清单。

### 4.3 R3：家庭真实数据读取

R3 允许获批家庭设备搜索已验证公司并读取家庭缓存。行情块和财务块分别标记 `real` 或 `unavailable`。任一真实块都不能包含 Mock 字段；真实字段缺失时显示缺失或不可用。

### 4.4 R4：后台刷新与真实经营信号

R4 在口径稳定后增加单实例后台刷新，并允许确定性经营异常信号使用通过验证的真实财务输入。未验证指标不得进入异常信号计算。

## 5. 组件边界

### 5.1 基础认证客户端

现有 iFinD 基础诊断继续只负责“refresh token 换取 access token + 固定交易日探针”。三市场诊断复用其受限 HTTPS transport、安全错误和 Buffer 清零机制，但不把基础 `diagnose()` 扩展为万能调用。

新建受限会话组件，职责为：

1. 从现有 iFinD tmpfs provider 取得 refresh token 的防御性副本。
2. 获取只在本次操作内有效的 access token。
3. 只向固定 origin 和固定路由发送模板构造的请求。
4. 在退出、失败、SIGTERM 或 SIGINT 时清零临时 token Buffer。

### 5.2 市场案例注册表

R1 注册表只包含固定 `caseId`，浏览器不能修改其内容：

```text
HK_ALIBABA_9988
US_APPLE_AAPL
CN_MOUTAI_600519
```

每个案例绑定：

```text
caseId
marketTemplateId
expectedIssuerLegalName
listingId
displayCode
vendorCode
quoteIndicatorIds
financeIndicatorIds
expectedTradingCurrency
marketTimeZone
enabled
```

在供应商代码或指标完成验证前，对应值保持 `null` 或状态 `unverified`，案例不可执行真实调用。

### 5.3 市场专属解析器

三个解析器共享结果类型，但分别验证供应商响应：

- `HK_EQUITY_V1` 验证港股代码、HKD、香港时区和停牌状态，不假设存在人民币柜台。
- `US_EQUITY_V1` 验证美股代码、USD、纽约交易时区和财年口径，首期排除盘前盘后行情。
- `CN_EQUITY_V1` 验证上交所代码、CNY、上海时区和停复牌状态；成交量单位必须来自已验证定义。

解析器只接受预期字段集合。额外字段可以丢弃，但不能自动加入输出；关键字段缺失、类型错误或口径冲突时，对应数据块失败关闭。

### 5.4 诊断服务

诊断服务负责额度预占、全局互斥、调用编排、快照提交和安全错误映射。行情与财务是两个独立数据块：一个成功、另一个失败时，运行结果为 `partial`，成功块仍可在管理员页面显示。

### 5.5 管理员 UI

现有双级基础诊断卡片保持不变。其下增加港股、美股和 A 股三张独立卡片。每张卡片只运行本案例，不提供批量按钮。

## 6. 行情数据契约

三个市场统一输出：

```text
listingId
vendorCode
market
latestPrice
previousClose
open
high
low
volume
turnover
quoteTime
marketStatus
tradingCurrency
retrievedAt
dataVol
completeness
```

约束：

- `quoteTime` 保存供应商时间和解析后的 IANA 时区语义。
- `tradingCurrency` 必须与模板预期一致，否则返回 `CURRENCY_MISMATCH`。
- `volume` 和 `turnover` 只有在单位经过验证时才展示。
- 价格字段不能把空值、无效字符串或非有限数字转换为零。
- 首期美股不接收盘前盘后价格作为 `latestPrice`。
- 实时行情不进行前复权或后复权转换。

## 7. 财务数据契约

首批财务字段为：

```text
revenue
grossProfit
netProfitAttributable
operatingCashFlow
accountsReceivable
inventory
interestBearingDebt
```

每个财务数据点必须同时保存：

```text
indicatorId
originalLabel
value
currency
unit
periodStart
periodEnd
fiscalYear
periodType
accountingStandard
consolidationScope
restated
```

报告期范围固定为最近两个完整年度和最近一个已披露中期报告。年度、中报和季度分别保存，不进行自动年化或跨期拼接。

口径规则：

- 美股财年不强制等于自然年。
- 港股披露币种与交易币种分别验证，不能因为股票以 HKD 交易而假设财报也以 HKD 披露。
- A 股财务指标使用验证后的 CNY 单位和中国会计报告期。
- 毛利缺失时不使用收入减成本自动推算。
- 有息债务只有在指标定义明确覆盖范围后才展示。
- 供应商返回重述数据时保留 `restated`，不静默覆盖口径。
- 不进行 HKD、USD、CNY 的换算。

## 8. 验证状态

每个案例和数据块使用以下状态：

```text
issuerIdentityStatus
vendorCodeStatus
entitlementStatus
currencyStatus
unitStatus
reportPeriodStatus
scopeStatus
sourceMode
```

状态值为：

```text
unverified | verified | failed | not_applicable
```

真实数据块必须满足：

- `sourceMode=real`。
- 发行人、供应商代码和权限为 `verified`。
- 该块涉及的币种、单位、报告期和范围状态为 `verified`。
- 块内没有任何 `mock` 来源或 Mock 值。

## 9. 管理员 HTTP 契约

R1 新增：

| 接口 | 行为 |
|---|---|
| `GET /api/admin/ifind/market-cases` | 返回三个案例及最近状态 |
| `GET /api/admin/ifind/market-cases/:caseId` | 返回一个案例最近的规范化快照 |
| `POST /api/admin/ifind/market-cases/:caseId/run` | 执行一次固定案例诊断 |

所有接口要求有效管理员会话。POST 还必须满足：

- 同源 `Origin`。
- 有效 CSRF token。
- `Content-Type: application/json`。
- 请求体精确等于 `{}`。
- `caseId` 属于固定集合。

网页不得提交 iFinD 路径、证券代码、供应商代码、指标 ID、日期、币种、单位或报告期参数。

## 10. 调用、额度与并发

一次案例诊断的正常调用顺序为：

1. 获取 access token。
2. 请求固定实时行情。
3. 请求固定财务指标。
4. 分别解析和验证两个数据块。
5. 原子保存诊断快照。
6. 清零 access token Buffer。

初始限制：

| 控制项 | 限制 |
|---|---:|
| 全局真实案例并发 | 1 |
| 每案例冷却 | 5 分钟 |
| 每案例每日运行上限 | 5 次 |
| 三市场每日总运行上限 | 12 次 |
| 单次最大 iFinD HTTP 请求 | 5 次 |
| 单请求总超时 | 5 秒 |
| 单响应正文上限 | 256 KiB |

失败、认证重试和供应商拒绝都计入请求次数和每日尝试额度。只有 access token 明确失效时允许重新认证一次；其他错误不自动重试。官方剩余额度不可用时必须显示 `unavailable`，不能根据本地计数伪造供应商额度。

## 11. SQLite 快照

R1 使用 expand-only 迁移新增三组表：

```text
ifind_market_case_runs
ifind_market_quote_snapshots
ifind_market_financial_points
```

`ifind_market_case_runs` 保存：

```text
runId
caseId
status
quoteStatus
financeStatus
requestCount
dataVol
elapsedMs
failureCode
createdAt
completedAt
```

行情表每次运行最多保存一个规范化行情块。财务表按 `runId + indicatorId + periodEnd + periodType` 保存数据点。

数据库不保存 refresh token、access token、请求头、原始完整响应、`errmsg`、RequestId 或供应商调试文本。R1 不把这些表接入家庭 API。

旧镜像可以忽略新增表，因此正常镜像回滚不需要恢复数据库；迁移前仍沿用现有一致性备份和联合部署状态。

## 12. 错误与完整度

稳定安全分类为：

```text
AUTH
PERMISSION
INDICATOR
QUOTA
NETWORK
API
RESPONSE_SHAPE
IDENTITY_CONFLICT
CURRENCY_MISMATCH
UNIT_UNVERIFIED
PERIOD_UNVERIFIED
```

页面只显示安全分类、失败阶段、稳定 Kinvest 错误码和允许保留的数字供应商错误码。不得显示供应商文本、响应正文、token、RequestId 或嵌套异常 cause。

运行完整度为：

```text
complete | partial | failed
```

- 行情和财务都通过时为 `complete`。
- 仅一个数据块通过时为 `partial`。
- 身份冲突、供应商代码冲突、数据库提交失败或两个数据块都失败时为 `failed`。
- 数据库写入必须原子化，不能发布半写入快照。

## 13. 管理员页面

每张案例卡片显示：

- 公司、市场、展示代码和供应商代码验证状态。
- 行情与财务两个独立状态。
- 币种、单位、报告期和完整度。
- 最近执行时间、请求次数、`dataVol` 和冷却时间。
- “运行该案例诊断”按钮。

缺失值显示“未披露”或“不可用”，不显示为零。所有公司名称、指标名称和错误文本使用文本节点渲染，不使用 `innerHTML`。

## 14. 测试策略

CI 不调用真实 iFinD，只使用合成 fixture。真实响应不得复制进仓库。

自动化测试覆盖：

- 港股 HKD、香港时间、停牌、缺失成交额和错误代码。
- 美股 USD、纽约时间、非自然财年和盘前盘后字段排除。
- A 股 CNY、上海时间、停复牌和未验证成交量单位。
- 年报、中报、季度、重述、缺失毛利、未知币种和未知单位。
- 三个固定发行人、展示代码、格式别名和供应商代码冲突。
- `real` 数据块不能包含 Mock 字段。
- 管理员认证、CSRF、Origin、JSON、非法 `caseId` 和超长请求。
- 单案例冷却、每日上限、全局上限、全局互斥和失败计费。
- token、响应正文、`errmsg` 和 RequestId 不进入响应、日志或 SQLite。
- expand-only SQLite 迁移和旧镜像兼容。
- 三张卡片独立执行、部分成功、冷却、缺失值和手机布局。

## 15. 上线门

### 15.1 指标发现门

在 iFinD 官方指标查询工具中确认三个市场的供应商代码、行情字段和财务指标 ID。未经验证的案例保持不可执行。

### 15.2 安全契约 PR

实现模板、解析器、快照、管理员 API 和 UI。真实案例执行开关默认关闭。

### 15.3 禁用态生产基线

离线导入精确镜像并部署，验证家庭登录、设备审批、基础双级诊断、SQLite、tmpfs 和 Mock 家庭页面无回归。

### 15.4 逐市场启用

港股、美股和 A 股分别启用并各运行一次。每个市场的真实调用都需要新的用户明确批准，不批量执行。

### 15.5 口径验收

逐市场核对供应商代码、发行人、币种、单位、财年、报告期、权限和完整度。失败市场保持禁用，不阻塞其他市场。

### 15.6 R1 收尾

恢复生产部署开关为 `false`。家庭页面继续使用 Mock，只在管理员页面保留真实诊断结果。

## 16. 失败与回滚

- 行情失败时允许保存通过验证的财务块，行情块标记不可用。
- 财务失败时允许保存通过验证的行情块，财务块标记不可用。
- 身份、供应商代码或币种冲突时整个案例失败关闭。
- 数据库提交失败时不发布快照。
- 新镜像异常时按现有联合状态回滚上一精确镜像。
- 真实案例失败不会关闭基础双级诊断，也不会影响家庭 Mock 页面。
- 不使用长期 SecretId、SecretKey 或服务器持久明文 token 作为故障绕过。

## 17. 验收标准

- 三个案例只能由管理员分别运行。
- 浏览器无法提交任意证券、路由、指标或查询参数。
- 三个市场分别验证代码、币种、时区、单位和报告期。
- 行情和财务可以独立成功或失败，部分结果不会混入 Mock。
- 单次运行、冷却、每日额度和全局互斥均无法穿透。
- 真实 token、原始响应和供应商文本不出现在网页、日志、SQLite、状态文件或仓库。
- 管理员快照不被任何家庭 API 读取。
- 部署后基础双级诊断、家庭登录、设备审批和 Mock 看板无回归。
- R1 完成时至少一个逐市场案例成功不代表其他市场或任意公司已获授权。

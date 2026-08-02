# Kinvest 设备审批安全契约

## 当前范围

本阶段只实现可测试的本地安全契约和 SQLite 数据访问层。Secret Provider
当前仅有使用合成测试值的 Mock 实现，不访问腾讯云 SSM，不读取环境变量，也不
包含任何真实秘密。

本阶段没有新增 HTTP 路由。服务返回设置设备 Cookie 所需的 token、轮换状态和
`Secure`、`HttpOnly`、`SameSite=Strict` 属性契约，但尚未实际发送 Cookie。

## Secret Provider

- `SecretName` 必须匹配 `[A-Za-z0-9_-]`，长度为 1 至 128。
- `VersionId` 必须匹配 `[A-Za-z0-9_.-]`，长度为 1 至 64。
- 每次读取都必须同时提供合法的 `SecretName` 和显式 `VersionId`。
- 不实现 `current`、`previous` 或其他隐式版本指针。
- Mock Provider 只接受调用方提供的合成测试值；非法或不存在的引用稳定失败。
- 验证设备 token 时按 VersionId 缓存读取。一个有效版本缺失只跳过该版本，其他
  版本仍可验证；最终无法匹配且至少一个候选版本缺失时，统一返回不含名称、
  VersionId 或秘密值的 `TOKEN_KEY_UNAVAILABLE`，供后续 HTTP 层映射为 503。
- 错误、审计记录和数据库均不得包含秘密值。

## 申请与审批

- 创建申请时生成 256-bit 浏览器申请凭证。
- 短申请码有效 10 分钟，最多尝试 5 次，锁定后不能继续审批。
- 六位申请码使用 Node 内置 `scryptSync`、固定域分离字符串和每记录
  `requestId` salt 派生 32 字节摘要，并用 timing-safe comparison 校验；SQLite
  只保存该摘要和浏览器申请凭证哈希。
- 审批调用必须显式声明 `adminAuthenticated=true`。
- 未过期的已批准申请在申请码校验前幂等返回成功；审批后超过原 10 分钟申请期
  仍返回 `REQUEST_EXPIRED`。失败计数 SQL 只更新尚未批准的申请，防止并发请求
  重新锁定已批准申请。
- 兑换同时校验 `requestId` 和浏览器申请凭证，并通过事务保证仅成功一次。
- 本地契约不实现全局限速。IP、申请记录和管理员身份维度的组合限速留待 HTTP
  集成阶段；当前只完成申请记录自身的 5 次失败限制。

## 设备凭证

- 设备 token 为 256-bit 随机值，数据库只保存 HMAC digest。
- 首次发行生成稳定的非秘密 `deviceId`，后续轮换凭证继承同一 `deviceId`。
- 每条凭证保存创建它的 `hmacVersionId`。
- 新凭证使用调用方显式指定的活动 HMAC VersionId。
- 验证时按数据库记录读取对应的显式 HMAC VersionId，不假定只有 current 和
  previous 两个版本。
- token 每 30 天静默轮换，旧 token 仅保留 5 分钟并发宽限。replacement token
  使用 active HMAC key、旧 raw token、域分离字符串和旧 `credentialId`
  确定性派生为 256-bit base64url 值；数据库仍只保存其 HMAC digest。
- 宽限内再次使用旧 token 时，服务读取 replacement 记录、重新派生并核对
  digest，再返回相同 replacement token 和 Cookie 契约，不保存 token 明文，
  也不延长原 grace timestamp。
- 轮换和宽限重试响应中的 `credentialId`、`hmacVersionId` 始终表示旧凭证，
  replacement 使用独立的 `replacementCredentialId` 和
  `replacementHmacVersionId`；同时返回 `deviceId`、`token`、
  `rotated=true` 和明确的 `concurrentGrace` 状态。
- 认证候选只包含当前有效 active credential，或仍在 5 分钟宽限内且不可续期的
  replaced credential；候选条件与 HMAC 版本引用保护完全一致。
- 空闲有效期滑动 90 天，绝对有效期为首次审批后的 365 天；滑动期限不能超过
  绝对期限。
- 支持单设备撤销、全部设备撤销和按泄露 HMAC VersionId 撤销。单设备撤销传入
  链上任一 `credentialId` 都会在事务中撤销相同 `deviceId` 的全部凭证，返回
  `{ devicesRevoked, credentialsRevoked }`。
- 重复撤销已经完全撤销的设备返回
  `{ devicesRevoked: 0, credentialsRevoked: 0 }`，不写新的成功撤销审计。
- 按 HMAC VersionId 撤销会查找历史上使用该版本的全部 `deviceId`，再事务式
  撤销这些设备的所有凭证，包括已轮换到其他版本的 replacement；返回
  `{ devicesMatched, credentialsRevoked }`。`devicesMatched` 包含历史匹配设备，
  `credentialsRevoked` 只计算本次从未撤销变为已撤销的凭证。
- 仍被有效凭证引用的 HMAC VersionId 不允许删除。泄露版本应撤销关联设备，
  不继续兼容。

## 审计

审计只记录事件类型、时间、非秘密主体标识和受限元数据。允许的元数据包括
请求、逻辑设备或凭证标识、HMAC VersionId、原因和数量；不保存 token、申请码、浏览器
申请凭证、HMAC 密钥、秘密值或这些值的明文。

申请创建、失败计数或锁定、批准、兑换与发行、认证滑动更新、轮换、单设备
撤销、全部撤销和按版本撤销，都通过同一个 SQLite `BEGIN IMMEDIATE` 事务完成
状态写入与对应 audit insert。任一 audit insert 失败时，状态变更一并回滚；
repository 的统一事务 helper 禁止这些复合操作自行开启嵌套事务。

## 尚未实现

- HTTP Cookie 写入、读取和 CSRF/来源校验。
- IP 与管理员身份维度限速。
- 管理员 scrypt 登录和密码 verifier。
- 真实腾讯云 SSM Provider、CAM 实例角色和元数据隔离。
- root 紧急撤销 CLI。
- 生产数据库迁移、生产启用和浏览器端审批页面。

这些能力必须在后续独立 PR 和对应外部批准门完成，不能把本地 Mock 契约视为
生产认证已经上线。

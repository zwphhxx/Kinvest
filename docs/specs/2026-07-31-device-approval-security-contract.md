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
- 错误、审计记录和数据库均不得包含秘密值。

## 申请与审批

- 创建申请时生成 256-bit 浏览器申请凭证。
- 短申请码有效 10 分钟，最多尝试 5 次，锁定后不能继续审批。
- SQLite 只保存申请码哈希和浏览器申请凭证哈希。
- 审批调用必须显式声明 `adminAuthenticated=true`。
- 兑换同时校验 `requestId` 和浏览器申请凭证，并通过事务保证仅成功一次。
- 本地契约不实现全局限速。IP、申请记录和管理员身份维度的组合限速留待 HTTP
  集成阶段；当前只完成申请记录自身的 5 次失败限制。

## 设备凭证

- 设备 token 为 256-bit 随机值，数据库只保存 HMAC digest。
- 每条凭证保存创建它的 `hmacVersionId`。
- 新凭证使用调用方显式指定的活动 HMAC VersionId。
- 验证时按数据库记录读取对应的显式 HMAC VersionId，不假定只有 current 和
  previous 两个版本。
- token 每 30 天静默轮换，旧 token 仅保留 5 分钟并发宽限。
- 空闲有效期滑动 90 天，绝对有效期为首次审批后的 365 天；滑动期限不能超过
  绝对期限。
- 支持单设备撤销、全部设备撤销和按泄露 HMAC VersionId 撤销。
- 仍被有效凭证引用的 HMAC VersionId 不允许删除。泄露版本应撤销关联设备，
  不继续兼容。

## 审计

审计只记录事件类型、时间、非秘密主体标识和受限元数据。允许的元数据包括
请求或凭证标识、HMAC VersionId、原因和数量；不保存 token、申请码、浏览器
申请凭证、HMAC 密钥、秘密值或这些值的明文。

## 尚未实现

- HTTP Cookie 写入、读取和 CSRF/来源校验。
- IP 与管理员身份维度限速。
- 管理员 scrypt 登录和密码 verifier。
- 真实腾讯云 SSM Provider、CAM 实例角色和元数据隔离。
- root 紧急撤销 CLI。
- 生产数据库迁移、生产启用和浏览器端审批页面。

这些能力必须在后续独立 PR 和对应外部批准门完成，不能把本地 Mock 契约视为
生产认证已经上线。

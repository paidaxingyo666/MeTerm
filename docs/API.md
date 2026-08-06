# REST API 参考 / REST API Reference

本文记录当前 Rust 内置服务的安全相关契约。业务帧格式见 `docs/PROTOCOL.md`。

## 认证与传输

- 远程请求必须使用证书指纹固定的 `HTTPS/WSS`。只有进程所在机器的直接 loopback
  连接可继续使用明文 `HTTP/WS`；中继流量不会被当作 loopback。
- `owner token` 只允许直接 loopback 管理请求使用，不能通过 LAN 或中继使用。
- owner token 每次设置/刷新都会轮换运行时代次，旧代次的终端和 presence WebSocket 会立即
  断开；owner 管理写操作会在提交时复验该代次，旧 token 发起的慢请求不能在轮换后重新写回。
  已用新 token 建立的连接与设备连接不受旧代次清理影响。
- 配对成功给每个稳定 `device_id` 签发独立的 `mtd_...` 轮换句柄，并同时绑定配对时验证的
  P-256 公钥。服务端只保存 token 的 SHA-256 摘要与公钥；同一 `device_id` 重新配对会轮换
  token、公钥和运行时代次，并立即断开旧连接。
- 标准 Release 的设备 `supported_scopes` 与默认 scope 均为空；旧文件中的开发授权会在加载时
  被剥离并回写。只有 Debug + `development-mobile-control` feature 可启用移动控制 scope；该
  feature 在 Release profile 下会触发编译错误。此开发包中新配对且绑定 PoP 的设备默认获得
  `desktop.control`、`ssh.desktop-connect`、`ssh.connections-write`、`push.self`，以覆盖完整
  联调链。已经持久化的 v3 设备保留原 scope，v1/v2 迁移也不会静默新增 `desktop.control`；需
  重新配对或由本机 owner 显式授权。
- token 放在 `Authorization: Bearer <token>`；WebSocket 也可用
  `Sec-WebSocket-Protocol: meterm.v1,bearer.<token>`。凭据不得出现在 URL 查询参数中。除
  `/api/auth/challenge` 外，每个设备 HTTP/WSS 请求还必须携带一次性 PoP nonce 与签名；仅复制
  `mtd_` 不能在另一进程或设备上发起请求。
- 配对、`/api/info` 等凭据响应带 `Cache-Control: no-store`。
- 撤销会阻止后续认证并清理已登记长连接；撤销前已通过认证的普通在途 REST/上传请求仍可能
  完成，调用方不能把撤销当作对已经执行副作用的回滚。

## 主要接口

| 权限 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 公开 | `GET` | `/api/ping` | 无凭据健康检查 |
| 公开 + 远程 TLS | `POST` | `/api/pair/bootstrap` | 用一次性 QR ticket 换取设备 token |
| 公开 + 远程 TLS | `POST` | `/api/pair` | 创建需要桌面批准的配对请求 |
| 公开 + 远程 TLS | `POST` | `/api/pair/:id` | 在 JSON body 中查询配对状态 |
| 设备 bearer bootstrap | `POST` | `/api/auth/challenge` | 签发一个 30 秒、单次、设备代次与 audience 绑定的 PoP nonce |
| 设备（按会话 ACL 过滤） | `GET` | `/api/sessions` | 列出当前设备可访问的会话 |
| 设备（会话 scope + 创建者 ACL） | `GET/DELETE` | `/api/sessions/:id` | 获取/删除会话 |
| 设备（会话 ACL + 当前连接） | `POST` | `/api/sessions/:id/master` | 请求或恢复主控；必须绑定 HELLO 连接代次 |
| `desktop.control` | `POST` | `/api/sessions` | 创建桌面本机 shell/Agent 会话 |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh` | 用请求内显式凭据创建 SSH 会话 |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/saved` | 让桌面使用已保存连接（主机密钥只可桌面确认） |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/saved/test` | 按连接 ID 在 Rust 内部测试已保存连接；只返回结果/主机密钥挑战，不返回 secret |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/test` | 测试请求内显式 SSH 连接 |
| `ssh.desktop-connect` | `GET` | `/api/ssh/connections` | 拉取保存连接的非敏感元数据 |
| `ssh.connections-write` | `POST/PUT/DELETE` | `/api/ssh/connections[/:id]` | 写入保存连接及替换 secret |
| 设备 | `GET` | `/api/info` | 桌面身份与该设备获准的中继能力；空 scope 不返回 relay 元数据 |
| 续期隔离设备 | `POST` | `/api/relay/capability/renew` | 仅在 RelayRenewal ingress 上复核 mtd + HTTP PoP 后签发新 mrc2 |
| `push.self` | `POST` | `/api/push/register` | 注册当前认证设备的推送目标 |
| 设备 | `DELETE` | `/api/device-credential/self` | 幂等撤销当前设备凭据并清理同代次长连接/推送 |
| 设备 | `GET` | `/ws/:session_id` | 终端 WebSocket |
| `push.self` | `GET` | `/ws-events` | 当前设备的 presence/通知事件 WebSocket |
| owner | `GET` | `/api/pair/pending` | 待批准配对 |
| owner | `POST` | `/api/pair/:id/respond` | 批准/拒绝配对 |
| owner | `GET` | `/api/device-credentials` | 列出持久设备凭据元数据 |
| owner | `PUT` | `/api/device-credentials/:device_id` | 更新当前构建支持的设备 scope 并断开旧代次 |
| owner | `DELETE` | `/api/device-credentials/:device_id` | 撤销单设备并立即断开 |
| owner | `POST` | `/api/token` | 设置本机 owner token（32–128 位可见 ASCII） |
| owner | `POST` | `/api/token/refresh` | 刷新本机 owner token |
| owner | `POST` | `/api/token/revoke-all` | 撤销所有设备、断开 presence、清推送注册 |
| owner | `POST` | `/api/sessions/:id/refresh-sftp` | Rust 为会话已绑定的 JumpServer 目标创建并消费新凭据；body 不接受 username/password/目标，设备不可调用 |

文件、Git 和本机 Agent 路由属于 `desktop.control`；JumpServer 属于
`ssh.desktop-connect`。无论当前 scope 是否为空，设备 bearer 都应按密码处理，并通过桌面
设置页及时撤销不再使用或疑似被 Hook 的设备。

### 保存连接的凭据来源

`SavedConnection` 用两个独立布尔字段明确 key 的来源：`has_key_path` 与
`uses_desktop_key_ladder`。后者表示桌面 owner 明确授权使用该 Mac 的 ssh-agent 或默认
`~/.ssh/id_*` 查找链；“key 内容为空”绝不能隐式获得这项能力。旧数据缺少该字段时按
`false` 处理，因此缺失 inline PEM 会失败关闭。

| `auth_method` | `has_key_path` | `uses_desktop_key_ladder` | 必须存在的凭据 | 禁止的认证材料 | 可由设备 HTTP 创建/授予 |
|---|---:|---:|---|---|---|
| `password` | `false` | `false` | 非空 password | PEM、key path、passphrase | 是 |
| `key`（inline） | `false` | `false` | 非空 private-key PEM；可选 passphrase | password、key path | 是 |
| `key`（桌面路径） | `true` | `false` | 非空桌面 key path；可选 passphrase | password、PEM | 否 |
| `key`（桌面查找链） | `false` | `true` | 无；由桌面 ssh-agent/默认 key 查找链执行 | password、PEM、key path、passphrase | 否 |

`has_key_path=true` 与 `uses_desktop_key_ladder=true` 的组合无效；password 认证的任一来源标志
为 `true` 也无效。设备调用 raw/test SSH 的 key 认证必须在请求 JSON 内提供 inline PEM，空
key、文件路径、桌面 ssh-agent 与默认 key 查找链都会被拒绝。保存连接按 ID 中转时可以使用
owner 已选择的桌面路径或查找链，因为设备既拿不到凭据，也不能指定路径或改变其 authority。

凭据在 vault 中绑定到 host、port、username、auth method、两个来源标志，以及 proxy type、
host、port、username。设备改变上述任一 authority 字段时，必须在同一事务提供匹配的新
password 或 inline PEM；设备不能创建、重定向或授予桌面路径/查找链连接。仅修改名称等展示
字段不会重绑或清空现有 secret。保存连接的 `trusted_fingerprint` 只能由 owner/桌面本地
提交，设备提交会返回 `403`。SSH session 绑定创建时的 device ID + 凭据 generation，其他
设备及同一设备重配后的新 generation 不继承访问权。

### SSH 会话创建与稳定错误

`POST /api/sessions/ssh` 与 `POST /api/sessions/ssh/saved` 都先完成 SSH 握手、认证与 channel
初始化，再登记并发布 session。失败或请求中途取消不会留下可发现会话，不会触发桌面端失败
标签页；后台 SFTP 初始化不阻断已经可用的终端会话。

SSH 创建/测试接口不会把底层 SSH 库错误、私钥路径、代理细节或其它内部诊断返回给设备。服务端
只在本机日志记录原始错误，网络响应使用稳定 code。创建接口的稳定响应为：

- `201`：SSH 连接成功，会话已登记。
- `400`：`invalid_ssh_config`，raw 请求内 SSH 配置缺失或格式无效。
- `403`：`credential_source_forbidden`，远程设备在 raw 请求中使用了桌面本地 key 来源。
- `403`：`host_key_confirmation_forbidden`，远程设备试图替 saved 连接提交主机密钥信任决定。
- `404`：`connection_not_found`，saved 连接不存在或已删除。
- `409`：`host_key_unknown` 或 `host_key_mismatch`，主机密钥需由桌面本地确认；challenge
  只包含 `error`、`hostname`、`fingerprint`、`key_type`。
- `422`：`credential_unavailable`，来源/绑定无效，或该连接所需凭据不可用。
- `500`：`credential_load_failed`，saved 连接的桌面凭据库读取失败。
- `504`：`credential_load_timeout`，桌面凭据库在服务端时限内未能完成读取；不会继续创建 SSH 会话。
- `502`：`ssh_auth_failed`，上游 SSH 认证失败。
- `502`：`ssh_connect_failed`，其它上游 SSH 建连失败。
- `504`：`ssh_connect_timeout`，SSH 连接在服务端时限内未完成。

两个 `/test` 接口成功时返回 `200 {"ok":true}`；未知或不匹配的主机密钥仍以 `200` 返回经过
筛选的 challenge，且只包含 `error`、`hostname`、`fingerprint`、`key_type`。其它失败使用上表
对应的 HTTP 状态，并返回 `{"ok":false,"error":"<stable_code>"}`，不会回传底层错误文本。

会话建立后的后台 SFTP 初始化失败也不会透传底层诊断：终端 WebSocket 的 `MSG_ERROR` 使用
`code=SFTP_NOT_AVAILABLE` 与固定 `message=sftp_init_failed`，原始 SFTP 错误只写入桌面本机日志。

## v2 配对

QR 数据只包含连接元数据、桌面证书指纹和一次性 `pair_ticket`，不包含 owner token、
中继地址或任何中继全局密钥。

```json
{
  "v": 2,
  "addrs": ["192.0.2.10:8022"],
  "token": "",
  "pair_ticket": "<43-char-base64url>",
  "name": "My Desktop",
  "device_id": "<desktop-id>",
  "cert_fp": "<sha256-hex>"
}
```

QR 兑换：

```http
POST /api/pair/bootstrap
Content-Type: application/json

{"ticket":"...","device_id":"<phone-id>","device_name":"Phone","pop_alg":"ES256","pop_public_key":"<base64url-uncompressed-P256-key>","pop_signature":"<base64url-raw-r||s>"}
```

手动/mDNS 配对先创建请求，再把短期 secret 放在 POST body 中轮询，避免 URL、代理和访问
日志泄漏：

```http
POST /api/pair
Content-Type: application/json

{"device_id":"<phone-id>","device_name":"Phone","pop_alg":"ES256","pop_public_key":"<base64url-uncompressed-P256-key>","pop_signature":"<base64url-raw-r||s>"}
```

```http
POST /api/pair/<pair-id>
Content-Type: application/json

{"secret":"<pair-secret>"}
```

旧版 v1 QR、URL 中 token/secret、远程明文配对均 fail closed，需要升级并重新配对。

`pop_public_key` 必须是 65 字节未压缩 SEC1 P-256 点（首字节 `0x04`）的无 padding
base64url。`pop_signature` 是 64 字节 IEEE P1363 `r || s` 签名。签名消息按 UTF-8 精确为：

```text
MeTerm-Pair-v1\n<phone-device-id>\n<device-name>\n<context>
```

QR 兑换的 `<context>` 是 ticket 原文；桌面审批配对固定为 `approval`。服务端在签发 token 前
验证签名，因此不能把任意公钥事后绑定到已经取得的 `mtd_`。

## 设备 HTTP / WebSocket PoP

设备先通过同一条证书固定的 TLS 连接请求 nonce；这是唯一只需 bearer、不需先有 PoP 的设备
API：

```http
POST /api/auth/challenge
Authorization: Bearer mtd_...
Content-Type: application/json

{"audience":"desktop-http"}
```

`audience` 只能是 `desktop-http` 或 `desktop-ws`。成功响应中的 `nonce` 是 32 字节随机值的无
padding base64url，30 秒到期且最多消费一次。实际请求必须带上原 token，并增加：

```http
X-MeTerm-PoP-Nonce: <nonce>
X-MeTerm-PoP-Signature: <base64url-raw-r||s>
```

签名输入不是 JSON，而是以下有界二进制串：

```text
"MTP1" (4 bytes)
audience (u8: HTTP=1, WebSocket=2)
method_length (u8) || uppercase ASCII method
SHA-256(exact mtd_ token UTF-8) (32 bytes)
nonce (32 bytes)
target_length (u16 big-endian) || exact ASCII origin-form target
```

target 是客户端实际发送的 path 与 query，例如 `/api/info` 或
`/api/files/op?x=%E4%B8%AD`，最多 4096 字节，不含 fragment。服务端先原子消费 nonce，再验证
签名；错误签名不能用同一个 nonce 重试。重复 Authorization、重复 PoP header、多个
`bearer.` WebSocket 子协议或 token/target/audience 不一致均拒绝。

请求 body 没有进入签名输入：它依赖已经固定桌面证书的 TLS 提供完整性。这一设计阻止复制
token 后在另一进程离线重放，但不宣称能抵抗仍控制原 App 进程并实时调用不可导出密钥的 Hook
签名 oracle；此边界见 `docs/SECURITY.md`。

## `/api/info` 中继字段

标准 Release 设备只有空 scope，响应不会下发中继地址、指纹或 capability。以下只是省略其它
非敏感字段后的相关字段摘录：

```json
{"device_scopes": []}
```

开发控制包中，设备至少有一个 scope 且桌面启用中继时，响应可包含：

```json
{
  "device_scopes": ["desktop.control", "ssh.desktop-connect", "ssh.connections-write", "push.self"],
  "relay_url": "wss://relay.example.invalid:8443",
  "relay_cert_fp": "<sha256-hex>",
  "relay_access_token": "mrc2.<expiry>.<pop-key-thumbprint>.<mac>",
  "relay_access_expires_at": 1700000000,
  "relay_renewal_grant": "mrr1.<pair-epoch>.<pop-key-thumbprint>.<mac>"
}
```

`relay_access_token` 只授权
`(desktop_device_id, phone_device_id, expiry, SHA-256(phone-PoP-public-key))` 对应的中继隧道，
不是桌面 API token，也不是 relay 注册或推送全局密钥。移动端必须把整组字段视为来自同一
个已固定证书且已认证的响应，并按已配对桌面隔离保存。桌面按一分钟签发桶生成 token，
单个 token 从签发时刻起有效期大于 9 分钟且不超过 10 分钟；relay 还会在绝对到期时截断
已经建立的盲管。移动端在剩余约 2 分钟前通过仍有效的中继隧道重新请求 `/api/info`，并让
后续新建隧道使用新 token。

`relay_renewal_grant` 只允许进入 `/renew` 隔离通道。其 16-byte 随机 pairing epoch 持久化在
桌面设备凭据记录中，桌面重启时保持不变，重新配对时轮换；它还绑定桌面 ID、手机 ID 与同一
PoP 公钥 thumbprint。grant 随配对关系有效，不设置另一个几分钟级到期时间，否则会再次形成
公网冷启动死锁。它不能用于 `/connect` 或桌面 API，单独复制也无法回答新的 Relay challenge。

若 App 挂起至 `mrc2` 过期，移动端保留独立保存的 Relay authority/pin 与 `mrr1`，通过
`/renew` 完成独立 Relay PoP。PoP 成功后，Relay 使用该桌面的 register secret 写入一个有界、
HMAC 认证且绑定 `(desktop ID, phone ID, pairing epoch, PoP key thumbprint,
SHA-256(exact mrr1))` 的续期 preface；`0xF1` 只是 preface 的首字节，单独发送不能选择续期
Router。子流内随后仍是手机到桌面的证书固定 TLS，Relay 看不到 `mtd_`。手机先请求
`/api/auth/challenge`，再以当前 `mtd_ + HTTP PoP` 调用 `/api/relay/capability/renew`。续期专用
认证层会在生成 challenge nonce 前要求 outer desktop/phone ID 与当前桌面及 inner `mtd_` 设备
身份完全一致；不匹配直接返回 403，且不占用 challenge 队列。桌面随后在同一设备凭据读事务内
重新确认 preface、当前凭据代次、pairing epoch、PoP key、exact mrr1 digest、非空 scope 与撤销
状态后才返回新 `mrc2`。续期 Router 不包含任何普通业务接口。

成功响应带 `Cache-Control: no-store`，只包含如下字段；返回的 Relay authority 必须与手机已
固定值完全一致，本协议不借续期静默迁移中继目标：

```json
{
  "version": 1,
  "device_id": "<desktop-device-id>",
  "relay_url": "wss://relay.example.invalid:8443",
  "relay_cert_fp": "<sha256-hex>",
  "relay_access_token": "mrc2.<expiry>.<pop-key-thumbprint>.<mac>",
  "relay_access_expires_at": 1700000000,
  "relay_renewal_grant": "mrr1.<pair-epoch>.<pop-key-thumbprint>.<mac>"
}
```

手机连接 `/connect` 时除 `Authorization: Bearer mrc2...` 外，还必须发送唯一
`X-MeTerm-PoP-Key`，其值为配对公钥 65 字节 SEC1 表示的无 padding base64url。Relay 复核
thumbprint 后才升级 WebSocket，并完成 `docs/PROTOCOL.md` 定义的随机挑战。只有 PoP 成功后才
分配 yamux 子流。旧 `mrc1`、错误/重复 key header、复制到无私钥进程的 `mrc2`、重放旧连接
签名、换桌面/手机、修改到期时间或超过 10 分钟均拒绝。

`mrc2` HMAC 本身在到期前仍可重复提交，但每条实际连接都需要新的 Relay challenge 签名，因而
复制 token 与公钥不能建立隧道。已建立盲管在绝对到期时仍会被截断。原 App 进程被 Hook 后充当
实时签名 oracle 的剩余风险与 HTTP PoP 相同。

## WebSocket

```text
wss://<desktop>/ws/<session-id>
wss://<desktop>/ws/<session-id>?client_id=<id>
wss://<desktop>/ws/<session-id>?mode=readonly
wss://<desktop>/ws-events?device_id=<authenticated-device-id>
```

`client_id` 只用于连接身份/重连，不是认证凭据；服务端会校验它是否属于当前认证的设备。

终端 WebSocket 建立后，服务端首先发送 `Hello (0x09)`。其 JSON payload 除
`client_id`、`role`、`protocol_version`、`cols`、`rows` 外，还包含非负整数 `conn_gen`。
`client_id` 可以跨重连稳定，`conn_gen` 只代表当前这一次连接；同一客户端重连后，旧代次立即
失效。完整帧和主控审批布局见 `docs/PROTOCOL.md`。

## 主控请求

移动端通过当前终端 WebSocket 的 HELLO 取得 `client_id + conn_gen`，再调用：

```http
POST /api/sessions/<session-id>/master
Content-Type: application/json

{"client_id":"<client-id>","conn_gen":7,"takeover":false}
```

`client_id` 与 `conn_gen` 都是必填项。`takeover=false`（或省略）会把绑定该连接代次的请求转发
给当前 Master 审批；仅在产品允许的恢复流程中使用 `takeover=true` 直接恢复控制。服务端会在
执行时原子复核请求设备身份、凭据代次、会话 ACL、客户端在线状态及连接代次，不接受仅带稳定
`client_id` 的旧协议请求。

- `200`：请求已绑定当前连接并被转发，或允许的直接恢复已经完成。
- `400`：`conn_gen` 缺失或类型无效。
- `403`：设备 scope、会话 ACL 或客户端身份/凭据代次不匹配。
- `404`：会话不存在。
- `409`：客户端已断线、`conn_gen` 已过期，或当前 Master 状态不允许完成请求。

所有缺少代次或代次不匹配的情况都 fail closed；服务端不会回退成按 `client_id` 提升权限。

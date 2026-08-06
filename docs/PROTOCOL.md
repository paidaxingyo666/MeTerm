# 二进制通信协议 / Binary Protocol

WebSocket 使用高效的二进制协议通信。

本页的业务帧只在桌面 API WebSocket 鉴权完成后使用。手机到 Relay 的 `/connect` 在 yamux
转发开始前另有固定 PoP 握手，不能把两组帧混用。

## Relay `/connect` PoP 握手

HTTP Upgrade 请求使用 `Authorization: Bearer mrc2...`，并以唯一
`X-MeTerm-PoP-Key` header 提交 65 字节未压缩 P-256 公钥的无 padding base64url。Relay 验证
capability 中的公钥 thumbprint 后升级 WebSocket，然后按顺序交换三种固定 binary message：

```text
Relay -> Phone: [0x01 || challenge(32 bytes)]
Phone -> Relay: [0x02 || ECDSA-P256-signature-r||s(64 bytes)]
Relay -> Phone: [0x03]
```

证明必须在 10 秒内完成；文本帧、长度错误、顺序错误、签名错误或超时都会关闭连接且不分配
桌面子流。签名消息是以下 UTF-8 文本的精确字节：

```text
MeTerm-Relay-PoP-v1\n<desktop-device-id>\n<phone-device-id>\n<base64url(SHA-256(exact-mrc2-token-bytes))>\n<base64url(challenge)>
```

每条连接使用新的 OS 随机 challenge。签名同时绑定桌面、手机、完整 capability 与 challenge，
因此不能跨连接、跨 token 或跨设备重放。收到单字节 `0x03` 后，后续 binary message 才是既有
yamux 字节流。

## Relay `/renew` PoP 与续期隔离通道

短期 `mrc2` 已过期时，手机只能使用桌面签发的 `mrr1` 进入续期通道：

```http
GET /renew?device_id=<desktop-id>&client_id=<phone-id>
Authorization: Bearer mrr1.<pair-epoch>.<pop-key-thumbprint>.<mac>
X-MeTerm-PoP-Key: <uncompressed-P256-public-key-base64url>
```

`mrr1` 不能用于 `/connect`，`mrc2` 也不能用于 `/renew`。Relay 验证 grant 的 HMAC、目标身份与
公钥 thumbprint 后，使用与普通连接不同的固定帧和签名域：

```text
Relay -> Phone: [0x11 || challenge(32 bytes)]
Phone -> Relay: [0x12 || ECDSA-P256-signature-r||s(64 bytes)]
Relay -> Phone: [0x13]
```

签名输入是：

```text
MeTerm-Relay-Renew-PoP-v1\n<desktop-device-id>\n<phone-device-id>\n<base64url(SHA-256(exact-mrr1-token-bytes))>\n<base64url(challenge)>
```

只有该 PoP 成功后 Relay 才打开 yamux 子流，并先使用该桌面的 register secret 写入如下
Relay→桌面认证 preface（所有长度均为字节，最大总长 408 字节）：

```text
0xF1 | "MTRR" | version=0x01 | desktop_id_len:u8 | phone_id_len:u8
     | desktop_id | phone_id
     | pairing_epoch:16 | pop_key_thumbprint:32 | SHA-256(exact_mrr1):32
     | nonce:32 | HMAC-SHA256:32
```

两项 ID 必须为 1..128 字节的规范 ASCII ID。HMAC 输入为
`"MeTerm-Relay-Renew-Preface-v1\0" || preface_without_tag`；register secret 不发送给手机，
也不写入 preface。`0xF1` 只是认证 preface 的首字节，不是独立授权标记。桌面必须在单一 10 秒
分类时限内限长读取、验证 HMAC 与预期 desktop ID，并要求 preface 后紧接 TLS ClientHello
首字节 `0x16`；裸 `0xF1`、截断、篡改、错误 secret、跨桌面或非 TLS 后继均直接丢弃。

验证成功后，桌面把 preface 转为进程内不可由 HTTP header 构造的 renewal context，再把后续
端到端 TLS 交给独立 renewal Router；该 Router 只存在
`POST /api/auth/challenge` 与 `POST /api/relay/capability/renew`，不包含普通 REST、配对、终端、
SSH、文件或业务 WebSocket。inner bearer 认证后、challenge nonce 生成前，续期 Router 还必须
先确认 context 的 desktop ID 等于当前桌面且 phone ID 等于 inner device principal；不匹配返回
403，不写 challenge 队列。普通 `/connect` 子流仍直接以 TLS ClientHello `0x16` 开始，保持旧
客户端兼容；即使普通 `/connect` 的手机主动发送 `0xF1`，也无法生成 register-secret HMAC，
因此不能进入续期 Router。续期 handler 还会在同一凭据读锁内把 outer context 与当前 inner
`mtd_` 代次、phone ID、pairing epoch、PoP key 及重新计算的 exact mrr1 digest 原子复核。

## 帧格式

```
[type: 1 byte][payload: N bytes]
```

## 消息类型

| 消息类型 | Hex | 方向 | 说明 |
|----------|-----|------|------|
| Output | 0x01 | S→C | PTY 输出流 |
| Input | 0x02 | C→S | 键盘输入 |
| Resize | 0x03 | C→S | 终端大小变化 |
| Ping | 0x04 | C→S | 心跳请求 |
| Pong | 0x05 | S→C | 心跳响应 |
| SessionEnd | 0x06 | S→C | 会话结束 |
| Error | 0x07 | S→C | 错误通知 |
| RoleChange | 0x08 | S→C | 角色变更 |
| Hello | 0x09 | S→C | 握手/重连元数据 |
| FileList | 0x0A | C→S | 请求文件列表 |
| FileListResp | 0x0B | S→C | 文件列表响应 |
| FileUploadStart | 0x0C | C→S | 开始上传 |
| FileUploadChunk | 0x0D | C→S | 上传数据块 |
| FileDownloadStart | 0x0E | C→S | 开始下载 |
| FileDownloadChunk | 0x0F | S→C | 下载数据块 |
| FileOperation | 0x10 | C→S | 文件操作（删除/重命名等）|
| FileOperationResp | 0x11 | S→C | 文件操作响应 |
| ServerInfo | 0x12 | C⇄S | 服务器信息 |
| TransferProgress | 0x13 | S→C | 传输进度 |
| UploadResume | 0x14 | C→S | 恢复上传 |
| DownloadResume | 0x15 | C→S | 恢复下载 |
| FileListProgress | 0x16 | S→C | 大目录加载进度 |
| SetEncoding | 0x17 | C→S | 设置终端编码 |
| Nudge | 0x18 | C→S | 请求 PTY SIGWINCH |
| MasterRequest | 0x19 | C→S | 请求成为 Master |
| MasterRequestNotify | 0x1A | S→C | 通知当前 Master |
| MasterApproval | 0x1B | C⇄S | 批准/拒绝请求及结果 |
| MasterReclaim | 0x1C | C→S | Master 收回控制权 |
| PairNotify | 0x1D | S→C | 配对请求通知 |
| PairApproval | 0x1E | C→S | 配对审批结果 |
| MasterRelease | 0x1F | C→S | Master 主动让出控制权 |
| FileDownloadPause | 0x20 | C→S | 暂停下载 |
| FileDownloadContinue | 0x21 | C→S | 恢复已暂停的下载 |
| FileDownloadCancel | 0x22 | C→S | 取消下载 |
| FileReadRequest | 0x30 | C→S | 编辑器读取小文件 |
| FileReadResponse | 0x31 | S→C | 小文件单帧响应 |
| FileSaveRequest | 0x32 | C→S | 编辑器保存小文件 |
| FileSearch | 0x33 | C→S | 递归搜索请求 |
| FileSearchResp | 0x34 | S→C | 流式搜索结果 |
| AgentEvent | 0x50 | S→C | Agent 事件 JSON |
| AgentInput | 0x51 | C→S | Agent 输入 JSON |
| AgentControl | 0x52 | C→S | Agent 审批/中断等控制 JSON |

## 小文件读取与消息上限

`FileReadRequest (0x30)` payload 为 JSON：

```json
{"path":"/remote/file","max_bytes":2097152}
```

- `max_bytes` 可选，新客户端必须按实际内存用途传入正整数上限。新服务端取它与服务端上限的较小值；旧服务端会忽略未知字段。
- `FileReadResponse (0x31)` payload 为 `[size:u64 BE][content]`，宣称长度必须与实际内容一致。
- 手机端单帧内存读取上限为 16 MiB（完整 WebSocket 消息为 16 MiB + 9 字节）。普通大文件下载必须继续使用 `0x0E/0x0F` 分块协议，不得改用单帧 `0x31`。
- 桌面会话 WebSocket 入站单消息/单帧硬上限为 17 MiB；`/ws-events` 为 64 KiB。超限由 WebSocket 层拒绝，不进入业务分发。

## 方向说明

- **S→C**: 服务端发送给客户端
- **C→S**: 客户端发送给服务端
- **C⇄S**: 双向

## 主控连接代次绑定

`Hello (0x09)` payload 是 JSON。`client_id` 是可跨重连复用的逻辑客户端 ID；`conn_gen`
是服务端为该客户端当前这一次 WebSocket 连接分配的连接代次：

```json
{
  "client_id": "<client-id>",
  "role": "viewer",
  "protocol_version": 1,
  "cols": 120,
  "rows": 36,
  "conn_gen": 7
}
```

`conn_gen` 是非负整数，每次同一 `client_id` 重连时都会变化。它不是凭据，但所有提升主控权限
的后续请求都必须绑定它；客户端不得仅凭稳定 `client_id` 复用旧请求。

WebSocket 内的 `MasterRequest (0x19)` payload 为空。服务端从发送该帧的当前连接取得代次，并向
当前 Master 发送 `MasterRequestNotify (0x1A)`，其 payload 为：

```json
{"requester_id":"<client-id>","session_id":"<session-id>","conn_gen":7}
```

接收端必须要求 `requester_id`、`session_id` 为字符串，并要求 `conn_gen` 是非负、可精确表示的
整数；字段缺失、类型错误或超出客户端安全整数范围时不得显示审批或发送结果。

`MasterApproval (0x1B)` 在两个方向使用相同 payload：

```text
[approved: u8][requester_conn_gen: u64 big-endian][requester_id: UTF-8]
```

完整线上帧为：

```text
[0x1B][approved: u8][requester_conn_gen: u64 big-endian][requester_id: UTF-8]
```

`approved` 只能取 `0`（拒绝）或 `1`（批准）。服务端只接受当前 Master 的精确连接代次发出的
审批，并在批准时原子复核 `requester_id + requester_conn_gen` 仍对应同一条在线、非只读连接；
审批结果也只投递给该代次。每个业务帧在服务端持有连接表锁、完成精确代次和角色快照时线性化：
重连取得该锁并递增代次前已经合法接收的帧可以按旧权限完成；递增后才进入鉴权的旧代次帧必须
fail closed，且旧帧不能借用相同 `client_id` 新连接后来取得的角色。主控批准、释放和收回还会在
状态提交时原子复核发起者代次与当前 Master/Owner，防止并发换主覆盖。

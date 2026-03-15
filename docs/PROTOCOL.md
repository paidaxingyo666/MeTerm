# 二进制通信协议 / Binary Protocol

WebSocket 使用高效的二进制协议通信。

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
| MasterApproval | 0x1B | C→S | 批准/拒绝请求 |
| MasterReclaim | 0x1C | C→S | Master 收回控制权 |
| PairNotify | 0x1D | S→C | 配对请求通知 |
| PairApproval | 0x1E | C→S | 配对审批结果 |
| FileDownloadPause | 0x20 | C→S | 暂停下载 |
| FileDownloadContinue | 0x21 | C→S | 恢复已暂停的下载 |
| FileDownloadCancel | 0x22 | C→S | 取消下载 |

## 方向说明

- **S→C**: 服务端发送给客户端
- **C→S**: 客户端发送给服务端
- **C⇄S**: 双向

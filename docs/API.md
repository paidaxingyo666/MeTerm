# REST API 参考 / REST API Reference

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 创建本地会话 |
| `GET` | `/api/sessions` | 列出所有会话 |
| `GET` | `/api/sessions/:id` | 获取会话详情 |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `POST` | `/api/sessions/ssh` | 创建 SSH 会话 |
| `POST` | `/api/sessions/ssh/test` | 测试 SSH 连接 |
| `POST` | `/api/sessions/:id/master` | 切换 Master 角色 |
| `POST` | `/api/sessions/:id/private` | 设置会话私有模式 |
| `DELETE` | `/api/sessions/:id/clients/:cid` | 踢出客户端 |
| `GET` | `/api/clients` | 列出所有客户端 |
| `GET` | `/api/devices` | 列出所有已知设备 |
| `GET` | `/api/info` | 获取服务信息 |
| `POST` | `/api/discover` | mDNS 扫描局域网设备 |
| `POST` | `/api/discoverable` | 切换 mDNS 可发现性 |
| `POST` | `/api/pair` | 创建配对请求 |
| `GET` | `/api/pair/:id?secret=xxx` | 查询配对状态 |
| `GET` | `/api/pair/pending` | 列出待批准的配对 |
| `POST` | `/api/pair/:id/respond` | 批准/拒绝配对 |
| `GET` | `/api/token` | 获取当前 Token |
| `POST` | `/api/token/refresh` | 刷新 Token |
| `POST` | `/api/token/revoke-all` | 撤销所有 Token |
| `GET` | `/api/banned-ips` | 列出被禁用的 IP |
| `GET` | `/api/ping` | 健康检查（无需认证）|

## WebSocket 连接

```
ws://localhost:8080/ws/<session-id>
ws://localhost:8080/ws/<session-id>?client_id=<id>      # 重连
ws://localhost:8080/ws/<session-id>?mode=readonly       # 只读模式
```

## 使用示例

### 创建会话

```bash
curl -X POST http://localhost:8080/api/sessions
# 返回: {"id": "xxx-xxx-xxx", "state": "created", ...}
```

### 连接终端

在浏览器中访问 `http://localhost:5174?session=<session-id>` 即可连接。

### 会话管理 CLI

```bash
# 构建 CLI 工具
cd backend && go build -o ../bin/meterm ./cmd/muxerd

# 列出所有会话
./bin/meterm --addr http://localhost:8080 sessions ls

# 查看会话详情
./bin/meterm sessions inspect <session-id>

# 终止会话
./bin/meterm sessions kill <session-id>
```

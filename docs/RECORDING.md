# 会话录制格式 / Session Recording Format

## 概述

MeTerm 支持终端会话的完整录制和精确回放，所有输入、输出和终端事件均被记录。

## 二进制日志格式

每条记录的结构：

```
[timestamp: int64 LE][direction: 1 byte][length: uint32 LE][data: N bytes]
```

| 字段 | 大小 | 说明 |
|------|------|------|
| timestamp | 8 bytes | Unix 时间戳（int64 小端序）|
| direction | 1 byte | 方向标记（见下方）|
| length | 4 bytes | 数据长度（uint32 小端序）|
| data | N bytes | 实际数据内容 |

## 方向标记

| 标记 | 说明 |
|------|------|
| `'i'` (0x69) | 用户键盘输入 |
| `'o'` (0x6F) | PTY 输出 |
| `'r'` (0x72) | 终端 Resize 事件 |
| `'e'` (0x65) | 会话生命周期事件 |

## 启用录制

通过服务端参数 `--log-dir` 指定录制日志目录即可启用：

```bash
./bin/meterm --log-dir ./recordings
```

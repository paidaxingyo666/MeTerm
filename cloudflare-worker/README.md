# MeTerm updater Worker

这个 Worker 只负责把 GitHub Release 转换成 Tauri v2 updater manifest。客户端仍使用
`desktop/src-tauri/tauri.conf.json` 内置的 minisign 公钥验证更新；Worker 不持有 updater
私钥，也不能替代客户端验签。

## 请求契约

只接受：

```text
GET /meterm/<target>/<arch>/<current_version>
```

- `current_version` 必须是无 `v` 前缀的严格 SemVer 2.0。
- 不接受 query、尾随 `/`、百分号编码路径或额外路径段。
- 支持的平台是 `darwin/{aarch64,x86_64}`、`linux/{aarch64,x86_64}` 和
  `windows/x86_64`。
- 非 GET 返回 405；无效路径/平台返回 404；无效当前版本返回 400。
- 上游 release、资产或签名异常一律返回 502，不返回空签名或可疑下载地址。

release JSON 最多 256 KiB，签名响应最多 8 KiB。需要更新时，二进制和 `.sig` 必须各有且
只有一个精确名称，并且下载地址必须逐字匹配该仓库、tag 和资产名下的 HTTPS GitHub
Release URL。

## 配置

非秘密配置位于 `wrangler.jsonc`：

- `GITHUB_REPO`：格式为 `owner/repo`。
- `BRIDGE_VERSION`：桥接版本，例如 `0.2.12`。
- `BRIDGE_TAG`：必须等于 `v` + `BRIDGE_VERSION`，例如 `v0.2.12`。

`BRIDGE_VERSION` 和 `BRIDGE_TAG` 必须同时存在或同时不存在。默认都不配置时，行为与旧版
一致：读取 `/releases/latest`。

桥接 Release 完成并验证后，再把两个非秘密变量一起加入 `wrangler.jsonc`：

```jsonc
"vars": {
  "GITHUB_REPO": "paidaxingyo666/MeTerm",
  "BRIDGE_VERSION": "0.2.12",
  "BRIDGE_TAG": "v0.2.12"
}
```

不得只设置其中一个，也不得在桥接 Release 存在之前提前启用。

可选的 `GITHUB_TOKEN` 只能通过 Cloudflare secret 设置，禁止写入源码、配置或命令参数：

```bash
npx wrangler secret put GITHUB_TOKEN
```

公开仓库通常不需要该 token；只有确认 GitHub API 限流确实影响服务时才配置。

## updater 密钥桥接顺序

公开仓库已经存在使用旧 updater 公钥的安装包，因此不得直接替换公钥或删除旧私钥。
安全轮换必须严格按以下顺序执行：

1. 保留旧 updater 私钥、旧公钥、现有 Release 和签名。先完成隔离的
   build -> sign -> verify 流水线。
2. 离线生成并备份新 key pair；新私钥只进入受保护的 signer，不进入源码或普通 build job。
3. 选择一个尚未发布的 `BRIDGE_VERSION`，并创建对应的 `BRIDGE_TAG`。
4. 桥接 App 内嵌新公钥，但桥接 updater 包必须用旧私钥签名。旧客户端因此能验证并安装它，
   安装后才开始信任新公钥。
5. 用所有五种桌面 target/arch 的精确资产完成桥接 Release，并把它视为不可变记录。
6. 在任何新私钥签名的 latest Release 发布前，先配置并部署本 Worker 的
   `BRIDGE_VERSION`/`BRIDGE_TAG`，验证旧版本请求只返回固定桥接 tag，绝不访问 latest。
7. 验证桥接版本请求会转向 latest 后，才发布使用新私钥签名的下一版本。
8. 只在桥接链和新签名均验证成功后删除 GitHub repo-level 旧 secret。离线旧 key 建议继续
   冷备份，以便处理桥接事故。

桥接 Release、它的 updater 资产及 `.sig` 不可删除、改名或替换。只要历史安装包仍可能被
安装，Worker 就必须保留旧版本先取桥接版的路由；否则这些客户端会永久失去更新能力。

桥接模式下，`current_version < BRIDGE_VERSION` 的请求只访问固定 tag API。tag 不存在、版本
不匹配、上游失败或资产异常时直接失败关闭，不会回退 `/releases/latest`。达到桥接版本后才
允许访问 latest。

## 精确资产名

对于 release 版本 `<version>`：

```text
darwin/aarch64   MeTerm_aarch64.app.tar.gz
darwin/x86_64    MeTerm_x86_64.app.tar.gz
linux/aarch64    MeTerm_<version>_aarch64.AppImage.tar.gz
linux/x86_64     MeTerm_<version>_amd64.AppImage.tar.gz
windows/x86_64   MeTerm_<version>_x64-setup.exe
```

每个二进制必须同时存在同名加 `.sig` 的签名资产。

## 本地验证

测试只使用 Node 内建测试框架，不访问 GitHub 或 Cloudflare：

```bash
cd cloudflare-worker
npm test
npm run check
```

部署前再运行 Wrangler dry-run；dry-run 只构建和校验配置，不部署：

```bash
npx wrangler@4.110.0 deploy --dry-run
```

真实部署、secret 写入和桥接 Release 发布都必须单独审批。

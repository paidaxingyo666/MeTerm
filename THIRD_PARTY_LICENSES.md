# Third-Party Licenses / 第三方许可证

MeTerm uses the following open-source projects. We are grateful to their authors and contributors.

MeTerm 使用了以下开源项目，感谢它们的作者和贡献者。

---

## tldr-pages

- **Project**: https://github.com/tldr-pages/tldr
- **Integration**: Runtime download of community-maintained command documentation
- **License (code)**: MIT License
- **License (content)**: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Usage**: Command help pages displayed in the app are sourced from the tldr-pages project. Content is downloaded at runtime from GitHub Releases and cached locally.

> The tldr-pages content is licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). As required by the license, MeTerm attributes the content to the tldr-pages project in the UI.

---

## SearXNG

- **Project**: https://github.com/searxng/searxng
- **Integration**: Remote API calls to user-configured SearXNG instances
- **License**: [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- **Usage**: MeTerm calls the SearXNG JSON search API for web search functionality. No SearXNG source code is included or distributed. Users must provide their own SearXNG instance URL.

> MeTerm does not embed, modify, or distribute SearXNG software. It only communicates with SearXNG instances via their public HTTP API.

---

## Windows Terminal (ConPTY / OpenConsole)

- **Project**: https://github.com/microsoft/terminal
- **Integration**: Bundled binaries (`conpty.dll`, `OpenConsole.exe`) in Windows builds
- **License**: [MIT License](https://github.com/microsoft/terminal/blob/main/LICENSE)
- **Usage**: MeTerm bundles ConPTY DLL and OpenConsole.exe from Microsoft's Windows Terminal project to provide native pseudo-console support on Windows. The DLL is loaded at runtime by the Go sidecar process.

> Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License.

---

## JumpServer

- **Project**: https://github.com/jumpserver/jumpserver
- **Integration**: Remote REST API calls to user-configured JumpServer instances
- **License**: [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- **Usage**: MeTerm connects to JumpServer instances via their public REST API for asset browsing, authentication, and SSH session creation through the Koko proxy. No JumpServer source code is included or distributed.

> MeTerm does not embed, modify, or distribute JumpServer software. It only communicates with JumpServer instances via their public HTTP/SSH API.

---

## xterm.js

- **Project**: https://github.com/xtermjs/xterm.js
- **License**: MIT License
- **Usage**: Terminal emulator component used for SSH, local terminal, and remote sessions.

---

## Tauri

- **Project**: https://github.com/tauri-apps/tauri
- **License**: MIT License / Apache-2.0
- **Usage**: Desktop application framework (Rust backend + WebView frontend).

---

## Additional Dependencies

MeTerm relies on numerous open-source packages managed through npm (Node.js) and Cargo (Rust). Their respective licenses can be inspected via:

```bash
# Node.js dependencies
cd desktop && npx license-checker --summary

# Rust dependencies
cd desktop/src-tauri && cargo license
```

All dependencies are used in compliance with their respective licenses.

---

_Last updated: 2026-03-14_

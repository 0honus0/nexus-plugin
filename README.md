# Nexus 插件

本仓库交付 Nexus Terminal 的应用与扩展。插件通过宿主 SDK 注册能力，并通过依赖作用域使用其他插件提供的能力。

| 插件           | 作用                                           | 安装依赖                              |
| -------------- | ---------------------------------------------- | ------------------------------------- |
| SSH            | SSH 连接、终端流、SFTP 和转发服务              | —                                     |
| 认证管理       | 管理密码和 SSH 私钥                            | SSH                                   |
| 连接管理       | 管理 SSH、RDP、VNC 地址及连接标签              | 认证管理                              |
| Remote Tools   | SSH 命令、状态采样、归档与传输服务             | SSH                                   |
| 连接空间       | SSH 会话、文件列表、服务器状态与传输中心       | 认证管理、连接管理、SSH、Remote Tools |
| 文件管理器     | 独立的文件会话、文件预览、编码识别与原编码写回 | 连接空间                              |
| 远程桌面       | 原生 RDP、VNC 和可选的 Guacamole 转发          | 连接管理、认证管理                    |
| 通行密钥       | WebAuthn 登录                                  | —                                     |
| OpenID Connect | OIDC 登录                                      | —                                     |

在本体的插件市场中安装。安装前会展示依赖，文件管理器和连接空间使用同一套文件列表组件。配置 Guacamole 转发时，参考[远程桌面说明](plugins/remote-desktop/README.md)。

## 开发与审核

使用 Node.js 26.13.1 与 pnpm 12.18.0。SDK 与格式化工具由仓库的 `vendor/` 提供，测试宿主提交固定在 `scripts/ci/host-image.txt`。

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec playwright install chromium
pnpm test:plugin <插件目录名>
```

`plugins/<插件>/src/browser`、`src/node` 和 `src/shared` 分别放置浏览器实现、后端实现和跨端契约。插件测试放在本插件的 `tests/`。跨插件复用的纯展示组件放在 `shared/browser/`。`plugins/test` 是私有 SDK 测试夹具。

## 发布

依照 [AGENTS.md](AGENTS.md) 审核代码，校验插件清单、依赖约束和构建入口，运行格式检查、类型检查及对应测试。按依赖顺序发布，每个标签只选一个公开插件。例如 `ssh/v0.0.1`。

发布流程打包插件、验证产物校验值，在 GitHub Release 挂载版本文件，然后更新官方市场目录。无预发布后缀的版本在市场的稳定版本中显示。GitHub 的仓库级 Latest 标签由多个插件共用，插件的版本选择以市场目录为准。

- [插件发布](https://github.com/0honus0/nexus-plugin/releases)
- [官方插件目录](https://raw.githubusercontent.com/0honus0/nexus-plugin/catalog/catalog.json)

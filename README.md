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

在本体的插件市场中安装。安装前会展示依赖，文件管理器和连接空间使用同一套文件列表组件。配置 Guacamole 转发时，参考[远程桌面说明](docs/remote-desktop.md)。

- [开发、审核和发布](docs/development-and-release.md)
- [插件发布](https://github.com/0honus0/nexus-plugin/releases)
- [官方插件目录](https://raw.githubusercontent.com/0honus0/nexus-plugin/catalog/catalog.json)

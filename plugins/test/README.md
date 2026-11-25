# SDK 测试插件

测试使用宿主 `v0.0.16-dev` 对应镜像和 SDK `1.2.0`。SDK 压缩包固定在仓库的 `vendor/`，安装和构建无需链接本体源码。格式化继续共用本体的 `@nexus-terminal/format` 工具。

- 默认镜像由 `scripts/ci/host-image.txt` 固定到本体发布提交，可用 `NEXUS_TEST_IMAGE` 指定兼容镜像。
- SDK 压缩包为 `vendor/nexus-terminal-1.2.0.tgz`，完整性由锁文件校验。

## 运行

在插件仓库根目录执行。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm test:sdk
```

测试启动临时 Docker 宿主和 HTTP 插件仓库，通过市场安装测试插件及其依赖。认证夹具只有在测试宿主收到一次性随机凭证时才登记登录方式。结束时删除临时容器和数据卷。

## 远程 Windows Chrome 下载验证

`NEXUS_TEST_CDP` 和 `NEXUS_TEST_CDP_BIND` 用于连接外部浏览器及隔离测试宿主 relay。Workspace 原生 OpenSSH 用例可额外设置 `NEXUS_TEST_CDP_DOWNLOAD_DIR` 为 Windows 浏览器主机上每次运行独立、可写的绝对目录（例如 `C:/Users/Public/Downloads/Nexus-QA-unique-run`），显式启用实际落盘、SHA-256 和完成历史断言。仅设置当前临时浏览器 context 的下载行为，不覆盖已有默认 context。不能把 Linux runner 临时目录作为 Windows 浏览器下载目录；未提供该变量时 CDP 测试不声称验证本地磁盘内容。Windows 测试目录需要在浏览器主机上清理，Linux runner 不会删除远端文件。

## 覆盖

| 入口                        | 用例                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nexus-terminal/node`       | 插件激活、依赖服务和作用域清理、数据库迁移和读写、本地与密码加解密及失败契约、日志来源校验、HTTP 校验和二进制传输、WebSocket、状态登记与更新、备份和认证扩展   |
| `nexus-terminal/browser`    | JSON 和原始 HTTP、业务错误类型、状态订阅和撤销、任务结果与取消、文本和二进制 WebSocket、日志、依赖服务、登录贡献、窗口状态、标签及动作、关闭检查和视图资源清理 |
| `nexus-terminal/browser/ui` | 每个运行时导出均有检查，组件在宿主内实际挂载。验证表单、菜单、标签、进度、弹窗、缩放、通知、过渡、主题和 CSS 变量                                              |

公开的类型契约由实际前后端测试源码的 `vue-tsc` 检查覆盖。E2E 用例验证 API 能力，组件属性及第三方库选项的全部组合由各自的单元测试负责。

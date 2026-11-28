# 插件开发与发布

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

依照 [AGENTS.md](../AGENTS.md) 审核代码，校验插件清单、依赖约束和构建入口，运行格式检查、类型检查及对应测试。按依赖顺序发布，每个标签只选一个公开插件。例如 `ssh/v0.0.1`。

发布流程打包插件、验证产物校验值，在 GitHub Release 挂载版本文件，然后更新官方市场目录。无预发布后缀的版本在市场的稳定版本中显示。GitHub 的仓库级 Latest 标签由多个插件共用，插件的版本选择以市场目录为准。

- [插件发布](https://github.com/0honus0/nexus-plugin/releases)
- [官方插件目录](https://raw.githubusercontent.com/0honus0/nexus-plugin/catalog/catalog.json)

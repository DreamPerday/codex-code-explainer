# 第三方依赖

项目源码采用 [MIT License](LICENSE)。第三方依赖仍适用各自的许可证。

主要依赖包括 React、CodeMirror、Lezer、MCP SDK / MCP Apps SDK、Phosphor Icons、Zod、TypeScript 和 Tailwind CSS。具体版本及许可证标识见 `package-lock.json` 与各 npm 包。

构建会根据 esbuild 实际包含的包生成 `THIRD_PARTY_NOTICES.txt`，收集包的名称、版本、许可证标识以及发行包中的 LICENSE / NOTICE 文本，同时包含生成 CSS 使用的 Tailwind CSS。此文件与项目 LICENSE 一起放入插件和网页版发布包。打包时请保留它们。

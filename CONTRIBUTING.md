# 参与开发

推荐 Node.js 22+。安装并验证：

```sh
npm ci
npm run check
npm run build
npm test
```

独立网页用 `npm run web` 启动；Codex 插件的本机安装步骤见 README。测试使用临时目录和本地模拟接口，不需要你的 API Key 或 Codex 登录。手动测试真实模型时，请使用自己的配置，不要提交密钥、个人源码或用户偏好文件。

核心目录：`src/ui` 是两种版本共用的阅读界面，`src/web` 是本机 HTTP 服务与 API 设置，`src/server.ts` 是插件 MCP 入口，`src/project` 负责源码结构分析，`src/explanations` 管理解释任务与缓存。

提交问题时，请提供系统、Node.js 版本、所用版本及最小复现步骤；示例源码应去掉个人信息。提交修改时，请说明行为变化并运行相关检查。Windows 打包命令为 `npm run package:web` 和 `npm run package`。PR 会在 Windows / Linux 的 GitHub Actions 中构建并测试。

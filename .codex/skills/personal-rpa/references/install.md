# 安装

需要 Windows 和 Node.js 22.13+。安装分发的本地包：

```powershell
npm install -g .\personal-rpa-runtime-0.1.0.tgz
rpa-agent doctor
```

安装需要联网获取 npm 依赖及 SheetJS CDN 包。运行时不包含 Electron。Python 3.10+ 按需安装；无头浏览器需运行 `rpa-agent setup-browser`。有头默认使用本机 Chrome／Edge。

将包内 `skills/personal-rpa` 整个目录复制到目标 Agent 的 Skill 目录。保留 references、assets 和 agents：

- Codex：用户目录 `.agents/skills/personal-rpa`，或项目 `.agents/skills/personal-rpa`。已有版本使用 `.codex/skills` 时按宿主当前配置安装，避免重复加载。
- Claude Code：用户目录 `.claude/skills/personal-rpa`，或项目同名目录。
- Cursor：用户目录 `.cursor/skills/personal-rpa`，或项目同名目录。

也可在支持的宿主中导入 `personal-rpa-plugin-0.1.0.zip`；插件只包装 Skill，仍需先安装运行时。安装 npm 包不会修改 Agent 配置。更新时替换原有 Skill，避免装出多个副本。

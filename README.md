# Project Agent Team

在 Windows 项目里创建可通过普通 Codex `/resume` 接续的本机 Agent 团队。支持 16 类岗位、自选人数和协调者，沿用当前项目的 AGENTS.md；空项目也可以使用。

## 安装为个人技能

在 PowerShell 中运行以下命令，将仓库克隆到个人技能目录。如果使用自定义 Codex 技能目录，请替换目标路径。

```powershell
git clone https://github.com/litar77/project-agent-team.git "$env:USERPROFILE\.codex\skills\project-agent-team"
```

重新打开目标项目的 Codex 对话，输入：

```text
$project-agent-team 请为当前项目创建 1 名模块经理、2 名开发和 1 名测试，模块经理担任 Lead。先展示名册，然后建队，暂不派发任务。
```

## 使用终端向导

从目标项目的 PowerShell 运行：

```powershell
& "$env:USERPROFILE\.codex\skills\project-agent-team\Start-AgentTeam.ps1"
```

也可以将此仓库下载解压为项目下的 project-agent-team 文件夹，从项目根运行 `.\project-agent-team\Start-AgentTeam.ps1`。选择成员、协调者、权限与开窗方式。首次使用可先预览名册。

需要 Node.js 24.x 和兼容的原生 codex.exe。真实对话使用本机已有 Codex 认证。本地团队记录保存在目标项目的 .local/agent-teams/，请在目标项目忽略此路径。

[完整调用说明](SKILL.md) · [团队协作规范](scripts/agent-team/team-rules.md)
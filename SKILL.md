---
name: project-agent-team
description: 在当前 Windows 项目中按岗位、人数、目标和协调者创建一组可用普通 Codex resume 接续的本机开发 Agent，或预览、查看、接续已有团队。
---

# 项目开发团队

从本技能目录定位 `Start-AgentTeam.ps1`。始终将用户当前目标项目的绝对路径作为 `-ProjectRoot`，包括项目没有 Git 或 AGENTS.md 的情况。包内[团队协作规范](scripts/agent-team/team-rules.md)与该项目实际存在的 AGENTS.md 是成员的共同学习入口。个人账号、认证和模型沿用安装机已有 Codex 设置。

## 从对话建队

用非交互命令响应对话；交互式 Wizard 留给人直接在终端操作。先用 `-Action Status` 查看当前项目。用 `-Action Roles` 取得可用的岗位 ID 和命名前缀，将用户要求翻译成岗位数、团队名前缀、目标和协调者。岗位种类或目标不明确时，给出简短建议供选择。

在 PowerShell 中调用以下入口。将技能路径、项目路径、岗位、前缀和目标替换成实际值。使用参数传递原文。

```powershell
$tool = '技能目录\Start-AgentTeam.ps1'
$team = @{
  ProjectRoot = '项目绝对路径'
  Roles = 'module-manager=1,developer=2,tester=1'
  Prefix = 'App'
  Lead = 'App-Lead1'
  Objective = '交付本项目第一个可以演示的功能'
}
& $tool @team -Action Plan
```

Plan 只计算名册。用户已要求建队且名册符合指定范围时，运行 `& $tool @team -Action Create` 并检查退出码和结果；仅询问建议、能力或预览时留在 Plan。有指定岗位但没有指定负责人时，采用人类协调或按用户所述职责选择。Create 默认沿用原生权限，不打开窗口、不发模型任务。

已有相同团队可复用。已有不同团队时保留原名册，向用户说明可以在 Wizard 选择增员或另外建队。已知可续办的部分创建用 `-Action Continue`；遇到原生命令结果未知、记录不一致或工具占用，保留记录，先诊断原操作。禁止用删除记录或重建代替接续。输出岗位、负责人和实际状态，勿将私有会话 ID 发往外部。

## 安装与终端使用

将 ZIP 中整个 `project-agent-team` 目录解压至用户 Codex 技能目录（例如 `%USERPROFILE%\.codex\skills\`），重新打开目标项目的 Codex 对话后调用 `$project-agent-team`。也可以仅把该目录复制到项目根，在该项目的 PowerShell 执行 `.\project-agent-team\Start-AgentTeam.ps1`，按向导选择成员、协调者、权限及开窗方式。安装或复制工具不会代用户建队。

运行条件为 Windows、PowerShell、Node.js 24.x、已可用的原生 codex.exe（需支持 queue、app-server daemon/proxy、原生会话创建和指令写入），以及对目标项目本地状态目录的写权限。可用 `-NodeExecutable` 或 `-CodexExecutable` 指定已安装的可执行文件。工具依赖已随包提供，无需 npm install。

在项目终端启动普通 Codex，使用 `/resume` 选择向导显示的成员。成员可按准确名册用原生工具分派和回报。单独的岗位学习、真实对话和跨成员回报分别核对，一次建队成功只证明会话已创建。目标项目适用的规范、权限和技能要求仍由该项目决定。

# XiaoA — OpenCode 桌面桌宠

> ⚠️ **平台支持**：目前仅支持 **Windows** 系统（Windows 10 / 11，x64）。

桌面桌宠，实时显示 [OpenCode](https://opencode.ai) 的项目进度，并能在需要权限时弹出窗口一键允许 / 拒绝。

![XiaoA](assets/icon.png)

## ✨ 功能特性

- **桌宠动画**：`idle` / `thinking` / `working` 三种状态素材自动切换，使用相位同步的平滑动画，切换动作无缝连贯
- **进度弹窗**：实时显示当前会话、状态（工作中 / 思考中 / 已完成 / 出错 / 空闲）、正在执行的命令、最新输出 / 思考内容、工具调用统计、步骤进度条、模型名称
- **权限请求弹窗**：OpenCode 需要权限时自动弹出，可一键「允许 / 拒绝」，通过 opencode 服务器的 `/permission` API 完成回复
- **服务器自动发现**：自动发现并连接已运行的 opencode 服务器（桌面版 GUI 或 `opencode serve`），无需手动配置；无服务器时自动拉起 `4096` 端口的 CLI serve
- **会话管理**：自动跟随最新任务，或固定跟踪某个会话，支持直接删除会话
- **自定义桌宠**：上传 SVG / PNG 素材创建专属桌宠，内置「小A」角色
- **高度定制**：桌宠与弹窗尺寸（40% ~ 250%）、弹窗透明度、置顶开关、进度弹窗显隐
- **系统托盘 + 右键菜单**：托盘右键与桌宠右键均弹出完整菜单
- **双击桌宠**：快速切换进度弹窗显隐

## 💻 系统要求

- **操作系统**：仅支持 Windows 10 / 11（x64）
- **OpenCode**：需安装 [OpenCode](https://opencode.ai) CLI（`npm i -g opencode-ai`），或在 PATH 中提供可用的 opencode 服务器
- **依赖**：无需额外运行时，安装包已内置 Electron

> 暂不支持 macOS / Linux。

## 📦 安装

### 方式一：发行版安装包

在 [Releases](https://github.com/opencode-desktop-pet/releases) 下载 `XiaoA Setup 1.0.0.exe`（NSIS 安装包，支持自定义安装目录）。

### 方式二：自行打包

```bash
npm install
npm run dist   # 输出到 dist/
```

Windows 下若下载 Electron 二进制较慢，可配置镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

## 🚀 使用

1. 安装并运行 opencode CLI：`npm i -g opencode-ai`（需在 PATH 中）
2. 启动 XiaoA，它会自动发现正在运行的 opencode 服务器并显示任务进度
3. 在 opencode 中发起任务，桌宠弹窗实时同步状态

### 权限请求弹窗（演示）

在 opencode 配置中把某类操作设为 `ask`，例如读取 `.env`：

`%APPDATA%\opencode\opencode.jsonc`

```jsonc
{
  "permission": {
    "glob": "ask",
    "read": { "*.env": "ask" }
  }
}
```

当 opencode 需要该权限时，桌宠会弹出权限请求窗口，点击「允许 / 拒绝」即可，无需切回终端。

## 🔧 配置

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | 连接 opencode 服务器所需的 Basic Auth 密码（服务器开启认证时） |
| `OPENCODE_SERVER_USERNAME` | 上述用户名，默认 `opencode` |
| `OPENCODE_EXE` | 指定 opencode 可执行文件路径（可选，默认自动探测） |

### 本地配置

- 应用配置：`%APPDATA%\<应用名>\pet-config.json`（桌宠位置、尺寸、透明度、置顶、跟随状态等）
- 用户自定义桌宠图片：`%APPDATA%\<应用名>\pets\<桌宠名>\`（`idle/thinking/working` 各一张）

## 🧩 项目结构

```
├── main.js                  # 主进程：窗口管理、服务器发现、权限轮询/回复、SSE 事件
├── preload.js               # contextBridge 向渲染进程暴露 petAPI
├── package.json             # 项目与打包配置（electron-builder）
├── renderer/
│   ├── pet.html / pet.js        # 桌宠本体与动画
│   ├── popup.html / popup.js    # 进度弹窗与会话切换
│   ├── permission.html / permission.js  # 权限请求弹窗
│   ├── menu.html / menu.js      # 自定义右键菜单
│   └── create.html / create.js  # 创建桌宠窗口
└── assets/
    ├── icon.ico / icon.png / tray.png
    ├── default-pet.svg
    └── characters/default/      # 内置桌宠「小A」三态素材
```

## 🏗 权限流程（架构说明）

- 主进程每 6 秒轮询 opencode 服务器的 `/session`，并按目录查询 `/permission?directory=`，跨会话可靠捕获所有待批准的权限请求
- 弹出权限窗口后，允许 / 拒绝通过 `POST /permission/{id}/reply?directory=` 回复（`{ "reply": "once" | "reject" }`）
- 同时订阅服务器 SSE（`/global/event`）的 `permission.updated` / `permission.replied`，加快弹窗开合响应

## 🧪 开发

```bash
npm install
npm start      # 以源码方式运行
npm run smoke  # 冒烟测试（SMOKE_TEST=1，8 秒后输出 state.progress 并退出）
```

## 📄 许可

[MIT](LICENSE)
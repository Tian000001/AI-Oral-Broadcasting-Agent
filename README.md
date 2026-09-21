<div align="center">

# TTQ-Video

**输入主题或文案，自动生成短视频。**

脚本 → 配音 → 字幕 → 素材 → 成片，一条流水线跑完；并在其之上扩展了「口播智能体」与「口播视频工作台」。

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/API-FastAPI-009688?logo=fastapi&logoColor=white)
![Remotion](https://img.shields.io/badge/Video-Remotion-0B84F3)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

[中文](README.md) · [English](README-en.md)

</div>

---

## 简介

TTQ-Video 是基于开源项目 [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) 二次开发的自动化短视频生成工具。

给它一个主题或一段文案，它会自动完成 **脚本撰写 → 配音合成 → 字幕生成 → 素材匹配 → 视频合成** 的完整流程。在此之上，本项目还构建了面向真人口播场景的「口播智能体」与「口播视频工作台（TalkStudio）」，支持场景化文案、数字人、声音克隆与可视化导出。

> 本项目已脱离上游仓库独立演进，不做任何上游版本检查或自动更新。

## 功能特性

### 1. AI 短视频一键成片
- **文案与素材词**：LLM 自动生成，支持 MoonShot（默认）、OpenAI、DeepSeek、通义千问、Azure OpenAI、SiliconFlow、Ollama 本地模型、OneAPI 等（预设见 `app/models/llm_provider.py`）。
- **多引擎配音**：Edge TTS（默认，免 Key）、Azure Speech、SiliconFlow、MiniMax、ElevenLabs、Chatterbox、Gemini，以及本地 XTTS / CosyVoice 声音克隆。
- **自动字幕**：Whisper（默认 large-v3，CPU int8 可用；模型缺失时自动下载到 `models/`）。
- **素材来源**：Pexels / Pixabay / Coverr 在线素材，或本地图片 / 视频；可选 TwelveLabs 语义重排。
- **成片合成**：MoviePy 拼接，支持 BGM（Sonilo / 本地歌曲）、转场与视频特效。

### 2. 口播智能体
- **调度看板**：优先级队列、失败重试、人工复审、取消；任务状态存 Redis，进程重启自动收敛中断任务。
- **人设与合规**：人设（Persona）管理、合规审查、参考素材抓取（yt-dlp）、标题与封面生成。
- **供应商能力登记**：一家供应商可挂多个模型，支持在线拉取模型 / 音色列表。

### 3. 口播视频工作台（TalkStudio）
- **数据驱动的场景时间线**：每个节点是一段 `scenes[]` JSON，改 JSON 即改视频。
- **实时预览**：基于 Remotion `<Player>`，预览与导出同渲染、所见即所得。
- **场景级精细化**：文字样式（颜色 / 字号 / 版式）、画中画、口播叠加方式、**场景级视频插入**均可按节点单独覆盖。
- **一键导出**：完整成片 MP4，或透明叠加层 MOV（ProRes 4444 + Alpha，供剪映进一步合成）。
- **成片归档**：导出的成片可直接存入「资产管理」，便于二次复用。

### 4. 科技视频 / 自动视频
- 文案驱动的动态视频（Remotion），支持图表、时间线、对比等场景模板。
- 交叉合成 / 背景口播 / 画中画等口播叠加方式。

### 5. 三种使用方式
- **WebUI**：浏览器打开 <http://127.0.0.1:8080/>
- **REST API**：交互式文档 <http://127.0.0.1:8080/docs>（统一前缀 `/api/v1`）
- **命令行 CLI**：见下文

## 环境要求

| 组件 | 说明 |
| --- | --- |
| 操作系统 | Windows 10/11（一键脚本为 `.bat`；其它平台可手动启动后端） |
| Python | 3.11 —— Windows 发行包内置 `python/`（3.11.15），无需另装 |
| ffmpeg | 内置 `ffmpeg/ffmpeg-7.0-essentials_build`；非 Windows 需自行安装并加入 PATH |
| Redis | 任务状态与队列依赖，默认连接本机 Redis（可用 `MPT_APP_REDIS_HOST` / `REDIS_HOST` 指向其它实例） |
| Node.js | 「口播视频 / 科技视频」的离线渲染与前端构建需要（建议 Node 18+） |
| API Keys | 按需配置 LLM、素材平台等 Key，见「配置说明」 |

> **不随源码分发的内容**：`python/`、`ffmpeg/`、`models/` 体积较大；`resource/fonts/` 中的专有字体（微软雅黑 / 华文黑体等 `.ttc`）与 `resource/songs/` 内置 BGM 还涉及第三方版权。以上均已通过 `.gitignore` 排除，请使用官方发行包，或自行准备运行时、模型与字库。
> 字幕默认字体为 `STHeitiMedium.ttc`，若未提供，请替换为你拥有授权的字体（见 `config.toml` 的 `[ui]` / 字幕设置）。

## 快速开始

1. 复制配置模板并填入所需 Key：

   ```bat
   copy config.example.toml config.toml
   ```

   > `config.toml` 含密钥，已被 `.gitignore` 忽略，**切勿提交**。

2. 双击 `start_app.bat`。脚本会自动：释放 8080 端口占用 → 在新窗口启动后端（实时日志）→ 等待就绪并自检 → 打开浏览器。

3. 或手动启动后端：

   ```bash
   python\python.exe main.py
   ```

   然后访问 <http://127.0.0.1:8080/>。若浏览器打不开，试试 <http://localhost:8080/>，并为 localhost 关闭代理。

## 前端构建（口播 / 科技视频）

浏览器端页面由 `techvideo/` 使用 esbuild 打包。仓库已内置构建产物，开箱即用；**修改 `techvideo/src` 后需重新构建**：

```bash
cd techvideo
npm install
npm run web:build     # 等价于 node build.mjs
```

产物输出到 `resource/public/koubo/`（口播工作台）与 `resource/public/techvideo/`（科技视频），两者互相独立。
离线渲染（导出 MP4）同样依赖 `techvideo/node_modules`，请确保已执行 `npm install`。

## 命令行（CLI）

```bat
:: 按主题生成完整视频（默认 Edge TTS，免 Key）
python\python.exe -m app.cli --video-subject "How AI is changing everyday life"

:: 本地素材 + 完整文案，无配音，直接合成
python\python.exe -m app.cli --video-script "你的完整文案" ^
  --video-source local --video-materials "./1.mp4,./2.mp4" ^
  --voice-name no-voice --stop-at video

:: 只跑到脚本阶段（流水线：script → terms → audio → subtitle → materials → video）
python\python.exe -m app.cli --video-subject "主题" --stop-at script
```

查看全部参数：`python\python.exe -m app.cli --help`

## API 概览

服务统一前缀 `/api/v1`，启动后可在 `/docs` 查看完整交互式文档：

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 视频任务 | `/api/v1/videos`、`/api/v1/tasks`、`/api/v1/stream`、`/api/v1/download` | 提交生成任务、查询 / 删除、成片流式播放与下载 |
| 口播智能体 | `/api/v1/agent/*` | 调度看板、人设、合规、参考素材、标题封面、TTS 试听、供应商登记 |
| 科技视频 / 口播工作台 | `/api/v1/techvideo/*` | 上传素材、脚本生成、离线渲染、生成画廊、成片归档 |
| 素材搜索 | `/api/v1/stock/*` | 关键词提取、Pexels 图片 / 视频搜索 |
| 资产管理 | `/api/v1/agent/assets` | 图片 / 声音 / 视频资产的上传、列表、删除 |
| 其它 | `/api/v1/llm/*`、`/api/v1/fonts`、`/api/v1/system` | LLM 对话、字体列表、系统配置 |

静态挂载：`/`（WebUI）、`/tasks`（任务产物）、`/koubo/`（口播工作台）、`/techvideo/`（科技视频）、`/techvideo-public`（上传素材）、`/techvideo-media` 与 `/techvideo-videos`（音轨与成片）。

## 配置说明

复制 `config.example.toml` 为 `config.toml`（WebUI 内也可修改基础配置）。主要段落：

| 段落 | 内容 |
| --- | --- |
| `[app]` | 通用设置、素材源与其 API Key、LLM 提供商、redis_host、监听地址与端口 |
| `[whisper]` | 字幕模型（model_size / device / compute_type） |
| `[proxy]` | 素材请求代理 |
| `[azure]` `[siliconflow]` `[minimax_tts]` `[elevenlabs]` `[chatterbox]` | 各 TTS 服务的 Key 与参数 |
| `[agent]` `[persona]` `[digital_human]` `[voice_clone.*]` `[compliance]` `[publishing]` `[reference]` `[title_cover]` | 口播智能体相关（人设、数字人、声音克隆、合规、发布） |
| `[ui]` | 界面定制 |

## 目录结构

```
MoneyPrinterTurbo/
├── main.py                     # 后端入口（uvicorn，默认 0.0.0.0:8080）
├── start_app.bat               # Windows 一键启动
├── app/
│   ├── cli.py                  # 命令行入口（python -m app.cli）
│   ├── wait_port.py            # 端口就绪探测（start_app.bat 调用）
│   ├── asgi.py                 # FastAPI 应用与静态目录挂载
│   ├── router.py               # 路由注册
│   ├── controllers/v1/         # API 控制器（video / agent / asset / techvideo / stock / llm / fonts / system）
│   ├── services/               # 业务服务（脚本 / 配音 / 字幕 / 素材 / 合成 / 任务 / 智能体）
│   ├── models/                 # 数据模型与 LLM 供应商预设
│   ├── config/                 # config.toml 加载
│   └── utils/
├── resource/
│   ├── public/                 # WebUI 静态页面（含构建产物 koubo/、techvideo/）
│   ├── fonts/  songs/  forbidden_words/
├── techvideo/                  # Remotion 子项目（源码 + 离线渲染脚本 + 构建脚本）
├── test/                       # 单元测试
├── models/                     # 本地模型（whisper-large-v3，不入库）
├── ffmpeg/                     # 内置 ffmpeg 7.0（不入库）
├── python/                     # 内置 Python 3.11.15（不入库）
├── storage/                    # 运行产物（不入库）
├── config.example.toml         # 配置模板
├── requirements.txt / pyproject.toml
└── LICENSE
```

## 测试

```bash
# pytest（CI 方式，需安装 dev 依赖组）
uv run python -X utf8 -m pytest -q test

# 用内置运行时直接跑 unittest（无需安装 pytest）
python\python.exe -m unittest test.services.test_cli
```

## 版本约定

版本号唯一来源为 `app/__init__.py` 的 `__version__`，采用十进制三段式 `major.minor.patch`；每次修改后调用 `bump_version()` 自增（逢 9 进位，如 `1.9.9 → 2.0.0`）。

## 常见问题

- **浏览器打不开 / 页面空白**：先确认后端窗口（`MPT-Backend`）无报错；再试 <http://localhost:8080/> 并为 localhost 关闭代理。
- **改了前端代码没生效**：静态资源是构建产物，需在 `techvideo/` 下重新 `npm run web:build`，然后浏览器硬刷新（`Ctrl/Cmd + Shift + R`）。
- **改了后端代码没生效**：默认 `reload_debug=False`，不热重载，需重启后端。
- **导出视频报错找不到 node**：安装 Node.js 并确保 `node` 在 PATH 中，或在 `config.toml` 的 `[app]` 段配置 `techvideo_node_path`。
- **控制台反复出现 `WinError 10054`**：浏览器取消 / 刷新大文件下载导致的对端断连，属良性噪声，已在 `main.py` 中静默处理。

## 参与贡献

欢迎提交 Issue 与 Pull Request。

1. Fork 本仓库并新建分支：`git checkout -b feat/your-feature`
2. 提交前确保测试通过；涉及前端改动的，请一并重新构建产物。
3. 若修改了代码，请按「版本约定」自增版本号。

## 免责声明

- 本项目仅供学习与技术研究使用，请勿用于任何违法或侵权用途。
- 使用本项目生成内容时，请遵守所在地区法律法规及各第三方平台（LLM、TTS、素材、发布平台等）的服务条款；由此产生的任何后果由使用者自行承担。
- 请勿使用本项目生成、传播虚假信息、侵权内容或违背公序良俗的内容。
- 软件按「原样」提供，不附带任何明示或暗示的担保。

## 致谢

- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) —— 本项目的上游基础。
- [Remotion](https://www.remotion.dev)、[FastAPI](https://fastapi.tiangolo.com)、[MoviePy](https://zulko.github.io/moviepy/)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper) 等优秀开源项目。

## License

[MIT](LICENSE) —— 沿用上游 MoneyPrinterTurbo 的许可证。

---

如果这个项目对你有帮助，欢迎点一个 ⭐ Star。

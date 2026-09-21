# 科技视频生成器（techvideo）

基于 [Remotion](https://www.remotion.dev) 的「文案驱动动态视频」子项目，已从 `F:\TTQ\Remotion`
迁移到本仓库根目录的 `techvideo/`，作为 **TTQ-Video 的独立子项目**（不依赖原视频生成流水线）。

## 功能

- 左侧编辑「配色 + 场景脚本」（每个场景含标题与若干要点），右侧 `<Player>` 实时预览 1920×1080 / 30fps 的动态视频卡片。
- 一键导出 MP4：前端「渲染并下载 MP4」→ 后端 `POST /api/v1/techvideo/render` → 本地离线 Remotion 渲染（复用已缓存的 headless Chrome / compositor，无需联网下载）。

## 目录结构

```
techvideo/
├── src/
│   ├── App.tsx            # 播放器页面 UI（控件 + <Player> + 导出）
│   ├── main.tsx           # 浏览器入口
│   ├── styles.css         # 页面样式（深色科技风）
│   ├── PlanVideo.tsx      # 核心视频组件（场景卡片动画）
│   ├── HelloWorld/        # 迁移自原 Remotion 的装饰组件（Backdrop/Logo 等）
│   ├── Root.tsx           # Remotion 组合注册（供 studio / bundle 使用）
│   └── index.ts           # registerRoot 入口
├── build.mjs              # 用 esbuild 打包静态播放器页面
├── render-node.mjs        # 后端调用的 Node 离线渲染脚本
└── package.json
```

## 依赖说明（重要 · 可独立拷贝）

`techvideo/` 已经是 **完全独立** 的子项目，自带 `node_modules/`（已 `npm install`，约 731MB）
与 `package-lock.json`（锁定依赖版本，保证异地复现）。

- **拷贝到别处**：直接整体复制 `techvideo/` 目录即可。由于 `.gitignore` 忽略了 `node_modules`，
  建议连同 `package-lock.json` 一起打包，到目标机器后执行 `npm install`（可离线复现锁定版本，
  或联网拉取）。
- 本地已验证：`npm run web:build`（esbuild 打包）与后端 `POST /api/v1/techvideo/render`
  （Node 离线渲染）在独立依赖下均正常工作。
- **首次渲染需 Chrome**：Remotion 渲染依赖 headless Chrome，首次运行会自动下载约 113MB
  （缓存于用户目录 `~/.cache/remotion`，不随项目走）。**目标机器若完全离线且未预置 Chrome，
  渲染会失败** —— 需保证首次渲染时网络可用，或提前在该机器上跑一次渲染以预热缓存。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Remotion Studio（交互式编辑/预览/渲染，默认 3000 端口） |
| `npm run web:build` | esbuild 打包静态播放器页面 → `../resource/public/techvideo/` |
| `npm run render` | Remotion CLI 离线渲染（等价于后端渲染逻辑） |
| `npm run build` | `remotion bundle`（如需 SSR / serveUrl） |

## 与主前端集成

- 主前端导航「科技视频」位于「标题封面」之后；视图用 `<iframe src="/techvideo/">` 嵌入。
- 静态页面由 FastAPI 的 `StaticFiles`（挂载 `resource/public/`）在 `/techvideo/` 提供。
- 导出走**后端 Node 离线渲染**，而非浏览器内渲染（浏览器内渲染需 COOP/COEP 响应头，静态托管不支持）。

## 已知约束

- 预览是纯客户端渲染；导出为服务器端渲染，单次渲染耗时随场景数量增加（约每场景 4 秒）。
- 后端渲染会临时在 `storage/techvideo/` 写出 MP4 并随响应返回。

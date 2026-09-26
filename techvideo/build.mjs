// 用 esbuild 把 React + @remotion/player 的播放器页面打包成静态文件。
// 输出两个完全独立的入口：
//   - ../resource/public/techvideo/   科技视频 / 自动视频（原 App.tsx）
//   - ../resource/public/koubo/       口播视频工作台（独立 TalkStudio）
// 两者代码隔离，修改口播视频不会影响科技视频。
// 依赖来自 techvideo/node_modules（首次使用请先在本目录执行 npm install）。
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 依赖目录：使用 techvideo/ 自身的 node_modules（`npm install` 产物）。
// 注意：旧版本曾硬编码指向作者的本地目录 F:/TTQ/Remotion/node_modules，
// 对其它环境与开源用户不可用；这里改为按本目录解析，保证 clone 后可构建。
const LOCAL_NODE_MODULES = resolve(__dirname, "node_modules");

// 读取项目版本号，给 HTML 资源加缓存戳。
const appInitPath = resolve(__dirname, "../app/__init__.py");
let VERSION = "1.0.0";
try {
  const initText = readFileSync(appInitPath, "utf-8");
  const m = initText.match(/__version__\s*=\s*"([^"]+)"/);
  if (m) VERSION = m[1];
} catch {}

const errorHtml = `
  <div id="boot-error" style="display:none;position:fixed;inset:0;background:#0b0f17;color:#f87171;font-family:system-ui,sans-serif;padding:40px;white-space:pre-wrap;overflow:auto;z-index:9999"></div>
  <script>
    window.addEventListener('error', function(e) {
      var el = document.getElementById('boot-error');
      if (el) { el.style.display = 'block'; el.textContent += 'ERROR: ' + e.message + '\\n' + (e.filename || '') + ':' + (e.lineno || '') + '\\n\\n'; }
    });
    window.addEventListener('unhandledrejection', function(e) {
      var el = document.getElementById('boot-error');
      if (el) { el.style.display = 'block'; el.textContent += 'UNHANDLED REJECTION: ' + (e.reason && e.reason.stack ? e.reason.stack : String(e.reason)) + '\\n\\n'; }
    });
  </script>`;

async function buildView({ name, entry, outdir, title }) {
  mkdirSync(outdir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: { main: resolve(__dirname, entry) },
    bundle: true,
    outdir,
    format: "esm",
    platform: "browser",
    target: ["esnext"],
    jsx: "automatic",
    nodePaths: [LOCAL_NODE_MODULES],
    loader: { ".css": "css" },
    minify: true,
    treeShaking: true,
    sourcemap: false,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
  });

  // 按产物内容算短哈希拼进 ?v=，任何代码改动都自动破缓存（避免改了不生效）。
  let stamp = VERSION;
  try {
    const js = readFileSync(resolve(outdir, "main.js"));
    const css = readFileSync(resolve(outdir, "main.css"));
    const h = createHash("sha256").update(js).update(css).digest("hex").slice(0, 8);
    stamp = `${VERSION}-${h}`;
  } catch {}

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="./main.css?v=${stamp}" />
</head>
<body>
  <div id="root"></div>
${errorHtml}
  <script type="module" src="./main.js?v=${stamp}"></script>
</body>
</html>`;

  writeFileSync(resolve(outdir, "index.html"), html, "utf-8");
  return result;
}

const r1 = await buildView({
  name: "techvideo",
  entry: "src/main.tsx",
  outdir: resolve(__dirname, "../resource/public/techvideo"),
  title: "科技视频生成器",
});

const r2 = await buildView({
  name: "koubo",
  entry: "src/koubo.tsx",
  outdir: resolve(__dirname, "../resource/public/koubo"),
  title: "口播视频工作台",
});

console.log("✅ 已构建:", r1.outputFiles?.length ?? "done", "(techvideo)", r2.outputFiles?.length ?? "done", "(koubo)");
if (r1.warnings.length) console.warn("⚠️ techvideo 警告:", r1.warnings);
if (r2.warnings.length) console.warn("⚠️ koubo 警告:", r2.warnings);

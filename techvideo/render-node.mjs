// 由后端（Python）调用的 Node 渲染脚本：
// 1) 用 @remotion/bundler 打包 PlanVideo 组合（读取 remotion.config.ts）。
// 2) getComposition 取得组合配置，并按传入 scenes 数量修正 durationInFrames
//    （CLI 的 calculateMetadata 仅基于默认 props，无法感知 --props-file，故这里显式覆盖）。
// 3) renderMedia 在本地离线渲染为 MP4（复用已缓存的 headless Chrome / compositor）。
//
// 用法：node render-node.mjs <output.mp4> <props.json>
import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , outPath, propsFile] = process.argv;
if (!outPath || !propsFile) {
  console.error("usage: node render-node.mjs <output.mp4> <props.json>");
  process.exit(1);
}

const inputProps = JSON.parse(await readFile(propsFile, "utf-8"));

// 透明底导出：MOV + ProRes 4444（带 alpha 通道）。
// 之前用 WebM(vp9+alpha)，但剪映不支持 VP9 的 alpha 通道（导入后仍显示黑底），
// 换成剪辑软件通吃的 ProRes 4444（Premiere/FCP/剪映均识别）。
const transparent = !!inputProps.transparent;

const bundleLocation = await bundle({
  entryPoint: resolve("src/index.ts"),
});

const compositions = await getCompositions(bundleLocation, { inputProps });
// 9:16（抖音竖屏）使用独立竖版合成 PlanVideoV；其余用默认 16:9。
const aspect = (inputProps.aspect || "16:9").trim();
const compositionId = aspect === "9:16" ? "PlanVideoV" : "PlanVideo";
const composition = compositions.find((c) => c.id === compositionId);
if (!composition) {
  console.error(`composition ${compositionId} not found`);
  process.exit(1);
}

// 显式按各场景时长求和修正总时长（场景帧数由后端配音/估算给出），
// 确保导出与预览一致，并与配音/字幕时间轴对齐。
// 若传入口播素材时长（personVideoDuration>0），则以素材时长为总时长准绳，
// 保证「整体时长=口播素材时长」，不裁剪素材（前端已把文本场景时长按此重分配）。
const scenes = inputProps.scenes || [];
const personVideo = (inputProps.personVideo || "").trim();
const pvd = Number(inputProps.personVideoDuration || 0);
if (personVideo && pvd > 0) {
  composition.durationInFrames = Math.max(30, Math.round(pvd * 30));
} else {
  composition.durationInFrames = scenes.length
    ? scenes.reduce(
        (acc, s) => acc + Math.max(30, Math.round(s.durationFrames || 90)),
        0,
      )
    : 360;
}

await renderMedia({
  composition,
  serveUrl: bundleLocation,
  inputProps,
  outputLocation: resolve(outPath),
  codec: transparent ? "prores" : "h264",
  // 透明底导出（ProRes 4444）三件套：
  // 1) imageFormat=png：帧截图带 alpha（默认 jpeg 无透明通道）
  // 2) pixelFormat=yuva444p10le：ProRes 4444 保留 alpha 的像素格式
  //    （注意不是 WebM 用的 yuva420p——pixel-format 校验对非 vp8/vp9 编码直接拒绝 yuva420p）
  // 3) proResProfile=4444：ProRes 中唯一支持 alpha 的 profile（默认 hq 无透明）
  // 注：Remotion 4.0.512 的 renderMedia 已移除 `transparent` 参数，传了也会被忽略，
  // 透明与否完全由 imageFormat(png) + pixelFormat(yuva*) 决定。
  imageFormat: transparent ? "png" : "jpeg",
  pixelFormat: transparent ? "yuva444p10le" : undefined,
  proResProfile: transparent ? "4444" : undefined,
  concurrency: 1,
  overwrite: true,
});

console.log("RENDER_DONE");

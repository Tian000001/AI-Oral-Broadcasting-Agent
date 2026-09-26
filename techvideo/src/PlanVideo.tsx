import { useId, type CSSProperties } from "react";
import {
  AbsoluteFill,
  Audio,
  getRemotionEnvironment,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Video,
} from "remotion";
import { z } from "zod";
import { Backdrop } from "./HelloWorld/Backdrop";
import { LibraryScene } from "./SceneLibrary";
import { LIBRARY_TYPES } from "./sceneAssets";

export type BgTheme = "dark" | "light";

// 背景主题对应的文字/装饰配色：dark=黑底浅字，light=白底深字。
export const paletteFor = (t: BgTheme = "dark") =>
  t === "dark"
    ? {
        bg: "#000000",
        title: "#f5f7fa",
        body: "#c2cad6",
        value: "#eef1f6",
        label: "#9aa3b2",
        dot: "#39414f",
        subBg: "rgba(20,24,31,0.82)",
        subText: "#ffffff",
        pieStroke: "#ffffff",
      }
    : {
        bg: "#ffffff",
        title: "#14181f",
        body: "#3a4250",
        value: "#1b2030",
        label: "#5a6473",
        dot: "#dcdcdc",
        subBg: "rgba(0,0,0,0.06)",
        subText: "#14181f",
        pieStroke: "#d8dce2",
      };

export const DEFAULT_SCENE_FRAMES = 90; // 3s @ 30fps，无时长时的兜底

// 画中画小窗九宫格定位：tl/tc/tr=上，ml/center/mr=中，bl/bc/br=下；边距固定 4%。
export function pipPosStyle(pos: string): CSSProperties {
  const m = "4%";
  const cx = { left: "50%", transform: "translateX(-50%)" };
  const cy = { top: "50%", transform: "translateY(-50%)" };
  const cxy = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  switch (pos) {
    case "tl": return { top: m, left: m };
    case "tc": return { top: m, ...cx };
    case "tr": return { top: m, right: m };
    case "ml": return { ...cy, left: m };
    case "center": return { ...cxy };
    case "mr": return { ...cy, right: m };
    case "bl": return { bottom: m, left: m };
    case "bc": return { bottom: m, ...cx };
    case "br":
    default: return { bottom: m, right: m };
  }
}

// 标题字体族（与整体一致）。
const TITLE_FONT =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

// 标题自动缩字号：测量文本宽度，过长则逐步缩小，确保不溢出画面（兜底最小 28px）。
// 配合 CSS 的 white-space: pre-wrap，多行标题也会优雅换行。
function fitTitleFont(text: string, base: number, maxWidth: number): number {
  const min = Math.max(28, Math.round(base * 0.4));
  if (typeof document === "undefined" || !text) return base;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return base;
    let size = base;
    while (size > min) {
      ctx.font = `800 ${size}px ${TITLE_FONT}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 4;
    }
    return size;
  } catch {
    return base;
  }
}

export const subtitleSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const chartSeriesSchema = z.object({
  name: z.string(),
  values: z.array(z.number()),
});

export const chartSchema = z.object({
  kind: z.enum(["bar", "line", "pie", "radar", "stacked", "area"]),
  unit: z.string().optional(),
  labels: z.array(z.string()),
  values: z.array(z.number()),
  series: z.array(chartSeriesSchema).optional(),
});

export const eventSchema = z.object({
  time: z.string(),
  text: z.string(),
});

export const columnSchema = z.object({
  name: z.string(),
  items: z.array(z.string()),
});

// —— 素材库新增构件的子结构 ——
export const barItemSchema = z.object({
  label: z.string(),
  value: z.number(),
});

export const cardItemSchema = z.object({
  emoji: z.string().optional(),
  title: z.string().optional(),
  desc: z.string().optional(),
});

export const chatMessageSchema = z.object({
  side: z.enum(["me", "other"]).optional(),
  from: z.string().optional(),
  text: z.string(),
});

export const sceneSchema = z.object({
  type: z.string(),
  title: z.string(),
  points: z.array(z.string()),
  narration: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  subtitles: z.array(subtitleSchema).optional(),
  chart: chartSchema.optional(),
  durationFrames: z.number().optional(),
  // —— 新增场景类型字段 ——
  imageUrl: z.string().optional(), // 图片卡：图片地址（URL 或 public 下路径）
  caption: z.string().optional(), // 图片卡/通用：说明文字
  quote: z.string().optional(), // 金句卡：大字强调
  events: z.array(eventSchema).optional(), // 时间线
  columns: z.array(columnSchema).optional(), // 对比：多列
  source: z.string().optional(), // 引用：被引内容
  author: z.string().optional(), // 引用：出处/作者
  // —— 样式参数化（白名单优先 + 允许自定义色值）——
  color1: z.string().optional(), // 场景级主色覆盖
  color2: z.string().optional(), // 场景级辅色覆盖
  fontScale: z.number().optional(), // 字号缩放（默认 1）
  titleScale: z.number().optional(), // 标题单独字号缩放（默认 1，专治标题过大）
  layout: z.enum(["center", "left", "right", "split", "top", "bottom", "card", "magazine"]).optional(), // 版式（v1.9.2 起扩到 8 种）
  animation: z
    .enum(["fade", "slide", "zoom", "blur", "wipe", "flip", "iris", "none"])
    .optional(), // 入场动效（含素材库新增 flip/iris）
  // —— 素材库新增构件字段（P2）——
  revealSpeed: z.number().optional(), // typewriter/code：每秒揭示字数
  counterTo: z.number().optional(), // counter：目标数值
  counterFrom: z.number().optional(), // counter：起始数值（默认 0）
  counterPrefix: z.string().optional(), // counter：前缀
  counterSuffix: z.string().optional(), // counter：后缀（单位）
  counterDecimals: z.number().optional(), // counter：小数位
  percent: z.number().optional(), // ring：百分比 0-100
  bars: z.array(barItemSchema).optional(), // bars：数据条
  cards: z.array(cardItemSchema).optional(), // cards：卡片网格
  code: z.string().optional(), // code：代码正文
  codeLang: z.string().optional(), // code：语言标注（仅显示用）
  messages: z.array(chatMessageSchema).optional(), // chat：对话气泡
  // —— 节奏标记（P1）——
  durationSec: z.number().optional(), // 建议时长（秒）
  emphasis: z.array(z.string()).optional(), // 强调词（视觉放大）
  // —— 封面模板（P3）/ AI 配图插页（P4）——
  kicker: z.string().optional(), // 封面眉标（栏目标签）
  imagePrompt: z.string().optional(), // AI 配图提示词
  // —— 场景级文字精细化（v1.9.2 新增）：每场景可独立覆盖文字色 + 字号 —
  kickerColor: z.string().optional(), // 眉标色（缺省用 c1）
  titleColor: z.string().optional(), // 标题色（缺省用 P.title）
  pointsColor: z.string().optional(), // 要点文字色（缺省用 P.body）
  quoteColor: z.string().optional(), // 金句/引用色（缺省用 P.title）
  captionColor: z.string().optional(), // 说明/图片说明色（缺省用 P.body）
  narrationColor: z.string().optional(), // 旁白色（缺省用 P.body）
  kickerScale: z.number().min(0.5).max(2.5).optional(), // 眉标字号倍率（1=基准）
  pointsScale: z.number().min(0.5).max(2.5).optional(), // 要点字号倍率
  quoteScale: z.number().min(0.5).max(2.5).optional(), // 金句字号倍率
  // —— 场景级口播叠加方式（缺省=跟随全局 videoLayout）——
  videoLayout: z.enum(["underlay", "cross-cut", "pip"]).optional(),
  // —— 场景级画中画小窗覆盖（仅本场景为 pip 时生效；缺省=跟随全局 pipSize/pipPos）——
  pipSize: z.number().min(8).max(80).optional(),
  pipPos: z.enum(["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"]).optional(),
  // —— 场景级视频覆盖（v1.9.4 新增）：本节点可插自己的视频（如某章节的 B-roll），
  //     留空则回退全局 personVideo。切换时视频从头播放（key 变化触发重挂载）。
  sceneVideo: z.string().optional(),
});

export const planSchema = z.object({
  color1: z.string(),
  color2: z.string(),
  audioSrc: z.string().optional(),
  scenes: z.array(sceneSchema),
  bgTheme: z.enum(["dark", "light"]).optional(),
  watermark: z.string().optional(),
  // 自动视频：口播素材叠加
  personVideo: z.string().optional(), // 口播素材相对路径 uploads/xxx.mp4（或远程 URL）
  personVideoDuration: z.number().optional(), // 口播素材时长（秒）；>0 时整体时长以此为准
  videoLayout: z.enum(["cross-cut", "pip", "underlay"]).optional(), // 硬切 / 画中画 / 底片混排
  aspect: z.enum(["16:9", "9:16"]).optional(),
  transition: z.enum(["fade", "slide", "zoom", "blur", "wipe", "flip", "iris", "none"]).optional(), // 统一转场（P3 + 素材库 flip/iris）
  // —— 预览/导出 显示开关（隐藏字幕 / 隐藏旁白）——
  showSubtitle: z.boolean().optional(), // 是否渲染底部字幕条（默认 true）
  showNarration: z.boolean().optional(), // 是否在内容区显示旁白说明（默认 true）
  transparent: z.boolean().optional(), // 透明底导出：仅渲染文字卡片叠加层（不烘焙口播底片），供进剪映合成
  videoDim: z.number().optional(), // underlay 视频压暗强度（0-100%）。0=原亮度直出（预览与导出一致）
  // —— 画中画（pip）小窗参数：大小=正方形边长占宽比；位置=九宫格（缺省 br 右下）——
  pipSize: z.number().min(8).max(80).optional(),
  pipPos: z.enum(["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"]).optional(),
});

// 媒体路径解析：远程 URL 直用；本地相对路径在浏览器预览（Player）拼 /techvideo-public/，
// 在 Remotion Studio / 离线渲染用 staticFile（techvideo/public 由 Remotion 在 serveUrl 根提供）。
//
// 关键：不能用 `typeof window === "undefined"` 区分——离线渲染也运行在真实 Chrome 里
// （window 已定义，origin 为 localhost:3001 的 Remotion 服务），若按浏览器逻辑拼
// /techvideo-public/ 会 404 导致 <Video> 的 delayRender 超时。正确信号是
// getRemotionEnvironment().isPlayer（仅在我们的 FastAPI Player 预览里为真）。
export function resolveMediaSrc(p?: string): string {
  if (!p) return "";
  if (p.startsWith("http")) return p;
  const rel = p.replace(/^\/+/, "");
  const env = getRemotionEnvironment();
  if (env.isPlayer) {
    // 浏览器预览：public 经 FastAPI 以 /techvideo-public/ 暴露。
    return `${window.location.origin}/techvideo-public/${rel}`;
  }
  // Studio 预览 / 离线渲染：public 在 serveUrl 根，用 staticFile。
  return staticFile(rel);
}

// cross-cut（硬切交替）：每段末尾文字占比，其余时段整屏露出口播视频，形成硬切。
const CUT_RATIO = 0.62;

export const PlanVideo: React.FC<z.infer<typeof planSchema>> = ({
  color1,
  color2,
  audioSrc,
  scenes,
  bgTheme = "dark",
  watermark = "",
  personVideo = "",
  personVideoDuration = 0,
  videoLayout = "cross-cut",
  aspect = "16:9",
  transition = "fade",
  showSubtitle = true,
  showNarration = true,
  transparent = false,
  videoDim = 0,
  pipSize = 32,
  pipPos = "br",
}) => {
  // 累计每个 scene 的起始帧，使总时长由各自的 durationFrames 决定
  const P = paletteFor(bgTheme);
  const frame = useCurrentFrame();
  let acc = 0;
  const layout = scenes.map((scene) => {
    const dur = Math.max(
      30,
      Math.round(scene.durationFrames ?? DEFAULT_SCENE_FRAMES),
    );
    const from = acc;
    acc += dur;
    return { scene, from, dur };
  });
  // 当前帧落在哪个片段（用于硬切时判断该显示口播还是图文）。
  const active = layout.find((l) => frame >= l.from && frame < l.from + l.dur);

  // 场景生效叠加方式：场景级 videoLayout 优先，未设置则跟随全局。
  const effLayoutOf = (
    scene?: z.infer<typeof sceneSchema>,
  ): "underlay" | "cross-cut" | "pip" => scene?.videoLayout || videoLayout;
  // 当前帧的生效叠加方式：同一帧只有一个活跃场景，据此决定视频层形态与图文层层级，
  // 实现「场景 A 底片混排、场景 B 画中画」的逐节点切换。
  const activeLayout = effLayoutOf(active?.scene);

  // v1.9.4：场景级视频覆盖——本节点设了 sceneVideo 用节点自己的视频，否则回退全局 personVideo。
  // 切到不同视频时 key 变化 → <Video> 重挂载 → 从头播放（B-roll 逐章节插入语义）。
  const activeVideo = (active?.scene?.sceneVideo && active.scene.sceneVideo.trim()) || personVideo;

  // 透明底模式：预览始终显示视频参照层（原亮度、不变暗），导出才跳过视频层。
  const env = getRemotionEnvironment();
  const isPreview = env.isPlayer;
  const showVideoLayer = !!(activeVideo && (isPreview || !transparent));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: transparent ? undefined : P.bg,
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      {transparent ? null : <Backdrop color1={color1} color2={color2} bg={P.bg} />}
      {/* 配音音轨：有口播素材时改用其原声，忽略 TTS 配音 */}
      {audioSrc && !personVideo ? (
        <Audio src={resolveMediaSrc(audioSrc)} />
      ) : null}
      {/* 图文场景（叠加方式按各自生效 layout：cross-cut 只在末尾时段整屏盖视频，
          underlay / pip 全程显示；层级 zIndex 由当前活跃场景的生效 layout 决定） */}
      <AbsoluteFill style={{ zIndex: activeLayout === "pip" ? 1 : 2, pointerEvents: "none" }}>
        {layout.map(({ scene, from, dur }, i) => {
          if (scene.type === "video") return null;
          if (effLayoutOf(scene) === "cross-cut") {
            const textDur = Math.max(1, Math.round(dur * CUT_RATIO));
            const textFrom = from + (dur - textDur);
            return (
              <Sequence key={i} from={textFrom} durationInFrames={textDur}>
                <AbsoluteFill style={{ backgroundColor: transparent ? undefined : P.bg }}>
                  <SceneView
                    scene={scene}
                    index={i}
                    total={scenes.length}
                    color1={color1}
                    color2={color2}
                    bgTheme={bgTheme}
                    transition={transition}
                    watermark={watermark}
                    showSubtitle={showSubtitle}
                    showNarration={showNarration}
                    transparent={transparent}
                  />
                </AbsoluteFill>
              </Sequence>
            );
          }
          return (
            <Sequence key={i} from={from} durationInFrames={dur}>
              <SceneView
                scene={scene}
                index={i}
                total={scenes.length}
                color1={color1}
                color2={color2}
                bgTheme={bgTheme}
                transition={transition}
                watermark={watermark}
                showSubtitle={showSubtitle}
                showNarration={showNarration}
                transparent={transparent}
              />
            </Sequence>
          );
        })}
      </AbsoluteFill>
      {/* 口播素材层（形态跟随当前活跃场景的生效叠加方式，逐节点可切换）。
          - 预览（isPlayer）：视频始终显示（原亮度、不变暗），作为参照方便对齐素材位置/大小。
          - 导出（非 isPlayer）：transparent=true 时跳过视频层，仅输出透明文字叠加层；
            transparent=false 时正常输出视频+遮罩+文字。 */}
      {showVideoLayer && activeLayout === "pip" ? (
        /* 画中画浮窗：口播小窗置顶（连续播放，不随段落显隐），文字在其后。
           大小/位置随时间线节点变化：本场景设置了 pipSize/pipPos 用场景值，否则回退全局默认。
           预览与导出一致。 */
        <AbsoluteFill
          style={{
            zIndex: 5,
            pointerEvents: "none",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Video
            key={activeVideo}
            src={resolveMediaSrc(activeVideo)}
            loop={!personVideoDuration}
            volume={1}
            style={{
              position: "absolute",
              ...pipPosStyle(active?.scene?.pipPos || pipPos),
              width: `${active?.scene?.pipSize || pipSize}%`,
              height: `${active?.scene?.pipSize || pipSize}%`,
              borderRadius: 18,
              objectFit: "cover",
              border: "2px solid rgba(255,255,255,0.85)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
            }}
          />
        </AbsoluteFill>
      ) : showVideoLayer ? (
        /* 底片混排 / 硬切：口播铺满整屏作底（连续播放、不裁剪），文字/字幕覆盖其上。
           压暗遮罩由 videoDim 全局参数控制（0=原亮度直出），仅当前活跃场景为底片混排时生效：
           预览与导出同渲染，所见即所得。透明底导出无视频层，遮罩无意义、不渲染。 */
        <AbsoluteFill style={{ zIndex: 1, pointerEvents: "none" }}>
          <Video
            key={activeVideo}
            src={resolveMediaSrc(activeVideo)}
            loop={!personVideoDuration}
            volume={1}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          {activeLayout === "underlay" && !transparent && videoDim > 0 ? (
            <AbsoluteFill
              style={{ background: `rgba(0,0,0,${Math.min(0.9, videoDim / 100)})` }}
            />
          ) : null}
        </AbsoluteFill>
      ) : null}
      {watermark ? (
        <div
          style={{
            position: "absolute",
            bottom: 48,
            right: 56,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: P.subBg,
            color: P.subText,
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: 1,
            padding: "12px 22px",
            borderRadius: 14,
            boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            zIndex: 6,
            opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: color1,
              flexShrink: 0,
            }}
          />
          {watermark}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const SceneView: React.FC<{
  scene: z.infer<typeof sceneSchema>;
  index: number;
  total: number;
  color1: string;
  color2: string;
  bgTheme: BgTheme;
  transition?: string;
  watermark?: string;
  showSubtitle?: boolean;
  showNarration?: boolean;
  transparent?: boolean;
}> = ({ scene, index, total, color1, color2, bgTheme = "dark", transition = "fade", watermark = "", showSubtitle = true, showNarration = true, transparent = false }) => {
  const P = paletteFor(bgTheme);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = Math.max(
    30,
    Math.round(scene.durationFrames ?? DEFAULT_SCENE_FRAMES),
  );

  // 每场景颜色覆盖：场景级 color1/color2 优先，否则用全局（白名单优先 + 自定义色值均透传）。
  const c1 = (scene.color1 && scene.color1.trim()) || color1;
  const c2 = (scene.color2 && scene.color2.trim()) || color2;

  // 字号缩放（整体）
  const scale = scene.fontScale && scene.fontScale > 0 ? scene.fontScale : 1;
  const fs = (n: number) => Math.round(n * scale);
  // 标题单独缩放（默认 1）；与整体 fontScale 区分，专治标题过大。
  const titleScale = scene.titleScale && scene.titleScale > 0 ? scene.titleScale : 1;
  // 标题自动缩字号：长标题自动变小、避免溢出；用户再用 titleScale 微调。
  const titleSize = (base: number, maxW: number) =>
    Math.round(fitTitleFont(scene.title || "", base, maxW) * titleScale);

  // 排版（center / left / right / split / top / bottom / card / magazine）
  const layout = scene.layout || "center";
  // v1.9.2：每场景可独立覆盖眉标/标题/要点/金句/说明/旁白的颜色 + 字号（场景级优先，否则回退 palette）
  const kickerColor = (scene.kickerColor && scene.kickerColor.trim()) || c1;
  const titleColor = (scene.titleColor && scene.titleColor.trim()) || P.title;
  const pointsColor = (scene.pointsColor && scene.pointsColor.trim()) || P.body;
  const quoteColor = (scene.quoteColor && scene.quoteColor.trim()) || P.title;
  const captionColor = (scene.captionColor && scene.captionColor.trim()) || P.body;
  const narrationColor = (scene.narrationColor && scene.narrationColor.trim()) || P.body;
  const kickerScale = scene.kickerScale && scene.kickerScale > 0 ? scene.kickerScale : 1;
  const pointsScale = scene.pointsScale && scene.pointsScale > 0 ? scene.pointsScale : 1;
  const quoteScale = scene.quoteScale && scene.quoteScale > 0 ? scene.quoteScale : 1;
  const alignItems =
    layout === "left" || layout === "split" || layout === "magazine" ? "flex-start"
      : layout === "right" ? "flex-end"
      : "center";
  const textAlign =
    layout === "left" || layout === "split" || layout === "magazine" ? "left"
      : layout === "right" ? "right"
      : "center";
  // 顶/底对齐 + 卡片/杂志：调整整体容器位置
  const justifyContent =
    layout === "top" ? "flex-start"
      : layout === "bottom" ? "flex-end"
      : "center";

  // 统一转场（P3）：全局 transition 为默认，场景级 animation 可覆盖。
  const tr = (scene.animation || transition || "fade").toLowerCase();
  const enterEnd = 14;
  const exitStart = dur - 14;
  const appear = interpolate(frame, [0, enterEnd], [0, 1], { extrapolateRight: "clamp" });
  const leaveRaw = interpolate(frame, [exitStart, dur - 2], [1, 0], {
    extrapolateLeft: "clamp",
  });
  let opacity = 1;
  let dx = 0;
  let scaleT = 1;
  let blur = 0;
  let flipDeg = 0;
  let clipPath = "none";
  if (tr === "fade" || tr === "wipe") {
    opacity = Math.min(appear, leaveRaw);
  } else if (tr === "slide") {
    opacity = Math.min(appear, leaveRaw);
    const enterX = interpolate(appear, [0, 1], [60, 0]);
    const exitX = interpolate(frame, [exitStart, dur - 2], [0, -60], {
      extrapolateLeft: "clamp",
    });
    dx = enterX + exitX;
  } else if (tr === "zoom") {
    opacity = Math.min(appear, leaveRaw);
    const enterS = interpolate(appear, [0, 1], [0.9, 1]);
    const exitS = interpolate(frame, [exitStart, dur - 2], [1, 0.92], {
      extrapolateLeft: "clamp",
    });
    scaleT = enterS * exitS;
  } else if (tr === "blur") {
    opacity = Math.min(appear, leaveRaw);
    const enterB = interpolate(appear, [0, 1], [14, 0]);
    const exitB = interpolate(frame, [exitStart, dur - 2], [0, 14], {
      extrapolateLeft: "clamp",
    });
    blur = enterB + exitB;
  } else if (tr === "flip") {
    // 3D 翻转：切入 -90°→0°，切出 0°→90°
    opacity = Math.min(appear, leaveRaw) * 0.7 + 0.3;
    const enterR = interpolate(appear, [0, 1], [-90, 0]);
    const exitR = interpolate(frame, [exitStart, dur - 2], [0, 90], {
      extrapolateLeft: "clamp",
    });
    flipDeg = enterR + exitR;
  } else if (tr === "iris") {
    // 圆形展开：半径随入场增长、出场收缩（clip-path 决定显隐，opacity 保持不透明）
    opacity = 1;
    const rEnter = interpolate(appear, [0, 1], [0, 150], { extrapolateRight: "clamp" });
    const rExit = interpolate(leaveRaw, [0, 1], [0, 150], { extrapolateRight: "clamp" });
    const r = Math.min(rEnter, rExit);
    clipPath = `circle(${r}% at 50% 50%)`;
  } else {
    // none（硬切）：立即出现/消失
    opacity = 1;
  }
  const animOpacity = opacity;
  const animTransform = `translateX(${dx}px) scale(${scaleT})${
    flipDeg !== 0 ? ` perspective(1600px) rotateY(${flipDeg}deg)` : ""
  }`;
  const animClipPath = clipPath;
  const animFilter = blur > 0 ? `blur(${blur}px)` : "none";
  // wipe 转场：品牌渐变条在切入/切出时横扫（与相邻场景衔接成连续擦除）。
  let wipeX = 100;
  if (tr === "wipe") {
    if (frame <= exitStart) {
      wipeX = interpolate(frame, [0, enterEnd], [0, 100], { extrapolateRight: "clamp" });
    } else {
      wipeX = interpolate(frame, [exitStart, dur], [-100, 0], { extrapolateLeft: "clamp" });
    }
  }

  // 当前活跃字幕（基于本地时间轴匹配）
  const subs = scene.subtitles ?? [];
  const localTime = frame / fps;
  const active = subs.find((s) => localTime >= s.start && localTime < s.end);
  const subtitleText = active ? active.text : "";

  const type = (scene.type || "points").toLowerCase();
  const isCover = type === "cover";
  const isConclusion = type === "conclusion";
  const isData = type === "data";
  const isChart = type === "chart";
  const isImage = type === "image";
  const isQuote = type === "quote";
  const isTimeline = type === "timeline";
  const isCompare = type === "compare";
  const isCite = type === "cite";
  const isLibrary = LIBRARY_TYPES.includes(type); // 素材库新增构件（SceneLibrary 渲染）
  // 需要铺满整屏（图片/背景推到画面边缘）的素材：去掉 SceneView 外层内边距，由其自行排版。
  const fullBleed = type === "kb";
  const scenePad = fullBleed ? "0px" : "120px 170px";

  // 节奏标记（P1）：强调词高亮——命中强调词的要点/关键词会被放大、着主色、加白描边。
  const emphasis = scene.emphasis || [];
  const isEmph = (t?: string) =>
    !!(t && emphasis.some((e) => e && t.indexOf(e) !== -1));

  const titleProgress = spring({
    frame: frame - 4,
    fps,
    config: { damping: 200 },
  });
  const titleY = interpolate(titleProgress, [0, 1], [50, 0]);
  const titleOpacity = interpolate(titleProgress, [0, 1], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent,
        padding: scenePad,
        opacity: animOpacity,
        transform: animTransform,
        filter: animFilter,
        clipPath: animClipPath !== "none" ? animClipPath : undefined,
      }}
    >
      {/* wipe 转场：品牌渐变条横扫（切入/切出） */}
      {tr === "wipe" ? (
        <AbsoluteFill
          style={{
            zIndex: 10,
            transform: `translateX(${wipeX}%)`,
            background: `linear-gradient(135deg, ${c1}, ${c2})`,
          }}
        />
      ) : null}
      {/* 进度指示点 */}
      <div
        style={{
          position: "absolute",
          top: 74,
          left: 170,
          display: "flex",
          gap: 16,
        }}
      >
        {Array.from({ length: total }).map((_, d) => (
          <div
            key={d}
            style={{
              width: 44,
              height: 8,
              borderRadius: 4,
              background: d === index ? c1 : P.dot,
            }}
          />
        ))}
      </div>

      {/* split 分栏左侧色条；magazine 杂志版式用左侧竖排眉标代替色条 */}
      {layout === "split" && (
        <div
          style={{
            position: "absolute",
            left: layout === "right" ? "auto" : 96,
            right: layout === "right" ? 96 : "auto",
            top: 220,
            bottom: 220,
            width: 12,
            borderRadius: 6,
            background: c1,
          }}
        />
      )}
      {layout === "magazine" && scene.kicker ? (
        <div
          style={{
            position: "absolute",
            left: 170,
            top: 380,
            writingMode: "vertical-rl",
            fontSize: fs(34 * kickerScale),
            fontWeight: 700,
            letterSpacing: 12,
            color: kickerColor,
            textTransform: "uppercase",
          }}
        >
          {scene.kicker}
        </div>
      ) : null}
      {layout === "card" && (
        <div
          style={{
            position: "absolute",
            inset: "240px 170px",
            borderRadius: 32,
            background: `linear-gradient(160deg, ${c1}22, ${c2}11)`,
            border: `1px solid ${c1}55`,
          }}
        />
      )}

      {isCover && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: alignItems,
            textAlign: textAlign,
            padding: "120px 170px",
          }}
        >
          {scene.kicker ? (
            <div
              style={{
                fontSize: fs(34 * kickerScale),
                fontWeight: 700,
                letterSpacing: 8,
                color: kickerColor,
                marginBottom: 30,
                textTransform: "uppercase",
                opacity: titleOpacity,
              }}
            >
              {scene.kicker}
            </div>
          ) : null}
          <h1
            style={{
              fontSize: titleSize(132, 1500),
              fontWeight: 800,
              margin: 0,
              color: titleColor,
              transform: `translateY(${titleY}px)`,
              opacity: titleOpacity,
              maxWidth: 1500,
              lineHeight: 1.12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {scene.title}
          </h1>
          <div
            style={{
              marginTop: 34,
              height: 8,
              width: 240,
              borderRadius: 4,
              background: `linear-gradient(90deg, ${c1}, ${c2})`,
              transform: `scaleX(${titleProgress})`,
              transformOrigin: "center",
              opacity: titleOpacity,
            }}
          />
          {scene.narration ? (
            <p
              style={{
                fontSize: fs(46),
                color: narrationColor,
                marginTop: 40,
                maxWidth: 1180,
                lineHeight: 1.5,
                opacity: titleOpacity,
              }}
            >
              {scene.narration}
            </p>
          ) : null}
          <div
            style={{
              position: "absolute",
              bottom: 96,
              display: "flex",
              alignItems: "center",
              gap: 12,
              opacity: titleOpacity,
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                background: c1,
                display: "inline-block",
              }}
            />
            <span style={{ fontSize: 26, color: P.label, letterSpacing: 2 }}>
              {watermark || "科技视频"}
            </span>
          </div>
        </AbsoluteFill>
      )}

      {isConclusion && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          {/* P5：品牌水波纹/光晕背景 */}
          <div
            style={{
              position: "absolute",
              width: 420,
              height: 420,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${c1}33 0%, ${c2}11 50%, transparent 70%)`,
              transform: `scale(${interpolate(titleProgress, [0, 1], [0.6, 1.6])})`,
              opacity: interpolate(titleProgress, [0, 1], [0, 0.55]),
            }}
          />
          <div
            style={{
              position: "absolute",
              width: 360,
              height: 360,
              borderRadius: "50%",
              border: `3px solid ${c1}`,
              opacity: interpolate(titleProgress, [0, 1], [0, 0.35]),
              transform: `scale(${interpolate(titleProgress, [0, 1], [0.7, 1.3])})`,
            }}
          />

          <h1
            style={{
              fontSize: titleSize(104, 1500),
              fontWeight: 800,
              margin: 0,
              color: titleColor,
              transform: `translateY(${titleY}px)`,
              opacity: titleOpacity,
              maxWidth: 1500,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {scene.title}
          </h1>
          <div
            style={{
              marginTop: 30,
              height: 8,
              width: 200,
              borderRadius: 4,
              background: `linear-gradient(90deg, ${c1}, ${c2})`,
              transform: `scaleX(${titleProgress})`,
              transformOrigin: "center",
              opacity: titleOpacity,
            }}
          />
          <div
            style={{
              marginTop: 44,
              fontSize: fs(30),
              color: c2,
              fontWeight: 700,
              letterSpacing: 4,
              opacity: titleOpacity,
            }}
          >
            感谢观看 · 我们下期见
          </div>

          {/* P5：CTA 行动按钮条（点赞/收藏/关注/转发），带错落动画 */}
          <div
            style={{
              display: "flex",
              gap: 20,
              marginTop: 54,
              opacity: interpolate(frame, [18, 32], [0, 1], { extrapolateRight: "clamp" }),
              transform: `translateY(${interpolate(frame, [18, 32], [30, 0], { extrapolateRight: "clamp" })}px)`,
            }}
          >
            {["点赞", "收藏", "关注", "转发"].map((cta, i) => {
              const p = spring({ frame: frame - 24 - i * 5, fps, config: { damping: 200 } });
              const s = interpolate(p, [0, 1], [0.7, 1], { extrapolateRight: "clamp" });
              return (
                <div
                  key={cta}
                  style={{
                    transform: `scale(${s})`,
                    background: i % 2 === 0 ? c1 : c2,
                    color: "#fff",
                    fontSize: fs(26),
                    fontWeight: 800,
                    padding: "14px 32px",
                    borderRadius: 999,
                    boxShadow: "0 6px 22px rgba(0,0,0,0.28)",
                  }}
                >
                  {cta}
                </div>
              );
            })}
          </div>

          {/* P5：品牌水印淡入 */}
          {watermark ? (
            <div
              style={{
                position: "absolute",
                bottom: 110,
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: interpolate(frame, [30, 48], [0, 1], { extrapolateRight: "clamp" }),
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: c1,
                  display: "inline-block",
                }}
              />
              <span style={{ fontSize: 28, color: P.label, letterSpacing: 2 }}>{watermark}</span>
            </div>
          ) : null}
        </AbsoluteFill>
      )}

      {isImage && (
        <ImageCard scene={scene} c1={c1} c2={c2} P={P} fs={fs} />
      )}
      {isQuote && <QuoteCard scene={scene} c1={c1} c2={c2} P={P} fs={fs} />}
      {isTimeline && (
        <TimelineCard scene={scene} c1={c1} c2={c2} P={P} fs={fs} frame={frame} fps={fps} />
      )}
      {isCompare && (
        <CompareCard scene={scene} c1={c1} c2={c2} P={P} fs={fs} frame={frame} fps={fps} transparent={transparent} />
      )}
      {isCite && <CiteCard scene={scene} c1={c1} c2={c2} P={P} fs={fs} />}

      {isLibrary && (
        <LibraryScene
          type={type}
          scene={scene}
          c1={c1}
          c2={c2}
          P={P}
          fs={fs}
          align={alignItems}
          textAlign={textAlign}
          imgSrc={resolveMediaSrc(scene.imageUrl)}
        />
      )}

      {!isCover && !isConclusion && !isImage && !isQuote && !isTimeline && !isCompare && !isCite && !isChart && !isLibrary && (
        <>
          {/* 杂志版式：左上角竖排眉标已经在外层渲染了，此处不再渲染 kicker */}
          {layout !== "magazine" && scene.kicker ? (
            <div
              style={{
                fontSize: fs(34 * kickerScale),
                fontWeight: 700,
                letterSpacing: 8,
                color: kickerColor,
                marginBottom: 28,
                textTransform: "uppercase",
                textAlign,
                opacity: titleOpacity,
              }}
            >
              {scene.kicker}
            </div>
          ) : null}
          <h1
            style={{
              fontSize: titleSize(88, 1480),
              fontWeight: 800,
              margin: 0,
              color: titleColor,
              transform: `translateY(${titleY}px)`,
              opacity: titleOpacity,
              textAlign,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {scene.title}
          </h1>

          {isData ? (
            <div
              style={{
                marginTop: 48,
                display: "flex",
                flexWrap: "wrap",
                gap: 24,
                justifyContent: alignItems === "center" ? "center" : alignItems === "flex-end" ? "flex-end" : "flex-start",
              }}
            >
              {(scene.keywords ?? []).map((kw, ki) => {
                const p = spring({
                  frame: frame - 12 - ki * 6,
                  fps,
                  config: { damping: 200 },
                });
                const s = interpolate(p, [0, 1], [0.8, 1]);
                const emph = isEmph(kw);
                return (
                  <div
                    key={ki}
                    style={{
                      transform: `scale(${s * (emph ? 1.08 : 1)})`,
                      background: c1,
                      color: "white",
                      fontSize: fs(emph ? 60 : 52),
                      fontWeight: 800,
                      padding: "22px 40px",
                      borderRadius: 22,
                      ...(emph
                        ? { outline: "4px solid #ffffff", outlineOffset: 5 }
                        : {}),
                    }}
                  >
                    {kw}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div
            style={{
              marginTop: isData ? 40 : 54,
              display: "flex",
              flexDirection: "column",
              gap: 30,
              maxWidth: 1480,
              alignItems,
              textAlign,
            }}
          >
              {(scene.points || []).map((p, pi) => {
                const start = 18 + pi * 12;
                const prog = spring({
                  frame: frame - start,
                  fps,
                  config: { damping: 200 },
                });
                const y = interpolate(prog, [0, 1], [34, 0]);
                const op = interpolate(prog, [0, 1], [0, 1], {
                  extrapolateRight: "clamp",
                });
                const emph = isEmph(p);
                return (
                  <div
                    key={pi}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 22,
                      flexDirection: layout === "right" ? "row-reverse" : "row",
                      transform: `translateY(${y}px)`,
                      opacity: op,
                    }}
                  >
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        marginTop: 14,
                        borderRadius: "50%",
                        background: emph ? c1 : c2,
                        flexShrink: 0,
                        ...(emph ? { outline: "3px solid #fff", outlineOffset: 3 } : {}),
                      }}
                    />
                    <span
                      style={{
                        fontSize: fs((emph ? 54 : 46) * pointsScale),
                        color: emph ? c1 : pointsColor,
                        fontWeight: emph ? 800 : 400,
                        lineHeight: 1.35,
                      }}
                    >
                      {p}
                    </span>
                  </div>
                );
              })}
            </div>
          {/* 旁白 / 文案：作为场景内容区的说明文字（不再占用底部「字幕条」位置，
              该位置留给后续第三方平台制作字幕）。有音频对齐字幕时隐藏，避免与字幕重复。
              显示开关 showNarration 关闭时不渲染（预览/导出均可隐藏）。 */}
          {showNarration && scene.narration && !subtitleText ? (
            <p
              style={{
                marginTop: 40,
                maxWidth: 1340,
                fontSize: fs(34),
                color: narrationColor,
                opacity: 0.85,
                lineHeight: 1.5,
                textAlign,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {scene.narration}
            </p>
          ) : null}
        </>
      )}

      {isChart && scene.chart ? (
        <ChartScene
          chart={scene.chart}
          color1={c1}
          color2={c2}
          bgTheme={bgTheme}
          title={scene.title}
          fontScale={scale}
          titleScale={titleScale}
        />
      ) : null}

      {/* 字幕轨（底部专用，不被旁白占用）。显示开关 showSubtitle 关闭时整条隐藏，
          以便后续交给第三方平台（如剪映）制作字幕。 */}
      {showSubtitle && subtitleText && !isLibrary ? (
        <div
          style={{
            position: "absolute",
            bottom: 96,
            left: 0,
            right: 0,
            textAlign: "center",
            opacity: interpolate(frame, [0, 6], [0, 1], {
              extrapolateRight: "clamp",
            }),
          }}
        >
          <span
            style={{
              display: "inline-block",
              background: P.subBg,
              color: P.subText,
              fontSize: fs(44),
              fontWeight: 600,
              padding: "14px 34px",
              borderRadius: 14,
              maxWidth: 1400,
              lineHeight: 1.35,
            }}
          >
            {subtitleText}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// ———————————————————————————————————————————
// 新增场景卡片组件
// ———————————————————————————————————————————

type CardProps = {
  scene: z.infer<typeof sceneSchema>;
  c1: string;
  c2: string;
  P: ReturnType<typeof paletteFor>;
  fs: (n: number) => number;
};

// 图片地址解析：与 resolveMediaSrc 同机制（远程直用；Player 预览走 /techvideo-public/，
// Studio / 离线渲染走 staticFile）。统一用 resolveMediaSrc 即可。
function resolveImageSrc(src: string | undefined): string {
  return resolveMediaSrc(src);
}

const ImageCard: React.FC<CardProps> = ({ scene, c1, c2, P, fs }) => {
  // v1.9.2：场景级 caption/title/quote 颜色覆盖
  const tColor = (scene.titleColor && scene.titleColor.trim()) || P.title;
  const capColor = (scene.captionColor && scene.captionColor.trim()) || P.body;
  const qScale = scene.quoteScale && scene.quoteScale > 0 ? scene.quoteScale : 1;
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "110px 170px" }}>
      <h1 style={{ fontSize: fs(64), fontWeight: 800, color: tColor, margin: 0 }}>
        {scene.title}
      </h1>
      <div style={{ marginTop: 40, display: "flex", justifyContent: "center" }}>
        {scene.imageUrl ? (
          <img
            src={resolveImageSrc(scene.imageUrl)}
            alt={scene.caption || ""}
            style={{
              maxHeight: 540,
              maxWidth: 1200,
              borderRadius: 18,
              objectFit: "cover",
              boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
            }}
          />
        ) : (
          <div
            style={{
              width: 1000,
              height: 520,
              borderRadius: 18,
              background: `linear-gradient(135deg, ${c1}, ${c2})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: fs(34),
              fontWeight: 800,
              opacity: 0.92,
              padding: "0 60px",
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {scene.imagePrompt ? `AI 配图：${scene.imagePrompt}` : scene.caption || "图片占位"}
          </div>
        )}
      </div>
      {scene.caption ? (
        <p style={{ textAlign: "center", marginTop: 28, fontSize: fs(40), color: capColor }}>
          {scene.caption}
        </p>
      ) : null}
    </AbsoluteFill>
  );
};

const QuoteCard: React.FC<CardProps> = ({ scene, c1, P, fs }) => {
  // v1.9.2：场景级 quote/caption 颜色 + 金句字号覆盖
  const qColor = (scene.quoteColor && scene.quoteColor.trim()) || P.title;
  const capColor = (scene.captionColor && scene.captionColor.trim()) || P.body;
  const qScale = scene.quoteScale && scene.quoteScale > 0 ? scene.quoteScale : 1;
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: "130px 200px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: fs(160), color: c1, fontWeight: 800, lineHeight: 1, opacity: 0.5 }}>
        “
      </div>
      <h1
        style={{
          fontSize: fs(96 * qScale),
          fontWeight: 800,
          color: qColor,
          maxWidth: 1500,
          lineHeight: 1.25,
          margin: "-30px 0 0",
        }}
      >
        {scene.quote || scene.title}
      </h1>
      {scene.caption ? (
        <p style={{ fontSize: fs(40), color: capColor, marginTop: 30 }}>{scene.caption}</p>
      ) : null}
    </AbsoluteFill>
  );
};

const TimelineCard: React.FC<
  CardProps & { frame: number; fps: number }
> = ({ scene, c1, c2, P, fs, frame, fps }) => {
  // v1.9.2：场景级 title/points 颜色覆盖（时间线条目文字走 pointsColor）
  const tColor = (scene.titleColor && scene.titleColor.trim()) || P.title;
  const pColor = (scene.pointsColor && scene.pointsColor.trim()) || P.body;
  const pScale = scene.pointsScale && scene.pointsScale > 0 ? scene.pointsScale : 1;
  const events = scene.events || [];
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "120px 200px" }}>
      <h1 style={{ fontSize: fs(72), fontWeight: 800, color: tColor, margin: "0 0 40px" }}>
        {scene.title}
      </h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {events.map((ev, i) => {
          const p = spring({ frame: frame - 14 - i * 8, fps, config: { damping: 200 } });
          const op = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          const y = interpolate(p, [0, 1], [30, 0]);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 28,
                opacity: op,
                transform: `translateY(${y}px)`,
              }}
            >
              <div
                style={{
                  minWidth: 160,
                  fontSize: fs(40 * pScale),
                  fontWeight: 800,
                  color: c1,
                  textAlign: "right",
                }}
              >
                {ev.time}
              </div>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: c2, flexShrink: 0 }} />
              <div style={{ fontSize: fs(40 * pScale), color: pColor, lineHeight: 1.35 }}>{ev.text}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const CompareCard: React.FC<
  CardProps & { frame: number; fps: number; transparent?: boolean }
> = ({ scene, c1, c2, P, fs, frame, fps, transparent = false }) => {
  // v1.9.2：场景级 title/points 颜色 + 要点字号覆盖
  const tColor = (scene.titleColor && scene.titleColor.trim()) || P.title;
  const pColor = (scene.pointsColor && scene.pointsColor.trim()) || P.body;
  const pScale = scene.pointsScale && scene.pointsScale > 0 ? scene.pointsScale : 1;
  const cols = scene.columns || [];
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "120px 170px" }}>
      <h1 style={{ fontSize: fs(72), fontWeight: 800, color: tColor, margin: "0 0 40px", textAlign: "center" }}>
        {scene.title}
      </h1>
      <div style={{ display: "flex", gap: 32, justifyContent: "center", flexWrap: "wrap" }}>
        {cols.map((col, i) => {
          const accent = i % 2 === 0 ? c1 : c2;
          const p = spring({ frame: frame - 14 - i * 8, fps, config: { damping: 200 } });
          const op = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          const y = interpolate(p, [0, 1], [30, 0]);
          return (
            <div
              key={i}
              style={{
                flex: 1,
                minWidth: 360,
                maxWidth: 560,
                background: P.subBg,
                borderRadius: 18,
                padding: "28px 30px",
                opacity: op,
                transform: `translateY(${y}px)`,
                border: `1px solid ${P.dot}`,
              }}
            >
              <div style={{ fontSize: fs(44), fontWeight: 800, color: accent, marginBottom: 20, textAlign: "center" }}>
                {col.name}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {col.items.map((it, j) => (
                  <div key={j} style={{ fontSize: fs(34 * pScale), color: pColor, lineHeight: 1.4 }}>
                    · {it}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const CiteCard: React.FC<CardProps> = ({ scene, c1, P, fs }) => {
  // v1.9.2：场景级 quote/caption 颜色 + 金句字号覆盖
  const qColor = (scene.quoteColor && scene.quoteColor.trim()) || P.title;
  const capColor = (scene.captionColor && scene.captionColor.trim()) || P.body;
  const qScale = scene.quoteScale && scene.quoteScale > 0 ? scene.quoteScale : 1;
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "130px 200px" }}>
      <div style={{ borderLeft: `12px solid ${c1}`, paddingLeft: 48, maxWidth: 1500 }}>
        <div style={{ fontSize: fs(56), fontWeight: 800, color: c1, marginBottom: 20, letterSpacing: 4 }}>
          引用
        </div>
        <h1
          style={{
            fontSize: fs(72 * qScale),
            fontWeight: 700,
            fontStyle: "italic",
            color: qColor,
            lineHeight: 1.35,
            margin: 0,
          }}
        >
          {scene.source || scene.quote || scene.title}
        </h1>
        {scene.author ? (
          <div style={{ marginTop: 28, fontSize: fs(40), color: capColor, textAlign: "right" }}>
            — {scene.author}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

// ———————————————————————————————————————————
// 图表（含 radar / stacked / area 新增类型）
// ———————————————————————————————————————————

const ChartLegend: React.FC<{
  series: { name: string }[];
  color1: string;
  color2: string;
  P: ReturnType<typeof paletteFor>;
}> = ({ series, color1, color2, P }) =>
  series.length > 1 ? (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 26, justifyContent: "center", maxWidth: 1440 }}>
      {series.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 28, color: P.body }}>
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: i % 2 === 0 ? color1 : color2,
              display: "inline-block",
            }}
          />
          <span>{s.name || `系列${i + 1}`}</span>
        </div>
      ))}
    </div>
  ) : null;

const ChartScene: React.FC<{
  chart: z.infer<typeof chartSchema>;
  color1: string;
  color2: string;
  bgTheme: BgTheme;
  title?: string;
  fontScale?: number;
  titleScale?: number;
}> = ({ chart, color1, color2, bgTheme = "dark", title = "", fontScale = 1, titleScale = 1 }) => {
  const P = paletteFor(bgTheme);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const uid = useId().replace(/:/g, "");

  // 图表场景自包含标题：根据长度自动缩字号，避免与图表/图例重叠。
  const chartTitleSize = Math.round(
    fitTitleFont(title || "", 78, 1400) *
      (titleScale && titleScale > 0 ? titleScale : 1) *
      (fontScale && fontScale > 0 ? fontScale : 1),
  );

  // 统一图表容器：标题置顶、图表居中、图例/标签置底，告别 AbsoluteFill 覆盖标题。
  const ChartWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        padding: "12px 0 28px",
        boxSizing: "border-box",
      }}
    >
      {title ? (
        <h2
          style={{
            fontSize: chartTitleSize,
            fontWeight: 800,
            margin: 0,
            color: P.title,
            textAlign: "center",
            maxWidth: 1400,
            lineHeight: 1.15,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {title}
        </h2>
      ) : null}
      <div
        style={{
          flex: "1 1 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: 0,
          marginTop: title ? 20 : 0,
        }}
      >
        {children}
      </div>
    </div>
  );

  const { kind, labels, unit } = chart;
  const series = chart.series && chart.series.length
    ? chart.series.map((s) => ({ name: s.name || "", values: Array.isArray(s.values) ? s.values : [] }))
    : [{ name: "", values: chart.values || [] }];

  const fmt = (v: number) => {
    const r = Number.isInteger(v) ? String(v) : v.toFixed(1);
    return unit ? `${r}${unit}` : r;
  };

  const W = 1480;
  const H = 620;
  const padX = 90;
  const padTop = 70;
  const padBottom = 96;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBottom;
  const baseY = padTop + plotH;
  const scale = plotH * 0.86; // 留头顶空间给数值标签
  const slot = plotW / Math.max(1, (labels || []).length);
  const xAt = (i: number) => padX + slot * (i + 0.5);

  if (kind === "bar") {
    const values = chart.values || [];
    const n = values.length;
    const maxV = Math.max(...values, 0.0001);
    return (
      <ChartWrapper>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#cfd4dd" strokeWidth={2} />
          {values.map((v, i) => {
            const fullH = (Math.abs(v) / maxV) * scale;
            const prog = spring({ frame: frame - 8 - i * 5, fps, config: { damping: 200 } });
            const grow = interpolate(prog, [0, 1], [0, 1], { extrapolateRight: "clamp" });
            const barH = fullH * grow;
            const bw = Math.min(slot * 0.5, 150);
            const yTop = baseY - barH;
            return (
              <g key={i}>
                <defs>
                  <linearGradient id={`${uid}bar${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color1} />
                    <stop offset="100%" stopColor={color2} />
                  </linearGradient>
                </defs>
                <rect x={xAt(i) - bw / 2} y={yTop} width={bw} height={barH} rx={12} fill={`url(#${uid}bar${i})`} />
                <text x={xAt(i)} y={yTop - 18} textAnchor="middle" fontSize={42} fontWeight={800} fill={P.value}>
                  {fmt(v)}
                </text>
                <text x={xAt(i)} y={baseY + 48} textAnchor="middle" fontSize={34} fill={P.label}>
                  {labels[i]}
                </text>
              </g>
            );
          })}
        </svg>
      </ChartWrapper>
    );
  }

  if (kind === "pie") {
    const values = chart.values || [];
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2;
    const cy = H / 2 - 30;
    const r = 230;
    let angle = -Math.PI / 2;
    const slices = values.map((v, i) => {
      const frac = v / total;
      const a2 = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      const d = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      angle = a2;
      return { d, frac, v, label: labels[i] };
    });
    return (
      <ChartWrapper>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {slices.map((s, i) => {
            const prog = spring({ frame: frame - 6 - i * 4, fps, config: { damping: 200 } });
            const op = interpolate(prog, [0, 1], [0, 1], { extrapolateRight: "clamp" });
            return (
              <path key={i} d={s.d} fill={i % 2 === 0 ? color1 : color2} stroke={P.pieStroke} strokeWidth={3} opacity={op} />
            );
          })}
        </svg>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, justifyContent: "center", maxWidth: 1440 }}>
          {slices.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 30, color: P.body }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, background: i % 2 === 0 ? color1 : color2, display: "inline-block" }} />
              <span>
                {s.label}：<b style={{ color: P.value }}>{fmt(s.v)}</b>（{Math.round(s.frac * 100)}%）
              </span>
            </div>
          ))}
        </div>
      </ChartWrapper>
    );
  }

  if (kind === "radar") {
    const axes = labels.length ? labels : series[0].values.map((_, i) => `维度${i + 1}`);
    const n = axes.length || 1;
    let maxV = 0;
    series.forEach((s) => s.values.forEach((v) => { if (Math.abs(v) > maxV) maxV = Math.abs(v); }));
    maxV = maxV || 1;
    const cx = W / 2;
    const cy = H / 2 - 10;
    const R = 240;
    const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pointFor = (i: number, val: number): [number, number] => {
      const r = (Math.abs(val) / maxV) * R;
      return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
    };
    const rings = [0.25, 0.5, 0.75, 1];
    return (
      <ChartWrapper>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {rings.map((rg, ri) => (
            <polygon
              key={ri}
              points={axes.map((_, i) => pointFor(i, maxV * rg).join(",")).join(" ")}
              fill="none"
              stroke={P.dot}
              strokeWidth={1}
            />
          ))}
          {axes.map((ax, i) => {
            const [x, y] = pointFor(i, maxV);
            return (
              <g key={i}>
                <line x1={cx} y1={cy} x2={x} y2={y} stroke={P.dot} strokeWidth={1} />
                <text x={cx + (x - cx) * 1.14} y={cy + (y - cy) * 1.14} textAnchor="middle" fontSize={28} fill={P.label}>
                  {ax}
                </text>
              </g>
            );
          })}
          {series.map((s, si) => {
            const col = si % 2 === 0 ? color1 : color2;
            const prog = spring({ frame: frame - 8 - si * 4, fps, config: { damping: 200 } });
            const sc = interpolate(prog, [0, 1], [0, 1], { extrapolateRight: "clamp" });
            const poly = s.values
              .map((v, i) => {
                const [px, py] = pointFor(i, v);
                const x0 = cx + (px - cx) * sc;
                const y0 = cy + (py - cy) * sc;
                return `${i === 0 ? "M" : "L"}${x0.toFixed(1)} ${y0.toFixed(1)}`;
              })
              .join(" ") + " Z";
            return <path key={si} d={poly} fill={col} fillOpacity={0.28} stroke={col} strokeWidth={5} />;
          })}
        </svg>
        <ChartLegend series={series} color1={color1} color2={color2} P={P} />
      </ChartWrapper>
    );
  }

  if (kind === "stacked") {
    const n = labels.length || 1;
    const maxStack = Math.max(
      ...series.map((s) => s.values.reduce((a, b) => a + Math.abs(b), 0)),
      0.0001,
    );
    const slotS = plotW / n;
    const xS = (i: number) => padX + slotS * (i + 0.5);
    return (
      <ChartWrapper>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#cfd4dd" strokeWidth={2} />
          {labels.map((lab, i) => {
            let acc = 0;
            return (
              <g key={i}>
                {series.map((s, si) => {
                  const v = s.values[i] || 0;
                  const h = (Math.abs(v) / maxStack) * scale;
                  const yTop = baseY - acc - h;
                  acc += h;
                  const bw = Math.min(slotS * 0.5, 150);
                  const prog = spring({ frame: frame - 8 - i * 4 - si * 3, fps, config: { damping: 200 } });
                  const op = interpolate(prog, [0, 1], [0.15, 1], { extrapolateRight: "clamp" });
                  return (
                    <rect
                      key={si}
                      x={xS(i) - bw / 2}
                      y={yTop}
                      width={bw}
                      height={h}
                      rx={6}
                      fill={si % 2 === 0 ? color1 : color2}
                      opacity={op}
                    />
                  );
                })}
                <text x={xS(i)} y={baseY + 48} textAnchor="middle" fontSize={34} fill={P.label}>
                  {lab}
                </text>
              </g>
            );
          })}
        </svg>
        <ChartLegend series={series} color1={color1} color2={color2} P={P} />
      </ChartWrapper>
    );
  }

  if (kind === "area") {
    const n = labels.length || 1;
    const maxV = Math.max(...series.flatMap((s) => s.values), 0.0001);
    const slotA = plotW / n;
    const xA = (i: number) => padX + slotA * (i + 0.5);
    const yA = (v: number) => baseY - (v / maxV) * scale;
    return (
      <ChartWrapper>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#cfd4dd" strokeWidth={2} />
          <defs>
            <linearGradient id={`${uid}axis0`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color1} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color1} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id={`${uid}axis1`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color2} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color2} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          {series.map((s, si) => {
            const col = si % 2 === 0 ? color1 : color2;
            const pts = s.values.map((v, i) => ({ x: xA(i), y: yA(v) }));
            const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
            const areaD = `${line} L ${pts[pts.length - 1].x} ${baseY} L ${pts[0].x} ${baseY} Z`;
            const prog = spring({ frame: frame - 8 - si * 4, fps, config: { damping: 200 } });
            const op = interpolate(prog, [0, 1], [0.15, 1], { extrapolateRight: "clamp" });
            return (
              <g key={si}>
                <path d={areaD} fill={`url(#${uid}axis${si % 2})`} />
                <path d={line} fill="none" stroke={col} strokeWidth={7} strokeLinejoin="round" />
                {pts.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={13} fill="#fff" stroke={col} strokeWidth={5} opacity={op} />
                ))}
              </g>
            );
          })}
          {labels.map((lab, i) => (
            <text key={i} x={xA(i)} y={baseY + 48} textAnchor="middle" fontSize={34} fill={P.label}>
              {lab}
            </text>
          ))}
        </svg>
        <ChartLegend series={series} color1={color1} color2={color2} P={P} />
      </ChartWrapper>
    );
  }

  // 默认折线
  const values = chart.values || [];
  const maxV = Math.max(...values, 0.0001);
  const yAt = (v: number) => baseY - (v / maxV) * scale;
  const pts = values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  return (
    <ChartWrapper>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id={`${uid}line`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color1} />
            <stop offset="100%" stopColor={color2} />
          </linearGradient>
        </defs>
        <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#cfd4dd" strokeWidth={2} />
        {labels.map((_, i) => (
          <line key={i} x1={xAt(i)} y1={padTop} x2={xAt(i)} y2={baseY} stroke="#eef0f4" strokeWidth={1} />
        ))}
        <path d={pathD} fill="none" stroke={`url(#${uid}line)`} strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => {
          const prog = spring({ frame: frame - 10 - i * 5, fps, config: { damping: 200 } });
          const s = interpolate(prog, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={15 * s} fill="#fff" stroke={color1} strokeWidth={6} />
              <text x={p.x} y={p.y - 30} textAnchor="middle" fontSize={36} fontWeight={800} fill={P.value} opacity={s}>
                {fmt(values[i])}
              </text>
              <text x={p.x} y={baseY + 48} textAnchor="middle" fontSize={34} fill={P.label}>
                {labels[i]}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartWrapper>
  );
};

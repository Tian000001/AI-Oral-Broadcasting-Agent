import "./index.css";
import { Composition } from "remotion";
import { HelloWorld, myCompSchema } from "./HelloWorld";
import { Logo, myCompSchema2 } from "./HelloWorld/Logo";
import { PlanVideo, planSchema, DEFAULT_SCENE_FRAMES } from "./PlanVideo";
import { LIBRARY_ASSETS, ASSET_DEFAULTS } from "./sceneAssets";

// —— Studio 预览用：把「动画素材库」全部新构件串成一条 demo 合成 ——
// 每种素材取一段示例内容（ASSET_DEFAULTS），首尾各加封面/结尾，方便在 Remotion Studio
// 里一次性从头看到尾。npm run dev 打开后，侧栏选「AssetsDemo」即可播放。
const demoScene = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  title: "",
  points: [] as string[],
  narration: "",
  durationFrames: 90,
  ...(ASSET_DEFAULTS[type] || {}),
  ...over,
});

const ASSETS_DEMO_SCENES = [
  demoScene("cover", {
    kicker: "KOUBO · 素材库",
    title: "新增动画素材一览",
    narration: "逐词字幕 / 打字机 / 数字滚动 / 进度环 / 卡片 / 代码窗口…",
    durationFrames: 120,
  }),
  ...LIBRARY_ASSETS.map((a) =>
    demoScene(a.type, { kicker: a.label, durationFrames: 96 }),
  ),
  demoScene("conclusion", { title: "全部构件", durationFrames: 90 }),
];

// Each <Composition> is an entry in the sidebar!

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        // You can take the "id" to render a video:
        // npx remotion render HelloWorld
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        // You can override these props for each render:
        // https://www.remotion.dev/docs/parametrized-rendering
        schema={myCompSchema}
        defaultProps={{
          titleText: "Welcome to Remotion",
          titleColor: "#000000",
          logoColor1: "#91EAE4",
          logoColor2: "#86A8E7",
        }}
      />

      {/* Mount any React component to make it show up in the sidebar and work on it individually! */}
      <Composition
        id="OnlyLogo"
        component={Logo}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema2}
        defaultProps={{
          logoColor1: "#91dAE2" as const,
          logoColor2: "#86A8E7" as const,
        }}
      />

      {/* Plan-as-copy demo: the website plan rendered as a video */}
      <Composition
        id="PlanVideo"
        component={PlanVideo}
        fps={30}
        width={1920}
        height={1080}
        schema={planSchema}
        calculateMetadata={async ({ props }) => {
          const scenes = (props.scenes as Array<{ durationFrames?: number }>) || [];
          const total = scenes.reduce(
            (a, s) =>
              a + Math.max(30, Math.round(s.durationFrames ?? DEFAULT_SCENE_FRAMES)),
            0,
          );
          return { durationInFrames: total || DEFAULT_SCENE_FRAMES * 4 };
        }}
        defaultProps={{
          color1: "#91EAE4",
          color2: "#86A8E7",
          audioSrc: "",
          scenes: [
            {
              type: "cover",
              title: "AI 口播流水线",
              points: [],
              narration: "一天产一条 AI 口播，我是怎么做到的？",
              durationFrames: 120,
            },
            {
              type: "points",
              title: "Phase 1 · 脚手架",
              points: [
                "安装 @remotion/player、Vite 等依赖",
                "建立 Vite 配置 + 网页入口",
                "npm run web:dev 启动页面",
              ],
              durationFrames: 120,
            },
            {
              type: "points",
              title: "Phase 2 · 播放器页面（核心）",
              points: [
                "左侧控件：文案框 + 取色器",
                "右侧 <Player> 实时预览",
                "控件与 inputProps 双向绑定",
              ],
              durationFrames: 120,
            },
            {
              type: "conclusion",
              title: "一键导出成片",
              points: ["vite build → dist/", "Remotion 离线渲染 MP4"],
              narration: "把流程交给 AI，你只管想创意。",
              durationFrames: 120,
            },
          ],
        }}
      />

      {/* 竖屏版（抖音 9:16），复用同一组件与 schema，仅尺寸不同 */}
      <Composition
        id="PlanVideoV"
        component={PlanVideo}
        fps={30}
        width={1080}
        height={1920}
        schema={planSchema}
        calculateMetadata={async ({ props }) => {
          const scenes = (props.scenes as Array<{ durationFrames?: number }>) || [];
          const total = scenes.reduce(
            (a, s) =>
              a + Math.max(30, Math.round(s.durationFrames ?? DEFAULT_SCENE_FRAMES)),
            0,
          );
          return { durationInFrames: total || DEFAULT_SCENE_FRAMES * 4 };
        }}
        defaultProps={{
          color1: "#91EAE4",
          color2: "#86A8E7",
          audioSrc: "",
          scenes: [
            {
              type: "cover",
              title: "AI 口播流水线",
              points: [],
              narration: "一天产一条 AI 口播，我是怎么做到的？",
              durationFrames: 120,
            },
            {
              type: "conclusion",
              title: "一键导出成片",
              points: ["Remotion 离线渲染 MP4"],
              durationFrames: 120,
            },
          ],
        }}
      />

      {/* 素材库 Demo：把全部新增动画构件串成一条成片，Studio 侧栏选它一次性预览 */}
      <Composition
        id="AssetsDemo"
        component={PlanVideo}
        fps={30}
        width={1920}
        height={1080}
        schema={planSchema}
        calculateMetadata={async ({ props }) => {
          const scenes = (props.scenes as Array<{ durationFrames?: number }>) || [];
          const total = scenes.reduce(
            (a, s) =>
              a + Math.max(30, Math.round(s.durationFrames ?? DEFAULT_SCENE_FRAMES)),
            0,
          );
          return { durationInFrames: total || DEFAULT_SCENE_FRAMES * 4 };
        }}
        defaultProps={{
          color1: "#5eead4",
          color2: "#8aa2ff",
          audioSrc: "",
          transition: "fade",
          bgTheme: "dark",
          watermark: "素材库 Demo",
          scenes: ASSETS_DEMO_SCENES,
        }}
      />
    </>
  );
};

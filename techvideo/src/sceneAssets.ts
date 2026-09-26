// 素材库单一事实来源（Single Source of Truth）
// ————————————————————————————————————————————————
// 描述「一个可插入到时间线的场景素材」的元数据：类型、显示名、分组、图标、提示。
// SceneEditor 的类型选择器、TalkStudio 的「章节模板 / 动画素材」快速插入区，
// 都从这里派生。新增一个素材 = 往 SCENE_ASSETS 加一行（渲染映射见 PlanVideo / SceneLibrary）。
//
// 注意：本文件只提供「UI 元数据」，不 import PlanVideo，避免循环依赖。
// 真正决定某 type 走哪个渲染分支的是 PlanVideo.tsx 的 SceneView。

export type SceneGroup =
  | "结构"
  | "文字"
  | "数据"
  | "图像"
  | "组织"
  | "代码";

export type SceneAsset = {
  type: string;
  label: string; // 素材库显示名
  group: SceneGroup; // 分组
  emoji: string; // 选择器图标（轻量，无需外部图片）
  hint: string; // 一句话说明 / 适用场景
  library?: boolean; // true = 由 SceneLibrary 渲染的新素材；false/undefined = PlanVideo 内置分支
};

// 分组展示顺序
export const GROUP_ORDER: SceneGroup[] = [
  "结构",
  "文字",
  "数据",
  "图像",
  "组织",
  "代码",
];

export const SCENE_ASSETS: SceneAsset[] = [
  // —— 结构（PlanVideo 内置） ——
  { type: "cover", label: "封面", group: "结构", emoji: "🎬", hint: "开场大标题 + 眉标 + 副标题" },
  { type: "title", label: "标题", group: "结构", emoji: "🔤", hint: "居中大标题，配要点" },
  { type: "points", label: "要点列表", group: "结构", emoji: "📝", hint: "标题 + 逐条弹入要点" },
  { type: "conclusion", label: "结尾", group: "结构", emoji: "🎉", hint: "感谢观看 + CTA 按钮条" },

  // —— 文字 ——
  { type: "quote", label: "金句", group: "文字", emoji: "❝", hint: "大号引用金句卡" },
  { type: "cite", label: "引用", group: "文字", emoji: "📔", hint: "带出处的引用块" },
  { type: "typewriter", label: "打字机", group: "文字", emoji: "⌨️", hint: "标题逐字敲出 + 光标", library: true },
  { type: "karaoke", label: "逐词字幕", group: "文字", emoji: "🎤", hint: "口播跟读逐词高亮", library: true },
  { type: "banner", label: "划线强调", group: "文字", emoji: "🖍️", hint: "关键词马克笔划线", library: true },

  // —— 数据 ——
  { type: "data", label: "关键词高亮", group: "数据", emoji: "🔑", hint: "关键词大色块弹入" },
  { type: "chart", label: "图表", group: "数据", emoji: "📊", hint: "柱/折/饼/雷达/堆叠/面积" },
  { type: "counter", label: "数字滚动", group: "数据", emoji: "🔢", hint: "大数字 count-up", library: true },
  { type: "ring", label: "进度环", group: "数据", emoji: "🎯", hint: "百分比环形增长", library: true },
  { type: "bars", label: "数据条", group: "数据", emoji: "📶", hint: "横向占比条逐个生长", library: true },

  // —— 图像 ——
  { type: "image", label: "图片卡", group: "图像", emoji: "🖼️", hint: "标题 + 图片 + 说明" },
  { type: "kb", label: "Ken Burns", group: "图像", emoji: "🎞️", hint: "图片缓慢推拉运镜", library: true },

  // —— 组织 ——
  { type: "timeline", label: "时间线", group: "组织", emoji: "⏳", hint: "时间节点逐条出现" },
  { type: "compare", label: "对比", group: "组织", emoji: "⚖️", hint: "多列卡片对比" },
  { type: "checklist", label: "打勾清单", group: "组织", emoji: "✅", hint: "条目依次打勾", library: true },
  { type: "cards", label: "卡片网格", group: "组织", emoji: "🃏", hint: "图标卡片错落飞入", library: true },
  { type: "chat", label: "对话气泡", group: "组织", emoji: "💬", hint: "聊天窗逐条气泡", library: true },

  // —— 代码 ——
  { type: "code", label: "代码窗口", group: "代码", emoji: "💻", hint: "macOS 窗口代码逐行", library: true },
];

// 素材库（library:true）集合 —— PlanVideo 据此决定是否交给 SceneLibrary 渲染
export const LIBRARY_ASSETS = SCENE_ASSETS.filter((a) => a.library);
export const LIBRARY_TYPES: string[] = LIBRARY_ASSETS.map((a) => a.type);

export const assetByType = (type: string): SceneAsset | undefined =>
  SCENE_ASSETS.find((a) => a.type === type);

// 按分组归整，供 <optgroup> / 分组网格使用（保持 GROUP_ORDER 顺序）
export function assetsByGroup(): { group: SceneGroup; items: SceneAsset[] }[] {
  return GROUP_ORDER.map((g) => ({
    group: g,
    items: SCENE_ASSETS.filter((a) => a.group === g),
  })).filter((x) => x.items.length > 0);
}

// 新素材插入时的「默认字段」覆盖（blankScene(over) 的 over）。
// 与 PlanVideo 的 sceneSchema 字段保持一致，确保预览/渲染都有合理初值。
export const ASSET_DEFAULTS: Record<string, object> = {
  typewriter: { type: "typewriter", title: "一句话逐字敲出来", revealSpeed: 12 },
  karaoke: {
    type: "karaoke",
    title: "口播跟读",
    subtitles: [
      { start: 0, end: 1.5, text: "把每句话拆成词" },
      { start: 1.5, end: 3, text: "逐词高亮跟读" },
    ],
  },
  banner: { type: "banner", title: "这是要被划线的重点句", emphasis: ["重点"] },
  counter: {
    type: "counter",
    title: "累计产出",
    counterTo: 128,
    counterFrom: 0,
    counterSuffix: " 条",
    counterDecimals: 0,
  },
  ring: { type: "ring", title: "目标完成度", percent: 76 },
  bars: {
    type: "bars",
    title: "各平台播放占比",
    bars: [
      { label: "抖音", value: 52 },
      { label: "视频号", value: 28 },
      { label: "B站", value: 14 },
      { label: "小红书", value: 6 },
    ],
  },
  checklist: {
    type: "checklist",
    title: "发布前检查",
    points: ["封面吸睛", "前3秒钩子", "字幕校对", "话题标签"],
  },
  cards: {
    type: "cards",
    title: "三个核心能力",
    cards: [
      { emoji: "⚡", title: "秒级出稿", desc: "文案自动生成" },
      { emoji: "🎙️", title: "数字人口播", desc: "本地/云双通道" },
      { emoji: "🎞️", title: "一键成片", desc: "Remotion 渲染" },
    ],
  },
  kb: { type: "kb", title: "画面呼吸感", caption: "缓慢推进的特写", imageUrl: "" },
  chat: {
    type: "chat",
    title: "粉丝都在问",
    messages: [
      { side: "other", from: "粉丝", text: "这个怎么做到的？" },
      { side: "me", from: "我", text: "一条流水线全自动" },
      { side: "other", from: "粉丝", text: "求教程！" },
    ],
  },
  code: {
    type: "code",
    title: "render.ts",
    codeLang: "ts",
    code: "import { renderMedia } from '@remotion/renderer';\n\nawait renderMedia({\n  composition,\n  codec: 'h264',\n});",
  },
};

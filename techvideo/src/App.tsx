import { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { PlanVideo, resolveMediaSrc } from "./PlanVideo";
import AgentPanel, { type Msg } from "./AgentPanel";

interface Subtitle {
  start: number;
  end: number;
  text: string;
}

interface Scene {
  type: string;
  title: string;
  points: string[];
  narration?: string;
  keywords?: string[];
  subtitles?: Subtitle[];
  chart?: { kind: string; unit?: string; labels: string[]; values: number[]; series?: { name: string; values: number[] }[] };
  durationFrames?: number;
  imageUrl?: string;
  caption?: string;
  quote?: string;
  events?: { time: string; text: string }[];
  columns?: { name: string; items: string[] }[];
  source?: string;
  author?: string;
  color1?: string;
  color2?: string;
  fontScale?: number;
  titleScale?: number;
  layout?: "center" | "left" | "split";
  animation?: "fade" | "slide" | "zoom" | "none";
  durationSec?: number;
  emphasis?: string[];
  kicker?: string;
  imagePrompt?: string;
}

interface Plan {
  color1: string;
  color2: string;
  scenes: Scene[];
  audio_url: string;
}

const FPS = 30;

// 经典配色预设：每项含主色 c1 + 辅色 c2，渲染前可一键选择（色板）
const COLOR_PRESETS: { name: string; c1: string; c2: string }[] = [
  { name: "青蓝默认", c1: "#91EAE4", c2: "#86A8E7" },
  { name: "科技蓝紫", c1: "#5B8DEF", c2: "#A06CD5" },
  { name: "中国红金", c1: "#E63946", c2: "#F4A261" },
  { name: "深海墨蓝", c1: "#0EA5E9", c2: "#1E3A8A" },
  { name: "橙黑科技", c1: "#FF7A00", c2: "#FFD29D" },
  { name: "极光青绿", c1: "#00C9A7", c2: "#2EC4B6" },
  { name: "莫兰迪灰", c1: "#C9ADA7", c2: "#9A8C98" },
  { name: "紫粉梦幻", c1: "#C77DFF", c2: "#E0AAFF" },
  { name: "翡翠金", c1: "#2A9D8F", c2: "#E9C46A" },
  { name: "霓虹粉青", c1: "#FF5DA2", c2: "#46E5C8" },
];

// 品牌套件（P3 视觉系统锁定）：一键套用「主色 + 辅色 + 背景主题」，保证整片视觉统一。
const BRAND_KITS: { name: string; c1: string; c2: string; bg: "dark" | "light" }[] = [
  { name: "青蓝默认", c1: "#91EAE4", c2: "#86A8E7", bg: "dark" },
  { name: "科技蓝紫", c1: "#5B8DEF", c2: "#A06CD5", bg: "dark" },
  { name: "中国红金", c1: "#E63946", c2: "#F4A261", bg: "dark" },
  { name: "深海墨蓝", c1: "#0EA5E9", c2: "#1E3A8A", bg: "dark" },
  { name: "橙黑科技", c1: "#FF7A00", c2: "#FFD29D", bg: "dark" },
  { name: "极光青绿", c1: "#00C9A7", c2: "#2EC4B6", bg: "dark" },
  { name: "莫兰迪灰", c1: "#C9ADA7", c2: "#9A8C98", bg: "light" },
  { name: "紫粉梦幻", c1: "#C77DFF", c2: "#E0AAFF", bg: "dark" },
  { name: "翡翠金", c1: "#2A9D8F", c2: "#E9C46A", bg: "dark" },
  { name: "霓虹粉青", c1: "#FF5DA2", c2: "#46E5C8", bg: "dark" },
];

// 平台导出预设（P5）：一键匹配目标平台的画幅、推荐转场与字号策略。
const PLATFORM_PRESETS: {
  value: string;
  label: string;
  aspect: "16:9" | "9:16";
  transition: string;
  fontScale: number;
  hint: string;
}[] = [
  { value: "default", label: "默认横屏", aspect: "16:9", transition: "slide", fontScale: 1, hint: "通用 16:9" },
  { value: "douyin", label: "抖音", aspect: "9:16", transition: "zoom", fontScale: 1.05, hint: "竖屏 9:16 · 节奏感强" },
  { value: "kuaishou", label: "快手", aspect: "9:16", transition: "zoom", fontScale: 1.05, hint: "竖屏 9:16 · 信息直接" },
  { value: "shipinhao", label: "视频号", aspect: "9:16", transition: "fade", fontScale: 1, hint: "竖屏 9:16 · 温和过渡" },
  { value: "bilibili", label: "B站", aspect: "16:9", transition: "slide", fontScale: 1, hint: "横屏 16:9 · 知识区" },
  { value: "xiaohongshu", label: "小红书", aspect: "9:16", transition: "slide", fontScale: 1.02, hint: "竖屏 9:16 · 图文笔记风" },
];

// 统一转场选项（P3）：全局一致，场景级 animation 可覆盖。
const TRANSITIONS: { value: string; label: string }[] = [
  { value: "fade", label: "淡入淡出" },
  { value: "slide", label: "横向滑动" },
  { value: "zoom", label: "缩放推拉" },
  { value: "blur", label: "模糊聚焦" },
  { value: "wipe", label: "品牌擦除" },
  { value: "none", label: "硬切" },
];

function brandNameOf(c1: string, c2: string, bg: string): string {
  const hit = BRAND_KITS.find((b) => b.c1 === c1 && b.c2 === c2 && b.bg === bg);
  return hit ? hit.name : `${c1}/${c2}·${bg === "light" ? "白" : "黑"}`;
}

// 标题多行输入框：随内容自动增高（避免换行后被遮挡）。
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const TYPE_LABEL: Record<string, string> = {
  cover: "封面",
  points: "要点",
  data: "数据",
  chart: "图表",
  conclusion: "结尾",
  image: "图片卡",
  quote: "金句卡",
  timeline: "时间线",
  compare: "对比",
  cite: "引用",
};

const CHART_LABEL: Record<string, string> = {
  pie: "饼图·占比",
  line: "折线·趋势",
  area: "面积·趋势",
  radar: "雷达·多维",
  stacked: "堆叠·构成",
  bar: "柱状·对比",
};
function chartLabel(kind?: string): string {
  return CHART_LABEL[kind || "bar"] || "柱状·对比";
}

const DEFAULT_SCENES: Scene[] = [
  {
    type: "cover",
    title: "AI 口播流水线",
    points: [],
    narration: "一天产一条 AI 口播，我是怎么做到的？",
    durationFrames: 120,
    fontScale: 1.05,
  },
  {
    type: "points",
    title: "Phase 1 · 脚手架",
    points: ["安装 @remotion/player、Vite 等依赖", "建立网页入口"],
    durationFrames: 120,
    fontScale: 1.05,
  },
  {
    type: "conclusion",
    title: "一键导出成片",
    points: ["Remotion 离线渲染 MP4"],
    narration: "把流程交给 AI，你只管想创意。",
    durationFrames: 120,
    fontScale: 1.05,
  },
];

export default function App() {
  const [color1, setColor1] = useState("#91EAE4");
  const [color2, setColor2] = useState("#86A8E7");
  const [brand, setBrand] = useState("青蓝默认");
  const [transition, setTransition] = useState("zoom");
  const [theme, setTheme] = useState("");
  const [language, setLanguage] = useState("zh-CN");
  const [sceneCount, setSceneCount] = useState(0);
  const [voiceName, setVoiceName] = useState("");
  const [bgm, setBgm] = useState("");
  const [bgmList, setBgmList] = useState<{ name: string; label: string }[]>([]);
  const [scenes, setScenes] = useState<Scene[]>(DEFAULT_SCENES);
  const [audioUrl, setAudioUrl] = useState("");
  const [mode, setMode] = useState<"form" | "agent">("form");
  const [bgTheme, setBgTheme] = useState<"dark" | "light">("dark");
  const [watermark, setWatermark] = useState("@田哥 · AI成长日记");
  const [showSubtitle, setShowSubtitle] = useState(true); // 预览/导出：是否显示底部字幕
  const [showNarration, setShowNarration] = useState(true); // 预览/导出：是否显示旁白说明
  const [decomposing, setDecomposing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<PlayerRef>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState<Record<number, boolean>>({});

  // P2：拉取可用背景音乐列表（techvideo/bgm 目录动态扫描）
  useEffect(() => {
    fetch("/api/v1/techvideo/bgm")
      .then((r) => r.json())
      .then((d) => {
        if (d && d.status === 200 && Array.isArray(d.data?.bgm)) {
          setBgmList(d.data.bgm);
        }
      })
      .catch(() => {});
  }, []);

  // 品牌套件与配色/背景保持同步：手动改色后，若命中某套件则回写为该套件名，否则标「自定义」。
  useEffect(() => {
    const hit = BRAND_KITS.find((b) => b.c1 === color1 && b.c2 === color2 && b.bg === bgTheme);
    setBrand(hit ? hit.name : "自定义");
  }, [color1, color2, bgTheme]);
  const [agentMessages, setAgentMessages] = useState<Msg[]>([
    {
      role: "agent",
      text: "你好，我是科技视频助手。告诉我主题（如「三分钟看懂大模型」）即可生成视频；或基于当前画面下指令，例如「第三个场景改成饼图」「配色换成中国红金」「文案太长了精简一下」。",
    },
  ]);

  // 自动视频模式：主前端以 /techvideo/?mode=auto 嵌入时启用口播素材叠加工作流。
  const autoMode = new URLSearchParams(window.location.search).get("mode") === "auto";
  const [personVideo, setPersonVideo] = useState(""); // 口播素材相对路径 uploads/xxx.mp4
  const [personDurationSec, setPersonDurationSec] = useState(0); // 口播素材时长（秒）
  const [personUploading, setPersonUploading] = useState(false); // 口播素材上传中
  const [personProgress, setPersonProgress] = useState(0); // 上传进度 0-100
  const [videoLayout, setVideoLayout] = useState<"cross-cut" | "pip" | "underlay">("cross-cut");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("9:16");
  const [platformPreset, setPlatformPreset] = useState("douyin");

  // P6：AI 生图（供应商聚合 image 能力）/ AI 找图（Pexels）
  const [imgProviders, setImgProviders] = useState<
    { vendor_id: string; label: string; default_model: string; models: string[]; status: string; api_key_url: string }[]
  >([]);
  const [imgVendor, setImgVendor] = useState("");
  const [imgModel, setImgModel] = useState("");
  const [imgSearch, setImgSearch] = useState<{
    scene: number;
    photos: { id: number; thumb: string; full: string; photographer: string; url: string }[];
  }>({ scene: -1, photos: [] });
  const [imgSearching, setImgSearching] = useState(false);

  // 拉取支持图片生成的供应商（供应商聚合 image 能力），填充 AI 生图下拉。
  useEffect(() => {
    fetch("/api/v1/techvideo/image/providers")
      .then((r) => r.json())
      .then((d) => {
        const ps = d?.data?.providers || [];
        setImgProviders(ps);
        if (ps.length) {
          setImgVendor(ps[0].vendor_id);
          setImgModel(ps[0].default_model || "");
        }
      })
      .catch(() => {});
  }, []);

  // 探测口播素材时长：上传或恢复方案后，用隐藏 video 元素读取元数据得到秒数。
  useEffect(() => {
    if (!personVideo) {
      setPersonDurationSec(0);
      return;
    }
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = resolveMediaSrc(personVideo);
    v.onloadedmetadata = () => {
      if (v.duration && isFinite(v.duration)) setPersonDurationSec(v.duration);
    };
    v.onerror = () => setPersonDurationSec(0);
  }, [personVideo]);

  const FPS = 30;
  const personDurationFrames = personDurationSec > 0 ? Math.round(personDurationSec * FPS) : 0;

  // 口播素材驱动时长：整体时长=素材时长，文本场景按时长占比重分配（不裁剪素材）。
  const effectiveScenes = useMemo(() => {
    if (autoMode && personVideo && personDurationFrames > 0) {
      const base =
        scenes.reduce((a, s) => a + Math.max(30, Math.round(s.durationFrames ?? 90)), 0) || 1;
      const out: Scene[] = scenes.map((s) => {
        const d = Math.max(30, Math.round(s.durationFrames ?? 90));
        return { ...s, durationFrames: Math.max(30, Math.round((d / base) * personDurationFrames)) };
      });
      // 吸收取整误差到最后一个场景，确保总和严格等于素材时长（与导出总帧数一致）。
      if (out.length) {
        const sum = out.reduce((a, s) => a + Math.round(s.durationFrames ?? 90), 0);
        const diff = personDurationFrames - sum;
        if (diff !== 0) {
          const last = out[out.length - 1];
          out[out.length - 1] = {
            ...last,
            durationFrames: Math.round(last.durationFrames ?? 90) + diff,
          };
        }
      }
      return out;
    }
    // 口播素材但未知时长：保持旧「硬切交替」兜底行为。
    if (autoMode && personVideo && videoLayout === "cross-cut") {
      const out: Scene[] = [];
      for (const s of scenes) {
        out.push(s);
        const dur = Math.max(30, Math.round(s.durationFrames ?? 90));
        out.push({ ...s, type: "video", title: "", points: [], durationFrames: dur } as Scene);
      }
      return out;
    }
    return scenes;
  }, [scenes, autoMode, personVideo, videoLayout, personDurationFrames]);

  const durationInFrames = Math.max(
    1,
    effectiveScenes.reduce(
      (a, s) => a + Math.max(30, Math.round(s.durationFrames ?? 90)),
      0,
    ),
  );

  const [pw, ph] = aspect === "9:16" ? [1080, 1920] : [1920, 1080];

  const inputProps = useMemo(
    () => ({
      color1,
      color2,
      audioSrc: audioUrl ? `${window.location.origin}${audioUrl}` : "",
      scenes: effectiveScenes,
      bgTheme,
      watermark,
      personVideo,
      videoLayout,
      aspect,
      transition,
      showSubtitle,
      showNarration,
    }),
    [color1, color2, audioUrl, effectiveScenes, bgTheme, watermark, personVideo, videoLayout, aspect, transition, showSubtitle, showNarration],
  );

  const currentPlan: Plan = {
    color1,
    color2,
    scenes,
    audio_url: audioUrl,
  };

  function applyAgentPlan(p: Plan, reply: string) {
    setScenes(p.scenes);
    setColor1(p.color1);
    setColor2(p.color2);
    setAudioUrl(p.audio_url);
    setBgm((p as { bgm?: string }).bgm || "");
    const ap = p as { bg_theme?: string; transition?: string };
    if (ap.bg_theme === "light" || ap.bg_theme === "dark") setBgTheme(ap.bg_theme);
    if (ap.transition) setTransition(ap.transition);
    if (reply) setMessage("AGENT：" + reply);
  }

  // 图片卡预览：把 techvideo/public 相对路径拼成可访问 URL（远程 URL 原样返回）。
  function previewUrl(u?: string) {
    if (!u) return "";
    if (u.startsWith("http")) return u;
    return `${window.location.origin}/techvideo-public/${u.replace(/^\/+/, "")}`;
  }

  function updateScene(i: number, patch: Partial<Scene>) {
    setScenes((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function setPoints(i: number, text: string) {
    updateScene(i, {
      points: text
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    });
  }

  function updateEvent(i: number, ei: number, patch: Partial<{ time: string; text: string }>) {
    const events = [...(scenes[i].events || [])];
    events[ei] = { ...events[ei], ...patch };
    updateScene(i, { events });
  }
  function addEvent(i: number) {
    updateScene(i, { events: [...(scenes[i].events || []), { time: "", text: "" }] });
  }
  function removeEvent(i: number, ei: number) {
    updateScene(i, { events: (scenes[i].events || []).filter((_, k) => k !== ei) });
  }

  function updateColumn(i: number, ci: number, patch: Partial<{ name: string; items: string[] }>) {
    const columns = [...(scenes[i].columns || [])];
    columns[ci] = { ...columns[ci], ...patch };
    updateScene(i, { columns });
  }
  function setColumnItems(i: number, ci: number, text: string) {
    updateColumn(i, ci, {
      items: text
        .split("\n")
        .map((x) => x.replace(/^[-·]\s*/, "").trim())
        .filter(Boolean),
    });
  }
  function addColumn(i: number) {
    updateScene(i, { columns: [...(scenes[i].columns || []), { name: "", items: [] }] });
  }
  function removeColumn(i: number, ci: number) {
    updateScene(i, { columns: (scenes[i].columns || []).filter((_, k) => k !== ci) });
  }

  const [chartRaw, setChartRaw] = useState<Record<string, string>>({});
  const chartRawKey = (i: number, field: "labels" | "values", si?: number) =>
    si === undefined ? `${i}:${field}` : `${i}:${field}:${si}`;

  function setChartLabels(i: number, text: string) {
    updateScene(i, {
      chart: {
        ...(scenes[i].chart || { kind: "bar", values: [] }),
        labels: text.split(",").map((x) => x.trim()).filter(Boolean),
      },
    });
  }
  function setChartValues(i: number, text: string) {
    updateScene(i, {
      chart: {
        ...(scenes[i].chart || { kind: "bar", labels: [] }),
        values: text
          .split(",")
          .map((x) => parseFloat(x))
          .filter((n) => !Number.isNaN(n)),
      },
    });
  }
  function setSeriesValues(i: number, si: number, text: string) {
    const chart = scenes[i].chart || { kind: "bar", labels: [], values: [] };
    const series = [...(chart.series || [])];
    series[si] = {
      ...series[si],
      values: text
        .split(",")
        .map((x) => parseFloat(x))
        .filter((n) => !Number.isNaN(n)),
    };
    updateScene(i, { chart: { ...chart, series } });
  }
  function addSeries(i: number) {
    const chart = scenes[i].chart || { kind: "bar", labels: [], values: [] };
    const series = [...(chart.series || [])];
    series.push({ name: `系列${series.length + 1}`, values: [] });
    updateScene(i, { chart: { ...chart, series } });
  }
  function removeSeries(i: number, si: number) {
    const chart = scenes[i].chart || { kind: "bar", labels: [], values: [] };
    const series = (chart.series || []).filter((_, k) => k !== si);
    updateScene(i, { chart: { ...chart, series } });
  }

  async function handleImageUpload(i: number, file: File) {
    setUploading((m) => ({ ...m, [i]: true }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/v1/techvideo/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.status !== 200 || !data.data?.url) {
        throw new Error(data.message || "上传失败");
      }
      updateScene(i, { imageUrl: data.data.url });
      setMessage("图片已上传，预览与导出将使用同一份文件。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((m) => ({ ...m, [i]: false }));
    }
  }

  async function handleVideoUpload(file: File) {
    setPersonUploading(true);
    setPersonProgress(0);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await new Promise<{ status: number; message?: string; data?: { url?: string } }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/v1/techvideo/upload");
          xhr.upload.onprogress = (e: ProgressEvent) => {
            if (e.lengthComputable) setPersonProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error("响应解析失败"));
            }
          };
          xhr.onerror = () => reject(new Error("网络错误，上传失败"));
          xhr.send(fd);
        },
      );
      if (data.status !== 200 || !data.data?.url) {
        throw new Error(data.message || "上传失败");
      }
      setPersonVideo(data.data.url);
      setPersonProgress(100);
      setMessage("口播素材已上传，将作为交叉合成的底片使用。");
    } catch (e) {
      setError((e as Error).message);
      setPersonProgress(0);
    } finally {
      setPersonUploading(false);
    }
  }

  // P4：AI 配图插页——根据提示词调用后端图像生成，成功后直接套用为图片卡 imageUrl。
  async function handleIllustrate(i: number) {
    const prompt = (scenes[i].imagePrompt || scenes[i].caption || scenes[i].title || "").trim();
    if (!prompt) {
      setError("请先填写「配图提示词」或说明文字，AI 才能据此生成配图。");
      return;
    }
    setUploading((m) => ({ ...m, [i]: true }));
    try {
      const res = await fetch("/api/v1/techvideo/illustrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.status !== 200 || !data.data?.ok) {
        throw new Error(data.data?.message || data.message || "生成失败。");
      }
      updateScene(i, { imageUrl: data.data.url });
      setMessage("AI 配图已生成并应用。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((m) => ({ ...m, [i]: false }));
    }
  }

  // P6：AI 生图——按所选供应商的 image 模型，从提示词生成配图并套用为图片卡。
  async function handleAiGenerate(i: number) {
    const prompt = (scenes[i].imagePrompt || scenes[i].caption || scenes[i].title || "").trim();
    if (!prompt) {
      setError("请先填写「配图提示词」或说明文字，AI 才能据此生图。");
      return;
    }
    if (!imgVendor) {
      setError("请先选择一个生图供应商（系统设置→供应商聚合中配置图片模型）。");
      return;
    }
    setUploading((m) => ({ ...m, [i]: true }));
    try {
      const res = await fetch("/api/v1/techvideo/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor: imgVendor, model: imgModel, prompt }),
      });
      const data = await res.json();
      if (data.status !== 200 || !data.data?.ok) {
        throw new Error(data.data?.message || data.message || "生成失败。");
      }
      updateScene(i, { imageUrl: data.data.url, type: "image" });
      setMessage("AI 生图已生成并应用。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((m) => ({ ...m, [i]: false }));
    }
  }

  // P6：AI 找图——在 Pexels 按提示词随机取 6 张供挑选（refresh=true 换一批）。
  async function handleAiFind(i: number, refresh: boolean) {
    const query = (scenes[i].imagePrompt || scenes[i].caption || scenes[i].title || "科技").trim();
    setImgSearch((s) => ({ ...s, scene: i }));
    setImgSearching(true);
    try {
      const res = await fetch("/api/v1/techvideo/image/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, page: refresh ? Math.floor(Math.random() * 25) + 1 : 0 }),
      });
      const data = await res.json();
      if (data.status !== 200 || !data.data?.ok) {
        throw new Error(data.data?.message || data.message || "搜索失败。");
      }
      setImgSearch((s) => ({ ...s, photos: data.data.photos || [] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImgSearching(false);
    }
  }

  // P6：选中某张 Pexels 图片——下载到本地（供离线渲染）并套用为图片卡。
  async function handlePickPhoto(i: number, photo: { id: number; thumb: string; full: string; photographer: string; url: string }) {
    if (!photo?.full) return;
    setUploading((m) => ({ ...m, [i]: true }));
    try {
      const res = await fetch("/api/v1/techvideo/image/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: photo.full }),
      });
      const data = await res.json();
      if (data.status !== 200 || !data.data?.ok) {
        throw new Error(data.data?.message || "下载失败。");
      }
      updateScene(i, { imageUrl: data.data.url, type: "image" });
      setMessage(`已选用 Pexels 图片（@${photo.photographer || "未知"}）并下载到本地。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((m) => ({ ...m, [i]: false }));
    }
  }

  async function decompose() {
    setDecomposing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/techvideo/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme,
          script: "",
          language,
          scene_count: sceneCount,
          voice_name: voiceName,
          voice_rate: 1.0,
          bgm,
        }),
      });
      const data = await res.json();
      if (
        data.status !== 200 ||
        !data.data ||
        !data.data.scenes ||
        !data.data.scenes.length
      ) {
        throw new Error(data.message || "拆解失败");
      }
      setScenes(data.data.scenes);
      setAudioUrl(data.data.audio_url || "");
      setMessage(
        `已拆解 ${data.data.scenes.length} 个场景，总时长约 ${data.data.total_duration_sec}s`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDecomposing(false);
    }
  }

  async function exportVideo() {
    setExporting(true);
    setProgress(0);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/techvideo/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          color1,
          color2,
          audio_url: audioUrl,
          scenes: effectiveScenes,
          bg_theme: bgTheme,
          watermark,
          person_video: personVideo,
          video_layout: videoLayout,
          aspect,
          transition,
          show_subtitle: showSubtitle,
          show_narration: showNarration,
          audio_mode: "footage",
          person_video_duration: personDurationSec,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `渲染失败 (HTTP ${res.status})`);
      }
      await res.arrayBuffer();
      try {
        window.parent.postMessage({ type: "techvideo-render-complete" }, "*");
      } catch {
        /* 忽略跨域通信异常 */
      }
      setMessage("已生成，成片已加入下方「画廊」。");
    } catch (e) {
      setError(
        (e as Error).message +
          "\n（若后端未启动，可在 techvideo 目录执行 npm run render 离线渲染）",
      );
    } finally {
      setExporting(false);
      setProgress(100);
    }
  }

  return (
    <>
      <div className="tv">
      <header className="tv-head">
        <div>
          <h1>科技视频生成器</h1>
          <p className="sub">
            Remotion · 文案驱动的动态视频（自动拆解 · 实时预览 · 一键导出）
          </p>
        </div>
        <a
          className="studio-link"
          href="http://localhost:3000"
          target="_blank"
          rel="noreferrer"
        >
          在 Remotion Studio 中打开 ↗
        </a>
      </header>

      {mode === "form" && (
        <div className="tv-input">
          <div className="field grow">
            <label>视频主题 / 文案</label>
            <input
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="例如：三分钟看懂 AI 口播流水线"
            />
          </div>
          <div className="field">
            <label>语言</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="zh-CN">中文</option>
              <option value="en-US">英文</option>
            </select>
          </div>
          <div className="field" title="填 0 表示不限制，由 AI 根据文案自动决定场景数量">
            <label>场景数</label>
            <input
              type="number"
              min={0}
              max={12}
              value={sceneCount}
              onChange={(e) => setSceneCount(Number(e.target.value))}
              style={{ minWidth: 80 }}
            />
          </div>
          <div className="field">
            <label>配音音色（可选）</label>
            <input
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
              placeholder="留空则无配音"
              style={{ minWidth: 180 }}
            />
          </div>
          <div className="field">
            <label>背景音乐（BGM）</label>
            <select value={bgm} onChange={(e) => setBgm(e.target.value)}>
              <option value="">无（纯配音）</option>
              {bgmList.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.label}
                </option>
              ))}
            </select>
            {bgmList.length === 0 ? (
              <span className="input-hint">
                在 techvideo/bgm 放入 mp3 即可出现（也可放自己的音乐）
              </span>
            ) : null}
          </div>
          <button
            className="btn primary"
            style={{ width: "auto", padding: "10px 18px" }}
            onClick={decompose}
            disabled={decomposing || !theme.trim()}
          >
            {decomposing ? "拆解中…" : "AI 自动拆解"}
          </button>
        </div>
      )}

      {autoMode && (
        <div className="tv-input auto-panel">
          <div className="block-head">
            <h3>口播素材叠加</h3>
          </div>
          <div className="field grow">
            <label>口播短视频（本地）</label>
            <input
              type="file"
              accept="video/*"
              disabled={personUploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleVideoUpload(f);
              }}
            />
            {personUploading && (
              <div style={{ marginTop: 8 }}>
                <div
                  style={{
                    width: "100%",
                    height: 10,
                    background: "#e9eef5",
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${personProgress}%`,
                      background: "linear-gradient(90deg,#7b61ff,#4f8cff)",
                      transition: "width .15s ease",
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, marginTop: 4, color: "#5b6b85" }}>
                  上传中 {personProgress}%
                </div>
              </div>
            )}
            {personVideo ? (
              <video
                src={resolveMediaSrc(personVideo)}
                controls
                muted
                style={{ marginTop: 8, width: "100%", maxHeight: 160, borderRadius: 8, background: "#000" }}
              />
            ) : (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                上传你的口播片段，将作为交叉合成的底片（用其原声，不叠加 TTS）。
              </p>
            )}
          </div>
          <div className="field">
            <label>交叉方式</label>
              <select value={videoLayout} onChange={(e) => setVideoLayout(e.target.value as "cross-cut" | "pip" | "underlay")}>
              <option value="cross-cut">硬切（整屏交替）</option>
              <option value="pip">画中画（人头浮窗）</option>
              <option value="underlay">底片混排（口播铺底+字幕覆盖）</option>
            </select>
          </div>
          <div className="field">
            <label>平台预设（P5）</label>
            <select
              value={platformPreset}
              onChange={(e) => {
                const v = e.target.value;
                setPlatformPreset(v);
                const p = PLATFORM_PRESETS.find((x) => x.value === v);
                if (p) {
                  setAspect(p.aspect);
                  setTransition(p.transition);
                  // 平台字号策略：统一给所有场景一个基准 fontScale（用户仍可单场景微调）。
                  setScenes((prev) =>
                    prev.map((s) => ({ ...s, fontScale: p.fontScale })),
                  );
                }
              }}
            >
              {PLATFORM_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}（{p.hint}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>画幅</label>
            <select value={aspect} onChange={(e) => setAspect(e.target.value as "16:9" | "9:16")}>
              <option value="9:16">竖屏 9:16（抖音）</option>
              <option value="16:9">横屏 16:9</option>
            </select>
          </div>
        </div>
      )}

      <div className="tv-body">
        <aside className="tv-panel">
          <div className="tv-tabs">
            <button
              className={`tab${mode === "form" ? " active" : ""}`}
              onClick={() => setMode("form")}
            >
              表单模式
            </button>
            <button
              className={`tab${mode === "agent" ? " active" : ""}`}
              onClick={() => setMode("agent")}
            >
              AGENT 对话
            </button>
          </div>

          <div className="tv-panel-body">
            {mode === "form" ? (
            <>
              <section className="block">
                <h3>配色</h3>
                <div className="color-row">
                  <label>
                    <span>主色</span>
                    <input
                      type="color"
                      value={color1}
                      onChange={(e) => setColor1(e.target.value)}
                    />
                    <code>{color1}</code>
                  </label>
                  <label>
                    <span>辅色</span>
                    <input
                      type="color"
                      value={color2}
                      onChange={(e) => setColor2(e.target.value)}
                    />
                    <code>{color2}</code>
                  </label>
                </div>
                <label className="field" style={{ marginTop: 12 }}>
                  <span>品牌套件（一键锁定视觉系统）</span>
                  <select
                    value={brand}
                    onChange={(e) => {
                      const k = BRAND_KITS.find((b) => b.name === e.target.value);
                      if (k) {
                        setBrand(k.name);
                        setColor1(k.c1);
                        setColor2(k.c2);
                        setBgTheme(k.bg);
                      }
                    }}
                  >
                    {BRAND_KITS.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}（{b.bg === "light" ? "白底" : "黑底"}）
                      </option>
                    ))}
                    <option value="自定义">自定义（手动配色）</option>
                  </select>
                </label>
                <p className="preset-hint">经典配色（点击选用，渲染前可随时切换）</p>
                <div className="preset-row">
                  {COLOR_PRESETS.map((p) => {
                    const active = color1 === p.c1 && color2 === p.c2;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        className={`preset${active ? " active" : ""}`}
                        title={`${p.name}（${p.c1} / ${p.c2}）`}
                        onClick={() => {
                          setColor1(p.c1);
                          setColor2(p.c2);
                        }}
                        style={{
                          background: `linear-gradient(135deg, ${p.c1}, ${p.c2})`,
                        }}
                      >
                        <span>{p.name}</span>
                      </button>
                    );
                  })}
                </div>
                <label className="field" style={{ marginTop: 14 }}>
                  <span>统一转场（全部场景一致）</span>
                  <select
                    value={transition}
                    onChange={(e) => setTransition(e.target.value)}
                  >
                    {TRANSITIONS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <section className="block">
                <div className="field grow watermark-field">
                  <input
                    value={watermark}
                    onChange={(e) => setWatermark(e.target.value)}
                    placeholder="@田哥 · AI成长日记"
                  />
                  <label className="input-hint">水印文字（留空则不显示）</label>
                </div>
              </section>

              <section className="block">
                <div className="block-head">
                  <h3>预览显示</h3>
                </div>
                <div className="toggle-row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showSubtitle}
                      onChange={(e) => setShowSubtitle(e.target.checked)}
                    />
                    <span>显示字幕（底部）</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showNarration}
                      onChange={(e) => setShowNarration(e.target.checked)}
                    />
                    <span>显示旁白（内容区）</span>
                  </label>
                </div>
                <p className="input-hint">关闭后预览与导出均隐藏对应内容；字幕区留给第三方平台制作。</p>
              </section>

              <section className="block">
                <div className="block-head">
                  <h3>场景脚本（{scenes.length}）</h3>
                  <p className="meta-row">
                    {brandNameOf(color1, color2, bgTheme)} · 转场{" "}
                    {TRANSITIONS.find((t) => t.value === transition)?.label || transition} · BGM{" "}
                    {bgmList.find((b) => b.name === bgm)?.label || "无"} · {aspect}
                  </p>
                  <button
                    type="button"
                    className="mini"
                    onClick={() => {
                      const ni = scenes.length;
                      setScenes((prev) => [
                        ...prev,
                        {
                          type: "image",
                          title: "图片标题",
                          imageUrl: "",
                          caption: "",
                          durationFrames: 120,
                        } as Scene,
                      ]);
                      setEditingIdx(ni);
                    }}
                  >
                    + 添加场景
                  </button>
                </div>
                <div className="scenes">
                  {scenes.map((s, i) => {
                    const open = editingIdx === i;
                    const chart = s.chart || { kind: "bar", labels: [], values: [] };
                    return (
                      <div className="scene" key={i}>
                        <div
                          className="scene-head"
                          style={{ cursor: "pointer" }}
                          onClick={() => setEditingIdx(open ? null : i)}
                        >
                          <span className="idx">#{i + 1}</span>
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>
                            {TYPE_LABEL[s.type] || s.type}
                          </span>
                          <span className="scene-title" style={{ flex: 1 }}>
                            {s.title || "（未命名）"}
                          </span>
                          <button
                            type="button"
                            className="mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingIdx(open ? null : i);
                            }}
                          >
                            {open ? "收起" : "编辑"}
                          </button>
                        </div>

                        {!open ? (
                          <div style={{ padding: "4px 0" }}>
                            {(s.points || []).map((p, pi) => (
                              <div
                                key={pi}
                                style={{ fontSize: 12, color: "var(--muted)", padding: "2px 0" }}
                              >
                                · {p}
                              </div>
                            ))}
                            {s.quote ? (
                              <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", padding: "2px 0" }}>
                                金句：{s.quote}
                              </div>
                            ) : null}
                            {s.events?.length ? (
                              <div style={{ fontSize: 12, color: "var(--muted)", padding: "2px 0" }}>
                                时间线：{s.events.map((e) => `${e.time} ${e.text}`).join(" / ")}
                              </div>
                            ) : null}
                            {s.columns?.length ? (
                              <div style={{ fontSize: 12, color: "var(--muted)", padding: "2px 0" }}>
                                对比：{s.columns.map((c) => c.name).join(" vs ")}
                              </div>
                            ) : null}
                            {s.source ? (
                              <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", padding: "2px 0" }}>
                                引用：{s.source}
                                {s.author ? `（${s.author}）` : ""}
                              </div>
                            ) : null}
                            {s.imageUrl || s.caption ? (
                              <div style={{ fontSize: 12, color: "var(--muted)", padding: "2px 0" }}>
                                图片卡：{s.caption || s.imageUrl}
                              </div>
                            ) : null}
                            {(s.emphasis && s.emphasis.length) || s.durationSec ? (
                              <div style={{ fontSize: 11, color: "var(--muted)", padding: "2px 0" }}>
                                节奏：{s.durationSec ? `约 ${s.durationSec}s` : ""}
                                {s.emphasis && s.emphasis.length ? ` · 强调：${s.emphasis.join("、")}` : ""}
                              </div>
                            ) : null}
                            {s.chart ? (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: "8px 10px",
                                  borderRadius: 8,
                                  background: "rgba(94,234,212,0.1)",
                                  border: "1px solid var(--line)",
                                }}
                              >
                                <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 4 }}>
                                  图表（{chartLabel(s.chart.kind)}
                                  {s.chart.unit ? ` · ${s.chart.unit}` : ""}）
                                </div>
                                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                                  {s.chart.labels.map((lab, ci) => (
                                    <span key={ci} style={{ marginRight: 10 }}>
                                      {lab}: <b style={{ color: "var(--text)" }}>{s.chart!.values[ci]}</b>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div
                            className="scene-edit"
                            style={{ padding: "10px 0", display: "flex", flexDirection: "column", gap: 10 }}
                          >
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                              <label className="field" style={{ flex: "1 1 140px" }}>
                                <span>类型</span>
                                <select
                                  value={s.type}
                                  onChange={(e) => {
                                    const t = e.target.value;
                                    const patch: Partial<Scene> = { type: t };
                                    if (t === "chart" && !s.chart) {
                                      patch.chart = { kind: "bar", labels: ["A", "B", "C"], values: [30, 50, 20] };
                                    }
                                    updateScene(i, patch);
                                  }}
                                >
                                  {Object.entries(TYPE_LABEL).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {v}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="field grow">
                                <span>标题（可换行）</span>
                                <textarea
                                  className="title-input"
                                  rows={1}
                                  value={s.title || ""}
                                  onChange={(e) => {
                                    updateScene(i, { title: e.target.value });
                                    autoGrow(e.currentTarget);
                                  }}
                                  onFocus={(e) => autoGrow(e.currentTarget)}
                                  placeholder="场景标题，可多行"
                                />
                              </label>
                              {s.type === "cover" && (
                                <label className="field" style={{ flex: "1 1 160px" }}>
                                  <span>眉标（栏目标签，可选）</span>
                                  <input
                                    value={s.kicker || ""}
                                    maxLength={8}
                                    placeholder="如：科技洞察"
                                    onChange={(e) => updateScene(i, { kicker: e.target.value })}
                                  />
                                </label>
                              )}
                            </div>

                            <label className="field">
                              <span title="本场景要念出来的口播文字；会用于配音和画面字幕">旁白（本场景口播）</span>
                              <textarea
                                rows={2}
                                value={s.narration || ""}
                                onChange={(e) => updateScene(i, { narration: e.target.value })}
                              />
                            </label>

                            {(s.type === "points" || s.type === "data") && (
                              <label className="field">
                                <span>要点（每行一条）</span>
                                <textarea
                                  rows={3}
                                  value={(s.points || []).join("\n")}
                                  onChange={(e) => setPoints(i, e.target.value)}
                                />
                              </label>
                            )}

                            {s.type === "image" && (
                              <div className="field">
                                <span>图片（上传本地图片，或填远程 URL）</span>
                                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    disabled={!!uploading[i]}
                                    onChange={(e) => {
                                      const f = e.target.files?.[0];
                                      if (f) handleImageUpload(i, f);
                                      e.target.value = "";
                                    }}
                                  />
                                  {uploading[i] ? (
                                    <span style={{ fontSize: 12, color: "var(--muted)" }}>上传中…</span>
                                  ) : null}
                                  {s.imageUrl ? (
                                    <img
                                      src={previewUrl(s.imageUrl)}
                                      alt=""
                                      style={{ maxHeight: 64, maxWidth: 120, borderRadius: 8, border: "1px solid var(--line)" }}
                                    />
                                  ) : null}
                                </div>
                                {s.imageUrl ? (
                                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, wordBreak: "break-all" }}>
                                    已用：{s.imageUrl}{" "}
                                    <button
                                      type="button"
                                      className="mini"
                                      onClick={() => updateScene(i, { imageUrl: "" })}
                                    >
                                      移除
                                    </button>
                                  </div>
                                ) : null}
                                <label className="field" style={{ marginTop: 6 }}>
                                  <span>或填写图片 URL（留空则用上方上传）</span>
                                  <input
                                    value={s.imageUrl || ""}
                                    onChange={(e) => updateScene(i, { imageUrl: e.target.value })}
                                    placeholder="https://…"
                                  />
                                </label>
                                <label className="field" style={{ marginTop: 6 }}>
                                  <span>说明文字</span>
                                  <input
                                    value={s.caption || ""}
                                    onChange={(e) => updateScene(i, { caption: e.target.value })}
                                  />
                                </label>
                                <label className="field" style={{ marginTop: 6 }}>
                                  <span>配图提示词（AI 生图 / AI 找图 共用，≤60 字）</span>
                                  <textarea
                                    rows={2}
                                    value={s.imagePrompt || ""}
                                    maxLength={120}
                                    placeholder="描述这张图应画什么，如：科技蓝紫渐变背景上的芯片与数据流"
                                    onChange={(e) => updateScene(i, { imagePrompt: e.target.value })}
                                  />
                                </label>

                                {/* P6：AI 生图（供应商聚合 image 模型）+ AI 找图（Pexels）双按钮 */}
                                <div className="img-gen-row" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                    <select
                                      value={imgVendor}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setImgVendor(v);
                                        const p = imgProviders.find((x) => x.vendor_id === v);
                                        if (p) setImgModel(p.default_model || "");
                                      }}
                                      style={{ flex: 1, minWidth: 130 }}
                                    >
                                      {imgProviders.length === 0 ? (
                                        <option value="">（未配置生图供应商）</option>
                                      ) : (
                                        imgProviders.map((p) => (
                                          <option key={p.vendor_id} value={p.vendor_id} disabled={p.status === "planned"}>
                                            {p.label}{p.status === "planned" ? "（待接入）" : ""}
                                          </option>
                                        ))
                                      )}
                                    </select>
                                    <input
                                      list="img-model-list"
                                      value={imgModel}
                                      onChange={(e) => setImgModel(e.target.value)}
                                      placeholder="模型名（可改）"
                                      style={{ flex: 1, minWidth: 130 }}
                                    />
                                    <datalist id="img-model-list">
                                      {imgProviders.find((x) => x.vendor_id === imgVendor)?.models?.map((m) => (
                                        <option key={m} value={m} />
                                      ))}
                                    </datalist>
                                  </div>
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                      type="button"
                                      className="btn primary"
                                      style={{ width: "auto", padding: "9px 16px" }}
                                      disabled={!!uploading[i]}
                                      onClick={() => handleAiGenerate(i)}
                                    >
                                      {uploading[i] ? "生成中…" : "AI 生图"}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn"
                                      style={{ width: "auto", padding: "9px 16px" }}
                                      disabled={imgSearching}
                                      onClick={() => handleAiFind(i, false)}
                                    >
                                      {imgSearching ? "搜索中…" : "AI 找图"}
                                    </button>
                                  </div>

                                  {/* Pexels 随机 6 张挑选；点一张即选用，点「换一批」再随机 6 张 */}
                                  {imgSearch.scene === i && imgSearch.photos.length > 0 ? (
                                    <div className="pexels-pick" style={{ marginTop: 4 }}>
                                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        {imgSearch.photos.map((p) => (
                                          <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => handlePickPhoto(i, p)}
                                            style={{ padding: 0, border: "2px solid var(--line)", borderRadius: 8, overflow: "hidden", cursor: "pointer", background: "#000" }}
                                          >
                                            <img
                                              src={p.thumb}
                                              alt={p.photographer}
                                              style={{ display: "block", width: 120, height: 80, objectFit: "cover" }}
                                            />
                                          </button>
                                        ))}
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                                        <button type="button" className="mini" onClick={() => handleAiFind(i, true)}>
                                          换一批
                                        </button>
                                        <span style={{ fontSize: 11, color: "var(--muted)" }}>点一张即选用并下载到本地</span>
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            )}

                            {s.type === "quote" && (
                              <label className="field">
                                <span>金句内容</span>
                                <textarea
                                  rows={2}
                                  value={s.quote || ""}
                                  onChange={(e) => updateScene(i, { quote: e.target.value })}
                                />
                              </label>
                            )}

                            {s.type === "timeline" && (
                              <div className="field">
                                <span>时间线节点</span>
                                {(s.events || []).map((ev, ei) => (
                                  <div key={ei} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                                    <input
                                      style={{ width: 120 }}
                                      value={ev.time || ""}
                                      placeholder="年份/节点"
                                      onChange={(e) => updateEvent(i, ei, { time: e.target.value })}
                                    />
                                    <input
                                      style={{ flex: 1 }}
                                      value={ev.text || ""}
                                      placeholder="事件"
                                      onChange={(e) => updateEvent(i, ei, { text: e.target.value })}
                                    />
                                    <button type="button" className="mini" onClick={() => removeEvent(i, ei)}>
                                      ×
                                    </button>
                                  </div>
                                ))}
                                <button type="button" className="mini" onClick={() => addEvent(i)}>
                                  + 添加节点
                                </button>
                              </div>
                            )}

                            {s.type === "compare" && (
                              <div className="field">
                                <span>对比列</span>
                                {(s.columns || []).map((col, ci) => (
                                  <div
                                    key={ci}
                                    style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginBottom: 8 }}
                                  >
                                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                                      <input
                                        style={{ flex: 1 }}
                                        value={col.name || ""}
                                        placeholder="列名（如 方案A）"
                                        onChange={(e) => updateColumn(i, ci, { name: e.target.value })}
                                      />
                                      <button type="button" className="mini" onClick={() => removeColumn(i, ci)}>
                                        ×
                                      </button>
                                    </div>
                                    <textarea
                                      rows={3}
                                      value={(col.items || []).join("\n")}
                                      placeholder="每行一条要点"
                                      onChange={(e) => setColumnItems(i, ci, e.target.value)}
                                    />
                                  </div>
                                ))}
                                <button type="button" className="mini" onClick={() => addColumn(i)}>
                                  + 添加一列
                                </button>
                              </div>
                            )}

                            {s.type === "cite" && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label className="field">
                                  <span>引用内容</span>
                                  <textarea
                                    rows={2}
                                    value={s.source || ""}
                                    onChange={(e) => updateScene(i, { source: e.target.value })}
                                  />
                                </label>
                                <label className="field">
                                  <span>出处 / 作者</span>
                                  <input
                                    value={s.author || ""}
                                    onChange={(e) => updateScene(i, { author: e.target.value })}
                                  />
                                </label>
                              </div>
                            )}

                            {s.type === "chart" && (
                              <div className="field">
                                <span>图表</span>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                                  <select
                                    value={chart.kind}
                                    onChange={(e) =>
                                      updateScene(i, {
                                        chart: { ...chart, kind: e.target.value },
                                      })
                                    }
                                  >
                                    {Object.keys(CHART_LABEL).map((k) => (
                                      <option key={k} value={k}>
                                        {CHART_LABEL[k]}
                                      </option>
                                    ))}
                                  </select>
                                  <input
                                    style={{ width: 120 }}
                                    value={chart.unit || ""}
                                    placeholder="单位"
                                    onChange={(e) =>
                                      updateScene(i, {
                                        chart: { ...chart, unit: e.target.value },
                                      })
                                    }
                                  />
                                </div>
                                <label className="field">
                                  <span>标签（逗号分隔）</span>
                                  <input
                                    value={chartRaw[chartRawKey(i, "labels")] ?? (s.chart?.labels || []).join(", ")}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setChartRaw((r) => ({ ...r, [chartRawKey(i, "labels")]: v }));
                                      setChartLabels(i, v);
                                    }}
                                    onBlur={() =>
                                      setChartRaw((r) => {
                                        const n = { ...r };
                                        delete n[chartRawKey(i, "labels")];
                                        return n;
                                      })
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>数值（逗号分隔，单系列）</span>
                                  <input
                                    value={chartRaw[chartRawKey(i, "values")] ?? (s.chart?.values || []).join(", ")}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setChartRaw((r) => ({ ...r, [chartRawKey(i, "values")]: v }));
                                      setChartValues(i, v);
                                    }}
                                    onBlur={() =>
                                      setChartRaw((r) => {
                                        const n = { ...r };
                                        delete n[chartRawKey(i, "values")];
                                        return n;
                                      })
                                    }
                                  />
                                </label>
                                <div style={{ marginTop: 4 }}>
                                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                                    多系列（可选）
                                  </div>
                                  {(s.chart?.series || []).map((ser, si) => (
                                    <div key={si} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                                      <input
                                        style={{ width: 120 }}
                                        value={ser.name || ""}
                                        placeholder="系列名"
                                        onChange={(e) => {
                                          const series = [...(s.chart!.series || [])];
                                          series[si] = { ...series[si], name: e.target.value };
                                          updateScene(i, {
                                            chart: { ...s.chart!, series },
                                          });
                                        }}
                                      />
                                      <input
                                        style={{ flex: 1 }}
                                        value={chartRaw[chartRawKey(i, "values", si)] ?? (ser.values || []).join(", ")}
                                        placeholder="数值逗号分隔"
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          setChartRaw((r) => ({ ...r, [chartRawKey(i, "values", si)]: v }));
                                          setSeriesValues(i, si, v);
                                        }}
                                        onBlur={() =>
                                          setChartRaw((r) => {
                                            const n = { ...r };
                                            delete n[chartRawKey(i, "values", si)];
                                            return n;
                                          })
                                        }
                                      />
                                      <button type="button" className="mini" onClick={() => removeSeries(i, si)}>
                                        ×
                                      </button>
                                    </div>
                                  ))}
                                  <button type="button" className="mini" onClick={() => addSeries(i)}>
                                    + 添加系列
                                  </button>
                                </div>
                              </div>
                            )}

                            <details className="style-box">
                              <summary style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
                                样式参数（颜色 / 字号 / 版式 / 动效）
                              </summary>
                              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                                <label className="field" style={{ width: 130 }}>
                                  <span>场景主色</span>
                                  <input
                                    type="color"
                                    value={s.color1 || color1}
                                    onChange={(e) => updateScene(i, { color1: e.target.value })}
                                  />
                                </label>
                                <label className="field" style={{ width: 130 }}>
                                  <span>场景辅色</span>
                                  <input
                                    type="color"
                                    value={s.color2 || color2}
                                    onChange={(e) => updateScene(i, { color2: e.target.value })}
                                  />
                                </label>
                                <label className="field" style={{ width: 120 }}>
                                  <span>字号缩放</span>
                                  <input
                                    type="number"
                                    step="0.05"
                                    min="0.4"
                                    max="1.6"
                                    value={s.fontScale || 1}
                                    onChange={(e) =>
                                      updateScene(i, { fontScale: parseFloat(e.target.value) || 0 })
                                    }
                                  />
                                </label>
                                <label className="field" style={{ width: 120 }}>
                                  <span>标题字号</span>
                                  <input
                                    type="number"
                                    step="0.05"
                                    min="0.5"
                                    max="1.6"
                                    value={s.titleScale || 1}
                                    onChange={(e) =>
                                      updateScene(i, { titleScale: parseFloat(e.target.value) || 0 })
                                    }
                                  />
                                </label>
                                <label className="field" style={{ width: 120 }}>
                                  <span>版式</span>
                                  <select
                                    value={s.layout || "center"}
                                    onChange={(e) => updateScene(i, { layout: e.target.value })}
                                  >
                                    {["center", "left", "split"].map((l) => (
                                      <option key={l} value={l}>
                                        {l}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="field" style={{ width: 120 }}>
                                  <span>动效</span>
                                  <select
                                    value={s.animation || "fade"}
                                    onChange={(e) => updateScene(i, { animation: e.target.value })}
                                  >
                                    {["fade", "slide", "zoom", "none"].map((a) => (
                                      <option key={a} value={a}>
                                        {a}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            </details>

                            <div style={{ display: "flex", gap: 10 }}>
                              <button type="button" className="mini" onClick={() => setEditingIdx(null)}>
                                完成
                              </button>
                              <button
                                type="button"
                                className="mini danger"
                                onClick={() => {
                                  setScenes((prev) => prev.filter((_, k) => k !== i));
                                  setEditingIdx(null);
                                }}
                              >
                                删除场景
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          ) : (
            <AgentPanel
              plan={currentPlan}
              language={language}
              sceneCount={sceneCount}
              voiceName={voiceName}
              onApply={applyAgentPlan}
              messages={agentMessages}
              onMessagesChange={setAgentMessages}
            />
          )}
          </div>
        </aside>

        <main className="tv-stage">
          <div className="player-wrap">
            <Player
              key={`${aspect}-${bgTheme}`}
              ref={playerRef}
              component={PlanVideo}
              inputProps={inputProps}
              durationInFrames={durationInFrames}
              fps={FPS}
              compositionWidth={pw}
              compositionHeight={ph}
              style={{ width: "100%" }}
              controls
              loop
            />
          </div>

          <div className="tv-actions">
            <div className="bg-switch">
              <span className="bg-switch-label">背景</span>
              <button
                type="button"
                className={`seg${bgTheme === "dark" ? " active" : ""}`}
                onClick={() => setBgTheme("dark")}
              >
                黑底
              </button>
              <button
                type="button"
                className={`seg${bgTheme === "light" ? " active" : ""}`}
                onClick={() => setBgTheme("light")}
              >
                白底
              </button>
            </div>
            <button
              className="btn primary"
              onClick={exportVideo}
              disabled={exporting}
            >
              {exporting ? "渲染中…" : "渲染视频"}
            </button>
            {exporting && (
              <div className="progress">
                <div className="bar" style={{ width: `${progress}%` }} />
              </div>
            )}
            {message && <p className="msg ok">{message}</p>}
            {error && <pre className="msg err">{error}</pre>}
          </div>

          <p className="hint">
            预览 {pw}×{ph} / 30fps，导出 MP4 与此一致{autoMode ? (personVideo ? `（自动视频：整体时长=${personDurationSec > 0 ? personDurationSec.toFixed(1) + "s" : "素材时长"}，与口播素材一致，不裁剪；图文按时长铺满）` : "（自动视频：口播素材与图文交叉合成，使用口播原声）") : ""}。表单模式可手动调整；
            切到「AGENT 对话」用自然语言生成与反复修改，直到满意再渲染。
          </p>
        </main>
      </div>
    </div>
    </>
  );
}

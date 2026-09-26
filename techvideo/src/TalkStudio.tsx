import { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { PlanVideo } from "./PlanVideo";
import SceneEditor from "./SceneEditor";
import Timeline from "./Timeline";
import { LIBRARY_ASSETS, ASSET_DEFAULTS } from "./sceneAssets";

const FPS = 30;

type S = any;

const blankScene = (over: any = {}): any => ({
  type: "title",
  title: "",
  kicker: "",
  points: [],
  narration: "",
  caption: "",
  imageUrl: "",
  quote: "",
  durationFrames: 90,
  animation: "fade",
  layout: "center",
  ...over,
});

// 章节模板：对应 Overlay Studio 的开场/痛点/方案/用法/好处/结尾 标准结构
const TEMPLATES: Record<string, any> = {
  开场钩子: { type: "title", kicker: "开场", title: "你还在这样吗？", points: [], durationFrames: 90 },
  痛点: { type: "points", kicker: "痛点", title: "你是不是也遇到", points: ["问题一", "问题二", "问题三"], durationFrames: 90 },
  方案: { type: "points", kicker: "方案", title: "正确做法是", points: ["要点一", "要点二"], durationFrames: 90 },
  用法: { type: "points", kicker: "用法", title: "三步搞定", points: ["第一步", "第二步", "第三步"], durationFrames: 90 },
  好处: { type: "points", kicker: "好处", title: "用了之后", points: ["好处一", "好处二"], durationFrames: 90 },
  金句: { type: "quote", kicker: "", title: "", quote: "一句话记住它", durationFrames: 75 },
  结尾: { type: "title", kicker: "结尾", title: "关注我，下期见", points: [], durationFrames: 75 },
};

// 经典配色预设（复用自动视频主入口的配色体系）：点击方案名同时设定主色 + 辅色
const COLOR_PRESETS: { name: string; c1: string; c2: string }[] = [
  { name: "青蓝默认", c1: "#5eead4", c2: "#8aa2ff" },
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

const STANDARD = ["开场钩子", "痛点", "方案", "用法", "好处", "结尾"];
const PROJECT_KEY = "talk_studio_project_v1";

export default function TalkStudio() {
  const [scenes, setScenes] = useState<S[]>([]);
  const [color1, setColor1] = useState("#5eead4");
  const [color2, setColor2] = useState("#8aa2ff");
  // 自定义配色模式：下拉选「自定义」或当前颜色不在任何预设时，展开色盘自由调色
  const [customMode, setCustomMode] = useState(false);
  const [bgTheme, setBgTheme] = useState<"dark" | "light">("dark");
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [transition, setTransition] = useState("fade");
  const [videoLayout, setVideoLayout] = useState<"cross-cut" | "underlay" | "pip">("underlay");
  const [showSubtitle, setShowSubtitle] = useState(true);
  const [showNarration, setShowNarration] = useState(true);
  // 导出模式：full=完整成片（口播视频+素材合成 MP4）；transparent=仅素材层（MOV ProRes 4444）
  const [exportMode, setExportMode] = useState<"full" | "transparent">("full");
  const [videoDim, setVideoDim] = useState(0); // underlay 视频压暗 0-90%（0=原亮度直出，所见即所得）
  // 画中画小窗参数：大小=边长占宽 %；位置=九宫格（预览与导出一致）
  const [pipSize, setPipSize] = useState(32);
  const [pipPos, setPipPos] = useState("br");
  const [personVideo, setPersonVideo] = useState("");
  const [personVideoDuration, setPersonVideoDuration] = useState(0); // 上传素材真实时长（秒）
  const [personUploading, setPersonUploading] = useState(false);
  const [personProgress, setPersonProgress] = useState(0);
  const [selected, setSelected] = useState(0);
  const [staticReview, setStaticReview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");
  const playerRef = useRef<PlayerRef>(null);
  const projRef = useRef<HTMLInputElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // P4：时间线结构操作（增删/排序/改时长/插入素材）的撤销/重做历史。
  // 快照为 scenes 的浅拷贝（编辑均走不可变更新，嵌套数组每次重建，浅拷贝足够安全）。
  const past = useRef<any[][]>([]);
  const future = useRef<any[][]>([]);
  const lastPush = useRef<{ t: number; key: string }>({ t: 0, key: "" });
  const [histTick, setHistTick] = useState(0);

  // 派生：导出模式是否为透明叠加层（渲染链路沿用 transparent 语义）。
  const transparent = exportMode === "transparent";

  // 初始化：优先恢复本地工程，否则载入标准开场结构
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (raw) {
        applyProject(JSON.parse(raw));
        setSavedAt(new Date().toLocaleString());
        return;
      }
    } catch {}
    setScenes(STANDARD.map((k) => blankScene({ ...TEMPLATES[k] })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动保存（JSON 态，近乎免费）
  useEffect(() => {
    if (!scenes.length) return;
    localStorage.setItem(PROJECT_KEY, JSON.stringify(serialize()));
    setSavedAt(new Date().toLocaleTimeString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, color1, color2, bgTheme, aspect, transition, videoLayout, showSubtitle, showNarration, exportMode, videoDim, pipSize, pipPos, personVideo, personVideoDuration]);

  // 同步浏览器全屏状态（用户按 Esc 退出时也要恢复侧边栏）
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement;
      setFullscreen(on);
      try {
        window.parent.postMessage({ type: "tv-fullscreen-toggle", on }, "*");
      } catch {}
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const durations = useMemo(
    () => scenes.map((s: S) => Math.max(30, Math.round(s.durationFrames || 90))),
    [scenes],
  );
  const starts = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const d of durations) {
      out.push(acc);
      acc += d;
    }
    return out;
  }, [durations]);
  const total = useMemo(() => durations.reduce((a, b) => a + b, 0), [durations]);
  // 播放器/导出总时长：挂载口播素材且读到时长时，覆盖视频全长（素材是节奏主体）。
  const playerDur = personVideoDuration > 0 ? Math.max(total, Math.round(personVideoDuration * FPS)) : total;
  const dims = aspect === "9:16" ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };

  function serialize() {
    return {
      app: "talk-studio",
      version: 1,
      color1,
      color2,
      bgTheme,
      aspect,
      transition,
      videoLayout,
      showSubtitle,
      showNarration,
      exportMode,
      videoDim,
      pipSize,
      pipPos,
      personVideo,
      personVideoDuration,
      scenes,
      savedAt: Date.now(),
    };
  }
  function applyProject(p: any) {
    if (!p) return;
    if (Array.isArray(p.scenes)) setScenes(p.scenes);
    if (p.color1) setColor1(p.color1);
    if (p.color2) setColor2(p.color2);
    if (p.bgTheme) setBgTheme(p.bgTheme);
    if (p.aspect) setAspect(p.aspect);
    if (p.transition) setTransition(p.transition);
    if (p.videoLayout) setVideoLayout(p.videoLayout);
    if (typeof p.showSubtitle === "boolean") setShowSubtitle(p.showSubtitle);
    if (typeof p.showNarration === "boolean") setShowNarration(p.showNarration);
    // 兼容旧工程：无 exportMode 时回退读 transparent 布尔
    if (p.exportMode === "full" || p.exportMode === "transparent") setExportMode(p.exportMode);
    else if (typeof p.transparent === "boolean") setExportMode(p.transparent ? "transparent" : "full");
    if (typeof p.videoDim === "number") setVideoDim(Math.max(0, Math.min(90, p.videoDim)));
    if (typeof p.pipSize === "number") setPipSize(Math.max(8, Math.min(80, p.pipSize)));
    if (p.pipPos) setPipPos(p.pipPos);
    if (p.personVideo) setPersonVideo(p.personVideo);
    if (typeof p.personVideoDuration === "number") setPersonVideoDuration(p.personVideoDuration);
  }

  function updateScene(i: number, patch: any) {
    setScenes((prev) => prev.map((s: S, idx: number) => (idx === i ? { ...s, ...patch } : s)));
  }
  function setPoints(i: number, text: string) {
    updateScene(i, { points: text.split("\n").map((x) => x.trim()).filter(Boolean) });
  }
  function addScene() {
    pushHistory();
    const at = Math.min(selected + 1, scenes.length);
    const ns = [...scenes];
    ns.splice(at, 0, blankScene({ type: "points", title: "新场景", points: ["要点"] }));
    setScenes(ns);
    setSelected(at);
  }
  function removeScene(i: number) {
    if (scenes.length <= 1) return;
    pushHistory();
    setScenes((prev) => prev.filter((_, idx) => idx !== i));
    setSelected((s) => Math.max(0, Math.min(s, scenes.length - 2)));
  }
  function moveScene(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= scenes.length) return;
    pushHistory();
    const ns = [...scenes];
    [ns[i], ns[j]] = [ns[j], ns[i]];
    setScenes(ns);
    setSelected(j);
  }
  function insertChapter(kind: string) {
    const t = TEMPLATES[kind];
    if (!t) return;
    pushHistory();
    const at = Math.min(selected + 1, scenes.length);
    const ns = [...scenes];
    ns.splice(at, 0, blankScene({ ...t }));
    setScenes(ns);
    setSelected(at);
  }
  function insertStandard() {
    pushHistory();
    setScenes((prev) => [...prev, ...STANDARD.map((k) => blankScene({ ...TEMPLATES[k] }))]);
  }
  // 从「动画素材库」一键插入一个带示例内容的场景（可在右侧属性面板继续改）。
  function insertAsset(type: string) {
    pushHistory();
    const at = Math.min(selected + 1, scenes.length);
    const ns = [...scenes];
    ns.splice(at, 0, blankScene({ ...(ASSET_DEFAULTS[type] || {}), type }));
    setScenes(ns);
    setSelected(at);
  }

  // —— P4 撤销/重做 ——
  function snapshotScenes() {
    return scenes.map((s: S) => ({ ...s }));
  }
  function pushHistory(key?: string) {
    const now = Date.now();
    // 拖拽改时长等高频操作：同一 key 在 700ms 内只记一次快照，避免污染历史栈。
    if (key && lastPush.current.key === key && now - lastPush.current.t < 700) {
      lastPush.current.t = now;
      return;
    }
    past.current.push(snapshotScenes());
    if (past.current.length > 120) past.current.shift();
    future.current = [];
    lastPush.current = { t: now, key: key || "" };
    setHistTick((t) => t + 1);
  }
  function undo() {
    if (!past.current.length) return;
    future.current.push(snapshotScenes());
    const prev = past.current.pop()!;
    setScenes(prev);
    setSelected((s) => Math.max(0, Math.min(s, prev.length - 1)));
    lastPush.current = { t: 0, key: "" };
    setHistTick((t) => t + 1);
  }
  function redo() {
    if (!future.current.length) return;
    past.current.push(snapshotScenes());
    const next = future.current.pop()!;
    setScenes(next);
    setSelected((s) => Math.max(0, Math.min(s, next.length - 1)));
    setHistTick((t) => t + 1);
  }
  // 键盘：Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl/⌘+Y 重做（输入框内不劫持文本撤销）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— <Timeline> 回调：擦洗 / 选中 / 排序 / 改时长 ——
  function seekToFrame(f: number) {
    try {
      playerRef.current?.seekTo(Math.max(0, Math.min(playerDur - 1, f)));
      playerRef.current?.pause();
    } catch {}
  }
  function tlReorder(from: number, to: number) {
    pushHistory();
    setScenes((prev) => {
      const ns = [...prev];
      const [m] = ns.splice(from, 1);
      ns.splice(to, 0, m);
      return ns;
    });
    setSelected(to);
  }
  function tlResize(i: number, durFrames: number) {
    pushHistory(`resize:${i}`);
    setScenes((prev) => prev.map((s: S, idx: number) => (idx === i ? { ...s, durationFrames: durFrames } : s)));
  }

  function seekToScene(i: number) {
    setSelected(i);
    const f = starts[i] ?? 0;
    try {
      playerRef.current?.seekTo(f);
      playerRef.current?.pause();
    } catch {}
  }

  // 时间线播放头已迁移到 <Timeline> 内部（rAF 直写 DOM）。

  async function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    try {
      window.parent.postMessage({ type: "tv-fullscreen-toggle", on: next }, "*");
    } catch {}
    try {
      if (next) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {}
  }

  // v1.9.4：通用上传函数，供「全局口播素材」和「本场景视频」复用。
  // onProgress 回传 0-100 进度；成功返回后端给的相对 URL（如 uploads/xxx.mp4）。
  function uploadVideoFile(
    file: File,
    onProgress: (p: number) => void,
  ): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/techvideo/upload");
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const data: any = JSON.parse(xhr.responseText);
          if (data.status !== 200 || !data.data?.url) throw new Error(data.message || "上传失败");
          onProgress(100);
          resolve(data.data.url);
        } catch {
          reject(new Error("响应解析失败"));
        }
      };
      xhr.onerror = () => reject(new Error("网络错误，上传失败"));
      xhr.send(fd);
    });
  }

  async function handleVideoUpload(file: File) {
    setPersonUploading(true);
    setPersonProgress(0);
    try {
      const url = await uploadVideoFile(file, setPersonProgress);
      setPersonVideo(url);
      // 读取素材真实时长：预览/导出总时长对齐视频全长（pvd>0 时视频不循环、播完定格）。
      try {
        const probe = document.createElement("video");
        probe.preload = "metadata";
        probe.src = `/techvideo-public/${url}`;
        probe.onloadedmetadata = () => {
          const d = Number.isFinite(probe.duration) ? probe.duration : 0;
          setPersonVideoDuration(d);
          setMessage(
            d > 0
              ? `口播素材已上传（${d.toFixed(1)}s），完整成片模式将直接带视频输出。`
              : "口播素材已上传。",
          );
        };
        probe.onerror = () => setMessage("口播素材已上传（时长读取失败，以场景时长为准）。");
      } catch {
        setMessage("口播素材已上传。");
      }
    } catch (e) {
      setError((e as Error).message);
      setPersonProgress(0);
    } finally {
      setPersonUploading(false);
    }
  }

  // v1.9.4：本场景视频上传（供 SceneEditor 的「本场景视频」区调用）。
  async function handleSceneVideoUpload(file: File): Promise<string> {
    const prog = (p: number) => {
      // 复用 personProgress 之外的独立状态会触发额外 rerender，这里直接 toast 进度。
      if (p < 100) setMessage(`本场景视频上传中 ${p}%`);
    };
    return uploadVideoFile(file, prog);
  }

  // 场景时长按比例缩放至视频全长（各场景保持相对节奏，总和≈素材时长）。
  function fitScenesToVideo() {
    if (!personVideoDuration || !scenes.length) return;
    pushHistory();
    const target = Math.max(30, Math.round(personVideoDuration * FPS));
    const cur = total || 1;
    setScenes((prev) =>
      prev.map((s: S) => {
        const d = Math.max(30, Math.round(s.durationFrames || 90));
        return { ...s, durationFrames: Math.max(30, Math.round((d * target) / cur)) };
      }),
    );
    setMessage(`场景时长已按视频 ${personVideoDuration.toFixed(1)}s 适配。`);
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `口播工程_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function importProject(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        applyProject(JSON.parse(String(r.result)));
        setMessage("工程已导入。");
      } catch {
        setError("工程文件解析失败");
      }
    };
    r.readAsText(file);
  }
  function clearProject() {
    if (!confirm("清空当前工程并恢复标准开场结构？")) return;
    pushHistory();
    localStorage.removeItem(PROJECT_KEY);
    setScenes(STANDARD.map((k) => blankScene({ ...TEMPLATES[k] })));
    setPersonVideo("");
    setPersonVideoDuration(0);
    setVideoDim(0);
    setExportMode("full");
    setMessage("已清空，恢复标准结构。");
  }

  async function render() {
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/techvideo/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          color1,
          color2,
          audio_url: "",
          scenes,
          bg_theme: bgTheme,
          watermark: "",
          person_video: personVideo,
          video_layout: videoLayout,
          aspect,
          transition,
          show_subtitle: showSubtitle,
          show_narration: showNarration,
          transparent,
          video_dim: videoDim,
          pip_size: pipSize,
          pip_pos: pipPos,
          audio_mode: "footage",
          person_video_duration: personVideoDuration,
          save_to_assets: true,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `渲染失败 (HTTP ${res.status})`);
      }
      // 后端返回 JSON（已自动归档进资产管理）：{ download_url, filename, asset }；
      // 兼容旧路径仍返回二进制成片。
      const ct = res.headers.get("content-type") || "";
      let blob: Blob;
      let assetName = "";
      if (ct.includes("application/json")) {
        const data = await res.json();
        const payload = (data && data.data) ? data.data : data;
        assetName = payload?.asset?.name || "";
        const dlRes = await fetch(payload?.download_url || "");
        blob = await dlRes.blob();
      } else {
        blob = new Blob([await res.arrayBuffer()], {
          type: transparent ? "video/quicktime" : "video/mp4",
        });
      }
      // 触发浏览器下载（透明底为 MOV/ProRes 4444，否则 MP4），便于直接进剪映合成。
      const ext = transparent ? "mov" : "mp4";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `koubo_${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      try {
        window.parent.postMessage({ type: "techvideo-render-complete" }, "*");
      } catch {}
      setMessage(
        assetName
          ? "已生成，成片已下载并存入资产管理（分类：口播成片）。"
          : (transparent
              ? "已生成透明底叠加层（MOV / ProRes 4444），已开始下载。"
              : "已生成，成片已开始下载。"),
      );
    } catch (e) {
      setError(
        (e as Error).message +
          "\n（若后端未启动，可在 techvideo 目录执行 npm run render 离线渲染）",
      );
    } finally {
      setExporting(false);
    }
  }

  const sel = scenes[selected] || blankScene();
  // histTick 参与运算仅为了让「撤销/重做」按钮的禁用态随历史栈变化重算（值恒真，不改逻辑）。
  const canUndo = histTick >= 0 && past.current.length > 0;
  const canRedo = histTick >= 0 && future.current.length > 0;

  return (
    <div className="ts">
      {/* 顶栏工具栏 */}
      <div className="ts-toolbar">
        <div className="ts-brand">
          <span className="ts-brand-name">口播视频工作台</span>
          <span className="ts-brand-meta">{scenes.length} 场景 · 总时长 {(playerDur / FPS).toFixed(1)}s</span>
        </div>
        <div className="ts-row">
          <button className="ts-btn" onClick={toggleFullscreen}>
            {fullscreen ? "⤡ 退出全屏" : "⛶ 全屏"}
          </button>
        </div>
      </div>

      {/* 左面板：全局样式 / 工程文件 / 章节模板 / 口播素材 */}
      <aside className="ts-left ts-panel">
        <div className="ts-sec">
          <h4>工程文件</h4>
          <div className="ts-row">
            <button className="ts-btn" onClick={exportProject}>导出工程</button>
            <button className="ts-btn" onClick={() => projRef.current?.click()}>导入工程</button>
            <button className="ts-btn danger" onClick={clearProject}>清空</button>
          </div>
          <input
            ref={projRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) importProject(e.target.files[0]);
              e.target.value = "";
            }}
          />
          <p className="ts-hint">本地自动保存：{savedAt || "—"}</p>
        </div>

        <div className="ts-sec">
          <h4>全局样式</h4>
          {(() => {
            const activeName = COLOR_PRESETS.find(
              (p) => p.c1 === color1 && p.c2 === color2
            )?.name || "";
            const showPickers = customMode || activeName === "";
            return (
              <>
                <label className="ts-field"><span>主色 / 辅色配色方案</span>
                  <select
                    value={customMode ? "" : activeName}
                    onChange={(e) => {
                      const p = COLOR_PRESETS.find((x) => x.name === e.target.value);
                      if (p) {
                        setColor1(p.c1);
                        setColor2(p.c2);
                        setCustomMode(false);
                      } else {
                        setCustomMode(true);
                      }
                    }}
                  >
                    <option value="">自定义</option>
                    {COLOR_PRESETS.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}  {p.c1} / {p.c2}
                      </option>
                    ))}
                  </select>
                </label>
                {showPickers && (
                  <div className="ts-row">
                    <label className="ts-color">主色<input type="color" value={color1} onChange={(e) => setColor1(e.target.value)} /></label>
                    <label className="ts-color">辅色<input type="color" value={color2} onChange={(e) => setColor2(e.target.value)} /></label>
                  </div>
                )}
                <div className="ts-row" style={{ gap: 12 }}>
                  <div className="ts-color-swatch">
                    <span>主色</span>
                    <span className="ts-dot" style={{ background: color1 }} />
                    <code>{color1}</code>
                  </div>
                  <div className="ts-color-swatch">
                    <span>辅色</span>
                    <span className="ts-dot" style={{ background: color2 }} />
                    <code>{color2}</code>
                  </div>
                </div>
              </>
            );
          })()}
          <label className="ts-field"><span>背景主题</span>
            <select value={bgTheme} onChange={(e) => setBgTheme(e.target.value as any)}>
              <option value="dark">暗色</option>
              <option value="light">亮色</option>
            </select></label>
          <label className="ts-field"><span>画幅</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value as any)}>
              <option value="9:16">竖屏 9:16</option>
              <option value="16:9">横屏 16:9</option>
            </select></label>
          <label className="ts-field"><span>全局转场</span>
            <select value={transition} onChange={(e) => setTransition(e.target.value)}>
              <option value="fade">淡入</option>
              <option value="slide">滑动</option>
              <option value="zoom">缩放</option>
              <option value="blur">模糊</option>
              <option value="wipe">擦除</option>
              <option value="flip">翻转 3D</option>
              <option value="iris">圆形展开</option>
              <option value="none">无</option>
            </select></label>
          <label className="ts-field"><span>口播叠加</span>
            <select value={videoLayout} onChange={(e) => setVideoLayout(e.target.value as any)}>
              <option value="underlay">底片混排</option>
              <option value="cross-cut">硬切交替</option>
              <option value="pip">画中画</option>
            </select></label>
          <label className="ts-field"><span>导出模式</span>
            <select value={exportMode} onChange={(e) => setExportMode(e.target.value as any)}>
              <option value="full">完整成片（含口播视频）</option>
              <option value="transparent">透明叠加层（MOV）</option>
            </select></label>
          {videoLayout === "underlay" && !transparent && (
            <label className="ts-field"><span>视频压暗 {videoDim}%</span>
              <input
                className="ts-range"
                type="range"
                min={0}
                max={90}
                step={5}
                value={videoDim}
                onChange={(e) => setVideoDim(Number(e.target.value))}
              />
            </label>
          )}
          {/* 画中画参数：全局为 pip 或任一场景单独设为 pip 时显示（预览与导出一致） */}
          {(videoLayout === "pip" || scenes.some((s: any) => s.videoLayout === "pip")) && (
            <>
              <label className="ts-field"><span>画中画大小 {pipSize}%</span>
                <input
                  className="ts-range"
                  type="range"
                  min={10}
                  max={70}
                  step={2}
                  value={pipSize}
                  onChange={(e) => setPipSize(Number(e.target.value))}
                />
              </label>
              <label className="ts-field"><span>画中画位置</span>
                <select value={pipPos} onChange={(e) => setPipPos(e.target.value)}>
                  <option value="tl">左上</option>
                  <option value="tc">上中</option>
                  <option value="tr">右上</option>
                  <option value="ml">左中</option>
                  <option value="center">居中</option>
                  <option value="mr">右中</option>
                  <option value="bl">左下</option>
                  <option value="bc">下中</option>
                  <option value="br">右下</option>
                </select></label>
            </>
          )}
          <div className="ts-row">
            <label className="ts-check"><input type="checkbox" checked={showSubtitle} onChange={(e) => setShowSubtitle(e.target.checked)} /> 字幕</label>
            <label className="ts-check"><input type="checkbox" checked={showNarration} onChange={(e) => setShowNarration(e.target.checked)} /> 旁白</label>
          </div>
          {transparent ? (
            <p className="ts-hint">透明叠加层：预览中视频作参照（原亮度），导出仅含素材层（MOV / ProRes 4444），进剪映叠在底片上。</p>
          ) : personVideo ? (
            <p className="ts-hint">完整成片：口播视频 + 素材合成一个 MP4（视频原声），预览所见即导出所得。</p>
          ) : null}
        </div>

        <div className="ts-sec">
          <h4>口播素材</h4>
          <>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => {
                if (e.target.files?.[0]) handleVideoUpload(e.target.files[0]);
                e.target.value = "";
              }}
            />
            {personUploading && (
              <div className="ts-prog"><div className="ts-prog-bar" style={{ width: personProgress + "%" }} /></div>
            )}
            {personVideo && (
              <p className="ts-hint">已挂载：{personVideo.split("/").pop()}{personVideoDuration > 0 ? ` · ${personVideoDuration.toFixed(1)}s` : ""}</p>
            )}
            {personVideo && personVideoDuration > 0 && Math.abs(personVideoDuration - total / FPS) > 0.5 && (
              <button className="ts-btn" onClick={fitScenesToVideo}>
                场景时长适配视频（{personVideoDuration.toFixed(1)}s）
              </button>
            )}
            {transparent && personVideo && (
              <p className="ts-hint">透明叠加层模式：视频仅作预览参照（原亮度），导出不包含视频层。</p>
            )}
            {!transparent && personVideo && personVideoDuration > 0 && (
              <p className="ts-hint">完整成片模式：视频以原亮度直接烘焙进成片，可用「视频压暗」提高文字可读性。</p>
            )}
          </>
        </div>

        <div className="ts-sec">
          <h4>章节模板</h4>
          <div className="ts-tags">
            {Object.keys(TEMPLATES).map((k) => (
              <button key={k} className="ts-tag" onClick={() => insertChapter(k)}>{k}</button>
            ))}
          </div>
          <button className="ts-btn primary" onClick={insertStandard}>插入标准结构（开场→结尾）</button>
        </div>

        <div className="ts-sec">
          <h4>动画素材库</h4>
          <p className="ts-hint" style={{ marginTop: 0 }}>点击插入一个带动画的场景（含示例内容），再到右侧属性面板改文字/数值。</p>
          <div className="ts-tags">
            {LIBRARY_ASSETS.map((a) => (
              <button
                key={a.type}
                className="ts-tag"
                title={a.hint}
                onClick={() => insertAsset(a.type)}
              >
                {a.emoji} {a.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 中：预览 + 章节标签 + 静态审阅 */}
      <section className="ts-center">
        <div className="ts-bar">
          <div className="ts-tabs">
            {scenes.map((s: S, i: number) => (
              <button key={i} className={`ts-tab${i === selected ? " active" : ""}`} onClick={() => seekToScene(i)}>
                {s.kicker || s.title || `场景${i + 1}`}
              </button>
            ))}
          </div>
          <label className="ts-check"><input type="checkbox" checked={staticReview} onChange={(e) => setStaticReview(e.target.checked)} /> 静态审阅</label>
        </div>
        <div className="ts-player">
          {scenes.length > 0 ? (
            <Player
              ref={playerRef}
              component={PlanVideo}
              durationInFrames={playerDur || 30}
              fps={FPS}
              compositionWidth={dims.w}
              compositionHeight={dims.h}
              inputProps={{
                color1,
                color2,
                audioSrc: "",
                scenes,
                bgTheme,
                watermark: "",
                personVideo,
                personVideoDuration,
                videoLayout,
                aspect,
                transition,
                showSubtitle,
                showNarration,
                transparent,
                videoDim,
                pipSize,
                pipPos,
              }}
              style={{ width: "100%", height: "100%" }}
              controls
            />
          ) : (
            <div className="ts-empty">
              <div className="ts-empty-title">暂无场景</div>
              <div className="ts-empty-hint">点击「插入标准结构」或左侧章节模板开始搭建分镜。</div>
            </div>
          )}
        </div>
        {staticReview && (
          <div className="ts-strip">
            {scenes.map((s: S, i: number) => (
              <button key={i} className={`ts-frame${i === selected ? " active" : ""}`} onClick={() => seekToScene(i)}>
                <span className="ts-frame-idx">{i + 1}</span>
                <span className="ts-frame-k">{s.kicker || "—"}</span>
                <span className="ts-frame-t">{s.title || s.quote || "（空）"}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 右：场景属性 + 效果库 */}
      <aside className="ts-right ts-panel">
        <div className="ts-sec">
          <h4>场景属性 #{selected + 1}</h4>
          <SceneEditor
            scene={sel}
            index={selected}
            onChange={(patch) => updateScene(selected, patch)}
            globalPipSize={pipSize}
            globalPipPos={pipPos}
            onUploadSceneVideo={handleSceneVideoUpload}
          />
        </div>
        <div className="ts-sec">
          <div className="ts-row">
            <button className="ts-btn" onClick={() => moveScene(selected, -1)}>↑ 上移</button>
            <button className="ts-btn" onClick={() => moveScene(selected, 1)}>↓ 下移</button>
            <button className="ts-btn danger" onClick={() => removeScene(selected)}>删除</button>
          </div>
          <button className="ts-btn" onClick={addScene}>＋ 插入场景</button>
        </div>
      </aside>

      {/* 下：RVE 式可视化时间轴 */}
      <div className="ts-timeline ts-panel">
        <div className="ts-tl-head">
          <span>时间线（拖动排序 · 拖右边缘改时长 · 点/拖标尺擦洗）</span>
          <div className="ts-row">
            <button className="ts-btn" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl/⌘+Z)">↶ 撤销</button>
            <button className="ts-btn" onClick={redo} disabled={!canRedo} title="重做 (Ctrl/⌘+Shift+Z)">↷ 重做</button>
            <button className="ts-btn primary" onClick={render} disabled={exporting}>
              {exporting ? "渲染中…" : "⤓ 导出成片"}
            </button>
          </div>
        </div>
        <Timeline
          scenes={scenes}
          fps={FPS}
          durations={durations}
          starts={starts}
          total={total}
          playerDur={playerDur}
          selected={selected}
          getFrame={() => {
            try {
              return playerRef.current?.getCurrentFrame() ?? 0;
            } catch {
              return 0;
            }
          }}
          onSelect={(i) => seekToScene(i)}
          onSeekFrame={seekToFrame}
          onReorder={tlReorder}
          onResize={tlResize}
        />
      </div>

      {message && <div className="ts-toast ok">{message}</div>}
      {error && <div className="ts-toast err">{error}</div>}
    </div>
  );
}

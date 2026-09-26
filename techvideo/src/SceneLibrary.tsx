// 素材库动画构件（Remotion 社区经典、纯 spring/interpolate 实现）
// ————————————————————————————————————————————————
// 这里放「新增素材」的渲染组件，由 PlanVideo 的 SceneView 按 scene.type 分派进来。
// 约定：每个组件只负责 AbsoluteFill 内的内容块（外层容器、转场、进度点、字幕由 SceneView 统一处理），
// 与既有 ImageCard/QuoteCard 等内置卡片保持一致的入参（scene/c1/c2/P/fs）。
// 依赖：仅 react + remotion 核心，无新增 npm 包 —— 预览(Player) 与离线渲染(/render) 必然一致。

import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Palette = {
  bg: string;
  title: string;
  body: string;
  value: string;
  label: string;
  dot: string;
  subBg: string;
  subText: string;
  pieStroke: string;
};

export type LibProps = {
  scene: any;
  c1: string;
  c2: string;
  P: Palette;
  fs: (n: number) => number;
  align?: "flex-start" | "center" | "flex-end";
  textAlign?: "left" | "center" | "right";
  imgSrc?: string; // kb 用：已解析的图片地址（由 SceneView 传 resolveMediaSrc 结果，避免循环依赖）
};

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const TITLE_FONT =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function useLocal() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { frame, fps, t: frame / fps };
}

// 通用小节标题（多数素材顶部一行 kicker/label）
const Head: React.FC<{
  text?: string;
  color: string;
  size: number;
  align?: "left" | "center" | "right";
}> = ({ text, color, size, align = "center" }) => {
  const { frame, fps } = useLocal();
  const p = spring({ frame: frame - 2, fps, config: { damping: 200 } });
  if (!text) return null;
  return (
    <h2
      style={{
        fontSize: size,
        fontWeight: 800,
        color,
        margin: "0 0 48px",
        textAlign: align,
        opacity: interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(p, [0, 1], [-24, 0], { extrapolateRight: "clamp" })}px)`,
      }}
    >
      {text}
    </h2>
  );
};

// 1) 打字机标题 —— 逐字敲出 + 闪烁光标
export const TypewriterScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const text = scene.title || scene.narration || "";
  const cps = scene.revealSpeed && scene.revealSpeed > 0 ? scene.revealSpeed : 12; // 每秒字数
  const startDelay = 10;
  const shown = Math.max(0, Math.min(text.length, Math.floor(((frame - startDelay) / fps) * cps)));
  const caretOn = Math.floor((frame - startDelay) / 16) % 2 === 0;
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: "0 160px" }}
    >
      <div
        style={{
          fontSize: fs(96),
          fontWeight: 800,
          lineHeight: 1.3,
          color: P.title,
          maxWidth: 1500,
          textAlign: "center",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: fs(96) * 1.3,
        }}
      >
        {text.slice(0, shown)}
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: fs(88),
            marginLeft: 8,
            verticalAlign: "middle",
            background: shown >= text.length && !caretOn ? "transparent" : c1,
            borderRadius: 2,
          }}
        />
      </div>
      {scene.caption ? (
        <p style={{ marginTop: 40, fontSize: fs(38), color: c2, opacity: shown >= text.length ? 1 : 0 }}>
          {scene.caption}
        </p>
      ) : null}
    </AbsoluteFill>
  );
};

// 2) 逐词字幕（卡拉OK） —— 当前句逐词高亮
export const KaraokeScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { t } = useLocal();
  const subs: any[] = scene.subtitles && scene.subtitles.length
    ? scene.subtitles
    : [{ start: 0, end: 3, text: scene.title || "把每句话拆成词，逐词高亮跟读" }];
  const line = subs.find((s) => t >= s.start && t < s.end) || subs[subs.length - 1];
  const words = String(line?.text || "").split(/\s+/).filter(Boolean);
  const span = Math.max(0.001, line.end - line.start);
  const local = Math.max(0, Math.min(span, t - line.start));
  const per = span / Math.max(1, words.length);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 140px" }}>
      {scene.title ? <Head text={scene.title} color={c2} size={fs(40)} /> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0 26px", justifyContent: "center", maxWidth: 1500 }}>
        {words.map((w, i) => {
          const done = local >= per * (i + 1);
          const activeNow = local >= per * i && local < per * (i + 1);
          return (
            <span
              key={i}
              style={{
                fontSize: fs(84),
                fontWeight: 800,
                fontFamily: TITLE_FONT,
                color: done ? c1 : activeNow ? P.title : P.label,
                transform: activeNow ? "scale(1.12)" : "scale(1)",
                textShadow: done ? `0 0 30px ${c1}66` : "none",
                transition: "none",
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// 3) 划线强调 —— 关键词马克笔底色从左到右刷出
export const BannerScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const text: string = scene.title || "";
  const emph: string[] = scene.emphasis || [];
  // 按强调词切分：命中的片段用马克笔底色，底色宽度从左到右随时间刷出。
  const marks: { seg: string; hot: boolean }[] = [];
  if (emph.length) {
    const pattern = new RegExp(`(${emph.filter(Boolean).map(escapeRegExp).join("|")})`, "g");
    (text.split(pattern) as string[]).forEach((seg: string) => {
      if (seg) marks.push({ seg, hot: emph.some((e) => e === seg) });
    });
    if (!marks.length) marks.push({ seg: text, hot: false });
  } else {
    marks.push({ seg: text, hot: false });
  }
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 150px" }}>
      <div style={{ fontSize: fs(88), fontWeight: 800, lineHeight: 1.5, color: P.title, maxWidth: 1520, textAlign: "center" }}>
        {marks.map((m, i) => {
          if (!m.hot) return <span key={i}>{m.seg}</span>;
          const prog = spring({ frame: frame - 16 - i * 6, fps, config: { damping: 200 } });
          const w = interpolate(prog, [0, 1], [0, 100], { extrapolateRight: "clamp" });
          return (
            <span
              key={i}
              style={{
                color: "#fff",
                backgroundImage: `linear-gradient(120deg, ${c1}, ${c2})`,
                backgroundSize: `${w}% 100%`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "left bottom",
                padding: "0 6px",
                borderRadius: 8,
              }}
            >
              {m.seg}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 4) 数字滚动 count-up
export const CounterScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const to = Number(scene.counterTo ?? 0);
  const from = Number(scene.counterFrom ?? 0);
  const decimals = Number(scene.counterDecimals ?? 0);
  const prefix = scene.counterPrefix || "";
  const suffix = scene.counterSuffix || "";
  const p = spring({ frame: frame - 6, fps, config: { damping: 120, mass: 1.2 } });
  const val = interpolate(p, [0, 1], [from, to], { extrapolateRight: "clamp" });
  const shown = val.toFixed(decimals);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {scene.title ? <Head text={scene.title} color={P.body} size={fs(46)} /> : null}
      <div
        style={{
          fontSize: fs(200),
          fontWeight: 900,
          lineHeight: 1,
          background: `linear-gradient(120deg, ${c1}, ${c2})`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          letterSpacing: -4,
          fontFamily: TITLE_FONT,
        }}
      >
        {prefix}
        {shown}
        {suffix ? <span style={{ fontSize: fs(96) }}>{suffix}</span> : null}
      </div>
      {scene.caption ? <p style={{ marginTop: 40, fontSize: fs(38), color: c2 }}>{scene.caption}</p> : null}
    </AbsoluteFill>
  );
};

// 5) 进度环 —— 百分比环形增长 + 中心数字
export const RingScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const pct = Math.max(0, Math.min(100, Number(scene.percent ?? 0)));
  const p = spring({ frame: frame - 6, fps, config: { damping: 130 } });
  const prog = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const R = 150;
  const C = 2 * Math.PI * R;
  const dash = C * (pct / 100) * prog;
  const num = Math.round(pct * prog);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "relative", width: 360, height: 360 }}>
        <svg width={360} height={360} viewBox="0 0 360 360">
          <defs>
            <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={c1} />
              <stop offset="100%" stopColor={c2} />
            </linearGradient>
          </defs>
          <circle cx={180} cy={180} r={R} fill="none" stroke={P.dot} strokeWidth={28} />
          <circle
            cx={180}
            cy={180}
            r={R}
            fill="none"
            stroke="url(#ringg)"
            strokeWidth={28}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 180 180)"
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 84,
            fontWeight: 900,
            color: P.value,
          }}
        >
          {num}
          <span style={{ fontSize: 40, color: c2 }}>%</span>
        </div>
      </div>
      {scene.title ? (
        <h2 style={{ marginTop: 44, fontSize: fs(52), fontWeight: 800, color: P.title, margin: "44px 0 0" }}>
          {scene.title}
        </h2>
      ) : null}
    </AbsoluteFill>
  );
};

// 6) 数据条 —— 横向占比条逐条生长
export const BarsScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const bars: { label: string; value: number }[] = (scene.bars || []).map((b: any) => ({
    label: String(b?.label ?? ""),
    value: Number(b?.value ?? 0),
  }));
  const maxV = Math.max(1, ...bars.map((b) => b.value));
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 170px" }}>
      {scene.title ? <Head text={scene.title} color={P.title} size={fs(64)} align="left" /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
        {bars.map((b, i) => {
          const p = spring({ frame: frame - 12 - i * 7, fps, config: { damping: 200 } });
          const w = interpolate(p, [0, 1], [0, (b.value / maxV) * 100], { extrapolateRight: "clamp" });
          return (
            <div key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontSize: fs(40), color: P.body, fontWeight: 700 }}>{b.label}</span>
                <span style={{ fontSize: fs(40), color: P.value, fontWeight: 800 }}>{b.value}</span>
              </div>
              <div style={{ height: 26, borderRadius: 13, background: P.dot, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${w}%`,
                    borderRadius: 13,
                    background: `linear-gradient(90deg, ${c1}, ${c2})`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// 7) 打勾清单 —— 条目依次打勾
export const ChecklistScene: React.FC<LibProps> = ({ scene, c1, P, fs }) => {
  const { frame, fps } = useLocal();
  const items: string[] = scene.points || [];
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 190px" }}>
      {scene.title ? <Head text={scene.title} color={P.title} size={fs(68)} align="left" /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
        {items.map((it, i) => {
          const box = spring({ frame: frame - 12 - i * 9, fps, config: { damping: 200 } });
          const op = interpolate(box, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          const tick = interpolate(frame, [12 + i * 9 + 6, 12 + i * 9 + 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 26, opacity: op }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  border: `4px solid ${c1}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transform: `scale(${interpolate(box, [0, 1], [0.6, 1])})`,
                }}
              >
                <svg width={40} height={40} viewBox="0 0 40 40">
                  <path
                    d="M8 21 L17 30 L33 11"
                    fill="none"
                    stroke={c1}
                    strokeWidth={6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={40}
                    strokeDashoffset={40 * (1 - tick)}
                  />
                </svg>
              </div>
              <span style={{ fontSize: fs(52), color: P.title, fontWeight: 600 }}>{it}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// 8) 卡片网格 —— 图标卡片错落飞入
export const CardsScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const cards: any[] = scene.cards || [];
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 150px" }}>
      {scene.title ? <Head text={scene.title} color={P.title} size={fs(64)} /> : null}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 32,
          justifyContent: "center",
          maxWidth: 1560,
        }}
      >
        {cards.map((cd, i) => {
          const p = spring({ frame: frame - 10 - i * 7, fps, config: { damping: 200 } });
          const op = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          const y = interpolate(p, [0, 1], [60, 0], { extrapolateRight: "clamp" });
          const s = interpolate(p, [0, 1], [0.85, 1], { extrapolateRight: "clamp" });
          const accent = i % 2 === 0 ? c1 : c2;
          return (
            <div
              key={i}
              style={{
                width: "min(46%, 420px)",
                minWidth: 320,
                background: P.subBg,
                border: `1px solid ${accent}66`,
                borderRadius: 24,
                padding: "36px 34px",
                opacity: op,
                transform: `translateY(${y}px) scale(${s})`,
                boxShadow: `0 12px 40px ${accent}22`,
              }}
            >
              <div style={{ fontSize: 68, lineHeight: 1 }}>{cd.emoji || "•"}</div>
              <div style={{ marginTop: 18, fontSize: fs(44), fontWeight: 800, color: accent }}>
                {cd.title || ""}
              </div>
              <div style={{ marginTop: 12, fontSize: fs(32), color: P.body, lineHeight: 1.45 }}>
                {cd.desc || ""}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// 9) Ken Burns —— 图片缓慢推拉运镜
export const KenBurnsScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs, imgSrc }) => {
  const { frame, fps, t } = useLocal();
  const { durationInFrames } = useVideoConfig();
  const prog = interpolate(t, [0, durationInFrames / fps], [0, 1], { extrapolateRight: "clamp" });
  const scale = interpolate(prog, [0, 1], [1.08, 1.28]);
  const tx = interpolate(prog, [0, 1], [0, -3]); // % pan
  const capIn = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={scene.caption || ""}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${scale}) translate(${tx}%, 0)`,
              transformOrigin: "60% 40%",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `linear-gradient(135deg, ${c1}, ${c2})`,
              transform: `scale(${scale})`,
            }}
          />
        )}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 45%, rgba(0,0,0,.6))" }} />
      </div>
      <div style={{ position: "relative", padding: "0 120px 150px", opacity: interpolate(capIn, [0, 1], [0, 1]) }}>
        {scene.title ? (
          <div style={{ fontSize: fs(72), fontWeight: 800, color: "#fff", textShadow: "0 4px 20px rgba(0,0,0,.5)" }}>
            {scene.title}
          </div>
        ) : null}
        {scene.caption ? (
          <div style={{ marginTop: 14, fontSize: fs(38), color: P.subText, opacity: 0.9 }}>{scene.caption}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

// 10) 代码窗口 —— macOS 风格窗口，代码逐行显现
export const CodeScene: React.FC<LibProps> = ({ scene, P, fs }) => {
  const { frame, fps } = useLocal();
  const code: string = scene.code || "// 在此粘贴代码";
  const lines = code.split("\n");
  const win = spring({ frame: frame - 2, fps, config: { damping: 200 } });
  const lineDelay = 6;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 140px" }}>
      <div
        style={{
          width: "min(92%, 1500px)",
          borderRadius: 20,
          overflow: "hidden",
          background: "#0d1017",
          border: "1px solid rgba(255,255,255,.12)",
          boxShadow: "0 30px 90px rgba(0,0,0,.55)",
          opacity: interpolate(win, [0, 1], [0, 1]),
          transform: `translateY(${interpolate(win, [0, 1], [40, 0])}px) scale(${interpolate(win, [0, 1], [0.96, 1])})`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 24px", background: "#171b24" }}>
          {["#ff5f56", "#ffbd2e", "#27c93f"].map((dotc) => (
            <span key={dotc} style={{ width: 20, height: 20, borderRadius: "50%", background: dotc }} />
          ))}
          <span style={{ marginLeft: 16, fontSize: fs(26), color: "#8b97a8", fontFamily: MONO }}>
            {scene.title || "untitled"}
            {scene.codeLang ? ` · ${scene.codeLang}` : ""}
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            padding: "30px 36px",
            fontFamily: MONO,
            fontSize: fs(34),
            lineHeight: 1.7,
            color: "#e6edf3",
            whiteSpace: "pre",
            overflow: "hidden",
          }}
        >
          {lines.map((ln, i) => {
            const rev = interpolate(frame, [16 + i * lineDelay, 22 + i * lineDelay], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div key={i} style={{ opacity: rev, transform: `translateX(${(1 - rev) * 18}px)`, whiteSpace: "pre" }}>
                <span style={{ color: "#3d4450", marginRight: 28, userSelect: "none" }}>
                  {String(i + 1).padStart(2, " ")}
                </span>
                {ln || " "}
              </div>
            );
          })}
        </pre>
      </div>
    </AbsoluteFill>
  );
};

// 11) 对话气泡 —— 左右消息逐条弹出
export const ChatScene: React.FC<LibProps> = ({ scene, c1, c2, P, fs }) => {
  const { frame, fps } = useLocal();
  const msgs: any[] = (scene.messages || []).map((m: any) => ({
    side: m?.side === "me" ? "me" : "other",
    from: String(m?.from ?? ""),
    text: String(m?.text ?? ""),
  }));
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 170px" }}>
      {scene.title ? <Head text={scene.title} color={P.title} size={fs(58)} /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 26, maxWidth: 1300, width: "100%", margin: "0 auto" }}>
        {msgs.map((m, i) => {
          const p = spring({ frame: frame - 10 - i * 10, fps, config: { damping: 200 } });
          const op = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
          const y = interpolate(p, [0, 1], [30, 0], { extrapolateRight: "clamp" });
          const me = m.side === "me";
          return (
            <div
              key={i}
              style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start", opacity: op, transform: `translateY(${y}px)` }}
            >
              <div style={{ maxWidth: "70%" }}>
                {m.from ? (
                  <div style={{ fontSize: fs(24), color: P.label, marginBottom: 6, textAlign: me ? "right" : "left" }}>
                    {m.from}
                  </div>
                ) : null}
                <div
                  style={{
                    background: me ? `linear-gradient(120deg, ${c1}, ${c2})` : P.subBg,
                    color: me ? "#fff" : P.title,
                    fontSize: fs(40),
                    fontWeight: me ? 700 : 500,
                    padding: "22px 30px",
                    borderRadius: me ? "26px 26px 6px 26px" : "26px 26px 26px 6px",
                    lineHeight: 1.4,
                    border: me ? "none" : `1px solid ${P.dot}`,
                  }}
                >
                  {m.text}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// —— 分派表 ——
export const LIBRARY_RENDERERS: Record<string, React.FC<LibProps>> = {
  typewriter: TypewriterScene,
  karaoke: KaraokeScene,
  banner: BannerScene,
  counter: CounterScene,
  ring: RingScene,
  bars: BarsScene,
  checklist: ChecklistScene,
  cards: CardsScene,
  kb: KenBurnsScene,
  code: CodeScene,
  chat: ChatScene,
};

export const LibraryScene: React.FC<LibProps & { type: string }> = ({ type, ...rest }) => {
  const Comp = LIBRARY_RENDERERS[type];
  if (!Comp) {
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <span style={{ color: rest.P.label, fontSize: 40 }}>未知素材类型：{type}</span>
      </AbsoluteFill>
    );
  }
  return <Comp {...rest} />;
};

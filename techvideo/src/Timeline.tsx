// RVE 式可视化时间轴（TalkStudio 底栏）
// ————————————————————————————————————————————————
// 借鉴 Remotion Video Editor 的交互：秒刻度标尺、时间轴缩放、块右边缘拖拽改时长（可吸附）、
// 块体拖拽排序、标尺/轨道拖拽擦洗播放头、每块类型图标 + 选中高亮、rAF 驱动播放头。
// 纯受控展示组件：所有数据与回调由 TalkStudio 传入，本身不改业务状态。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { assetByType } from "./sceneAssets";

type Props = {
  scenes: any[];
  fps: number;
  durations: number[]; // 每场景帧数（与 scenes 等长）
  starts: number[]; // 每场景起始帧（累计）
  total: number; // 场景总帧数
  playerDur: number; // 播放器总帧数（含视频覆盖）
  selected: number;
  getFrame: () => number; // 读取 Player 当前帧
  onSelect: (i: number) => void;
  onSeekFrame: (f: number) => void;
  onReorder: (from: number, to: number) => void;
  onResize: (i: number, durFrames: number) => void;
};

const MIN_FRAMES = 30; // 最短 1s

export default function Timeline({
  scenes,
  fps,
  durations,
  starts,
  total,
  playerDur,
  selected,
  getFrame,
  onSelect,
  onSeekFrame,
  onReorder,
  onResize,
}: Props) {
  // pxPerSec：时间轴缩放（横向像素/秒）。fit 时按容器宽度铺满。
  const [pxPerSec, setPxPerSec] = useState<number>(80);
  const [snap, setSnap] = useState<boolean>(true);
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragIdx = useRef<number | null>(null);
  const scrubbing = useRef<boolean>(false);

  const snapFrames = Math.max(1, Math.round(fps / 4)); // 吸附粒度 0.25s
  const contentW = (Math.max(total, playerDur) / fps) * pxPerSec; // 轨道内容宽度

  // 适应宽度：把总时长铺满可见区域
  function fit() {
    const el = trackRef.current;
    if (!el) return;
    const durSec = Math.max(0.5, Math.max(total, playerDur) / fps);
    setPxPerSec(Math.max(12, (el.clientWidth - 8) / durSec));
  }

  // 播放头 rAF：直写 DOM，避免逐帧 setState
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const f = getFrame();
      const ph = playheadRef.current;
      if (ph) ph.style.left = (f / fps) * pxPerSec + "px";
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getFrame, fps, pxPerSec]);

  // 擦洗：把指针 x 映射为帧并 seek
  function frameAtClientX(clientX: number): number {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    const f = Math.round((x / pxPerSec) * fps);
    return Math.max(0, Math.min(playerDur - 1, f));
  }

  // —— 拖拽改时长（右边缘手柄）——
  function startResize(e: React.PointerEvent, i: number) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startDur = durations[i];
    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {}
    const move = (ev: PointerEvent) => {
      const dFrames = ((ev.clientX - startX) / pxPerSec) * fps;
      let nd = startDur + dFrames;
      if (snap) nd = Math.round(nd / snapFrames) * snapFrames;
      nd = Math.max(MIN_FRAMES, Math.round(nd));
      onResize(i, nd);
    };
    const up = (ev: PointerEvent) => {
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {}
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  // 首次挂载时按容器自适应一次
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ts-tl">
      {/* 工具条：缩放 / 吸附 / 总时长 */}
      <div className="ts-tl-tools">
        <span className="ts-tl-stat">
          {scenes.length} 段 · {(total / fps).toFixed(1)}s{playerDur !== total ? ` · 视频 ${(playerDur / fps).toFixed(1)}s` : ""}
        </span>
        <label className="ts-tl-snap">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 吸附 0.25s
        </label>
        <div className="ts-tl-zoom">
          <span>缩放</span>
          <input
            type="range"
            min={16}
            max={240}
            step={4}
            value={Math.round(pxPerSec)}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
          />
          <button className="ts-tl-btn" onClick={fit}>适应</button>
        </div>
      </div>

      {/* 轨道容器（可横向滚动） */}
      <div
        className="ts-tl-scroll"
        ref={trackRef}
        onPointerDown={(e) => {
          // 空白区/标尺擦洗播放头
          if ((e.target as HTMLElement).dataset.ruler === "1" || (e.target as HTMLElement).classList.contains("ts-tl-scroll")) {
            scrubbing.current = true;
            onSeekFrame(frameAtClientX(e.clientX));
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {}
          }
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) onSeekFrame(frameAtClientX(e.clientX));
        }}
        onPointerUp={(e) => {
          scrubbing.current = false;
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {}
        }}
      >
        <div className="ts-tl-canvas" style={{ width: contentW + 4 }}>
          {/* 秒刻度标尺 */}
          <div className="ts-tl-ruler" data-ruler="1">
            {Array.from({ length: Math.ceil(Math.max(total, playerDur) / fps) + 1 }).map((_, s) => (
              <div key={s} className="ts-tl-tick" style={{ left: s * pxPerSec }}>
                <span>{s}s</span>
              </div>
            ))}
          </div>

          {/* 场景块轨道 */}
          <div className="ts-tl-lane">
            {scenes.map((s: any, i: number) => {
              const left = (starts[i] / fps) * pxPerSec;
              const w = Math.max(40, (durations[i] / fps) * pxPerSec - 4);
              const a = assetByType(s?.type || "title");
              return (
                <div
                  key={i}
                  className={`ts-tl-clip${i === selected ? " active" : ""}`}
                  style={{ left, width: w }}
                  draggable
                  onDragStart={() => (dragIdx.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const from = dragIdx.current;
                    if (from === null || from === i) return;
                    onReorder(from, i);
                    dragIdx.current = null;
                  }}
                  onClick={() => onSelect(i)}
                  title={`${a?.label || s?.type || "场景"} · ${(durations[i] / fps).toFixed(1)}s · 拖动排序 / 拖右边缘改时长`}
                >
                  <div className="ts-tl-clip-head">
                    <span className="ts-tl-clip-i">{String(i + 1).padStart(2, "0")}</span>
                    <span className="ts-tl-clip-ico">{a?.emoji || "▦"}</span>
                    <span className="ts-tl-clip-d">{(durations[i] / fps).toFixed(1)}s</span>
                  </div>
                  <div className="ts-tl-clip-t">{s?.kicker || s?.title || s?.quote || a?.label || "（空）"}</div>
                  {/* 右边缘改时长手柄 */}
                  <div
                    className="ts-tl-resize"
                    onPointerDown={(e) => startResize(e, i)}
                    onClick={(e) => e.stopPropagation()}
                    title="拖动改时长"
                  />
                </div>
              );
            })}
          </div>

          {/* 播放头 */}
          <div className="ts-tl-playhead" ref={playheadRef} />
        </div>
      </div>
    </div>
  );
}

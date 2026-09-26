import { useMemo, useRef, useState } from "react";
import { assetsByGroup, assetByType, ASSET_DEFAULTS } from "./sceneAssets";

interface SceneEditorProps {
  scene: any;
  index: number;
  onChange: (patch: any) => void;
  globalPipSize?: number; // 全局画中画默认大小（未覆盖时显示）
  globalPipPos?: string;  // 全局画中画默认位置
  // v1.9.4：本场景视频上传（复用 /api/v1/techvideo/upload），成功后返回相对 URL；
  // 由 TalkStudio 提供实现（上传含进度/错误处理），SceneEditor 只负责触发 + 写回字段。
  onUploadSceneVideo?: (file: File) => Promise<string>;
}

const PIP_POS_OPTIONS: { value: string; label: string }[] = [
  { value: "tl", label: "左上" },
  { value: "tc", label: "上中" },
  { value: "tr", label: "右上" },
  { value: "ml", label: "左中" },
  { value: "center", label: "居中" },
  { value: "mr", label: "右中" },
  { value: "bl", label: "左下" },
  { value: "bc", label: "下中" },
  { value: "br", label: "右下" },
];

const SCENE_GROUPS = assetsByGroup();

function str(v: any): string {
  return v == null ? "" : String(v);
}
function num(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function linesToArr(v: string): string[] {
  return v.split("\n").map((s) => s.trim()).filter(Boolean);
}
function arrToLines(arr: any[] | undefined): string {
  return (arr || []).map((s) => String(s)).join("\n");
}

export default function SceneEditor({
  scene,
  index,
  onChange,
  globalPipSize = 32,
  globalPipPos = "br",
  onUploadSceneVideo,
}: SceneEditorProps) {
  const type = scene?.type || "title";

  const set = (patch: any) => onChange(patch);

  // 切换素材类型：把该素材的示例默认字段补进「当前空缺」的字段，方便一键套用效果；
  // 已有内容不覆盖（避免清掉用户已写的标题/要点）。
  function applyType(next: string) {
    const patch: any = { type: next };
    const d: any = ASSET_DEFAULTS[next] || {};
    for (const k of Object.keys(d)) {
      if (k === "type") continue;
      if (scene?.[k] === undefined) patch[k] = d[k];
    }
    set(patch);
  }

  // v1.9.4：本场景视频上传状态（独立于全局口播素材的上传流程）
  const sceneVideoRef = useRef<HTMLInputElement>(null);
  const [sceneVideoUploading, setSceneVideoUploading] = useState(false);
  const [sceneVideoProgress, setSceneVideoProgress] = useState(0);

  async function handleSceneVideoUpload(file: File) {
    if (!onUploadSceneVideo) return;
    setSceneVideoUploading(true);
    setSceneVideoProgress(0);
    try {
      const url = await onUploadSceneVideo(file);
      set({ sceneVideo: url });
    } catch {
      // 错误提示由 TalkStudio 的回调统一 toast，这里只重置状态
    } finally {
      setSceneVideoUploading(false);
      setSceneVideoProgress(0);
      if (sceneVideoRef.current) sceneVideoRef.current.value = "";
    }
  }

  const chart = useMemo(
    () =>
      scene?.chart || {
        kind: "bar",
        unit: "",
        labels: [],
        values: [],
        series: [],
      },
    [scene?.chart]
  );

  const events = scene?.events || [];
  const columns = scene?.columns || [];

  return (
    <div className="ts-scene-editor">
      <label className="ts-field">
        <span>类型</span>
        <select value={type} onChange={(e) => applyType(e.target.value)}>
          {SCENE_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((a) => (
                <option key={a.type} value={a.type}>
                  {a.emoji} {a.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {assetByType(type) && (
        <p className="ts-hint" style={{ marginTop: -6 }}>
          {assetByType(type)!.emoji} {assetByType(type)!.hint}
        </p>
      )}

      {/* 通用字段 */}
      <label className="ts-field">
        <span>眉标(kicker)</span>
        <input
          value={str(scene?.kicker)}
          onChange={(e) => set({ kicker: e.target.value })}
          placeholder="如：开场 / 痛点 / 核心数据"
        />
      </label>

      <label className="ts-field">
        <span>标题</span>
        <input value={str(scene?.title)} onChange={(e) => set({ title: e.target.value })} />
      </label>

      {/* 本场景视频（v1.9.4）：给当前时间线节点单独插一段视频，
          留空则回退左侧全局「口播素材」。每个节点独立，互不影响。 */}
      <div className="ts-subpanel">
        <div className="ts-subpanel-head">
          <span>本场景视频</span>
          {scene?.sceneVideo && (
            <button className="ts-btn" onClick={() => set({ sceneVideo: undefined })}>
              ↺ 清除（回退全局）
            </button>
          )}
        </div>
        <p className="ts-hint" style={{ marginTop: 0 }}>
          给当前场景单独插入视频（如某章节的 B-roll）；留空则用左侧全局「口播素材」。
        </p>
        <input
          ref={sceneVideoRef}
          type="file"
          accept="video/*"
          disabled={sceneVideoUploading}
          onChange={(e) => {
            if (e.target.files?.[0]) handleSceneVideoUpload(e.target.files[0]);
            e.target.value = "";
          }}
        />
        {sceneVideoUploading && (
          <div className="ts-prog"><div className="ts-prog-bar" style={{ width: sceneVideoProgress + "%" }} /></div>
        )}
        {scene?.sceneVideo ? (
          <p className="ts-hint">已挂载本场景视频：{String(scene.sceneVideo).split("/").pop()}</p>
        ) : (
          <p className="ts-hint">未设置 → 使用左侧全局「口播素材」。</p>
        )}
      </div>

      {(type === "quote" || type === "cite") && (
        <label className="ts-field">
          <span>金句 / 引用原文</span>
          <textarea
            value={str(scene?.quote)}
            onChange={(e) => set({ quote: e.target.value })}
            placeholder="金句卡或引用块的正文"
          />
        </label>
      )}

      {type === "cite" && (
        <label className="ts-field">
          <span>出处/作者</span>
          <input value={str(scene?.author)} onChange={(e) => set({ author: e.target.value })} placeholder="如：鲁迅 / 《XXX》" />
        </label>
      )}

      {type === "points" && (
        <label className="ts-field">
          <span>要点（每行一条）</span>
          <textarea
            value={arrToLines(scene?.points)}
            onChange={(e) => set({ points: linesToArr(e.target.value) })}
            rows={5}
          />
        </label>
      )}

      {type === "data" && (
        <label className="ts-field">
          <span>关键词（每行一个）</span>
          <textarea
            value={arrToLines(scene?.keywords)}
            onChange={(e) => set({ keywords: linesToArr(e.target.value) })}
            rows={4}
            placeholder="命中「强调词」的关键词会视觉放大"
          />
        </label>
      )}

      {type === "image" && (
        <>
          <label className="ts-field">
            <span>图片地址</span>
            <input
              value={str(scene?.imageUrl)}
              onChange={(e) => set({ imageUrl: e.target.value })}
              placeholder="URL 或 uploads/xxx.jpg"
            />
          </label>
          <label className="ts-field">
            <span>说明</span>
            <input value={str(scene?.caption)} onChange={(e) => set({ caption: e.target.value })} />
          </label>
          <label className="ts-field">
            <span>AI 配图提示词</span>
            <textarea
              value={str(scene?.imagePrompt)}
              onChange={(e) => set({ imagePrompt: e.target.value })}
              rows={3}
              placeholder="留空则使用上方图片；未上传时显示提示词占位"
            />
          </label>
        </>
      )}

      {type === "chart" && (
        <div className="ts-subpanel">
          <label className="ts-field">
            <span>图表类型</span>
            <select
              value={chart.kind || "bar"}
              onChange={(e) => set({ chart: { ...chart, kind: e.target.value } })}
            >
              <option value="bar">柱状图</option>
              <option value="line">折线图</option>
              <option value="pie">饼图</option>
              <option value="radar">雷达图</option>
              <option value="stacked">堆叠图</option>
              <option value="area">面积图</option>
            </select>
          </label>
          <label className="ts-field">
            <span>单位</span>
            <input
              value={str(chart.unit)}
              onChange={(e) => set({ chart: { ...chart, unit: e.target.value } })}
              placeholder="如：% / 万元 / 人次"
            />
          </label>
          <label className="ts-field">
            <span>标签（每行一个）</span>
            <textarea
              value={arrToLines(chart.labels)}
              onChange={(e) => set({ chart: { ...chart, labels: linesToArr(e.target.value) } })}
              rows={3}
            />
          </label>
          <label className="ts-field">
            <span>数值（每行一个，与标签对齐）</span>
            <textarea
              value={(chart.values || []).join("\n")}
              onChange={(e) =>
                set({
                  chart: {
                    ...chart,
                    values: e.target.value
                      .split("\n")
                      .map((s) => Number(s.trim()))
                      .filter((n) => Number.isFinite(n)),
                  },
                })
              }
              rows={3}
            />
          </label>
          <label className="ts-field">
            <span>多系列 JSON（可选）</span>
            <textarea
              value={JSON.stringify(chart.series || [], null, 2)}
              onChange={(e) => {
                try {
                  const series = JSON.parse(e.target.value || "[]");
                  set({ chart: { ...chart, series: Array.isArray(series) ? series : [] } });
                } catch {}
              }}
              rows={3}
              placeholder='[{"name":"2023","values":[10,20,30]}]'
            />
          </label>
        </div>
      )}

      {type === "timeline" && (
        <div className="ts-subpanel">
          <label className="ts-field">
            <span>时间线事件</span>
            <div className="ts-list">
              {events.map((ev: any, i: number) => (
                <div key={i} className="ts-list-row">
                  <input
                    value={str(ev?.time)}
                    onChange={(e) => {
                      const next = [...events];
                      next[i] = { ...next[i], time: e.target.value };
                      set({ events: next });
                    }}
                    placeholder="时间"
                  />
                  <input
                    value={str(ev?.text)}
                    onChange={(e) => {
                      const next = [...events];
                      next[i] = { ...next[i], text: e.target.value };
                      set({ events: next });
                    }}
                    placeholder="事件描述"
                  />
                  <button
                    className="ts-icon-btn"
                    onClick={() => {
                      const next = [...events];
                      next.splice(i, 1);
                      set({ events: next });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="ts-btn"
                onClick={() => set({ events: [...events, { time: "", text: "" }] })}
              >
                ＋ 添加事件
              </button>
            </div>
          </label>
        </div>
      )}

      {type === "compare" && (
        <div className="ts-subpanel">
          <label className="ts-field">
            <span>对比列</span>
            <div className="ts-list">
              {columns.map((col: any, i: number) => (
                <div key={i} className="ts-list-col">
                  <div className="ts-list-row">
                    <input
                      value={str(col?.name)}
                      onChange={(e) => {
                        const next = [...columns];
                        next[i] = { ...next[i], name: e.target.value };
                        set({ columns: next });
                      }}
                      placeholder="列名"
                    />
                    <button
                      className="ts-icon-btn"
                      onClick={() => {
                        const next = [...columns];
                        next.splice(i, 1);
                        set({ columns: next });
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    value={arrToLines(col?.items)}
                    onChange={(e) => {
                      const next = [...columns];
                      next[i] = { ...next[i], items: linesToArr(e.target.value) };
                      set({ columns: next });
                    }}
                    rows={3}
                    placeholder="每行一个对比项"
                  />
                </div>
              ))}
              <button
                className="ts-btn"
                onClick={() => set({ columns: [...columns, { name: "", items: [] }] })}
              >
                ＋ 添加列
              </button>
            </div>
          </label>
        </div>
      )}

      {/* —— 素材库新增构件的专属参数编辑区 —— */}
      {(type === "typewriter") && (
        <label className="ts-field">
          <span>打字速度（字/秒）</span>
          <input
            type="number"
            min={2}
            max={60}
            value={num(scene?.revealSpeed, 12)}
            onChange={(e) => set({ revealSpeed: num(e.target.value, 12) })}
          />
        </label>
      )}

      {type === "karaoke" && (
        <label className="ts-field">
          <span>字幕（每行一句，自动按场景时长均分逐词高亮）</span>
          <textarea
            rows={4}
            value={(scene?.subtitles || []).map((s: any) => String(s?.text ?? "")).join("\n")}
            onChange={(e) => {
              const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
              const total = (scene?.durationFrames || 90) / 30;
              const per = lines.length ? total / lines.length : 0;
              set({
                subtitles: lines.map((text, i) => ({
                  start: +(i * per).toFixed(2),
                  end: +((i + 1) * per).toFixed(2),
                  text,
                })),
              });
            }}
            placeholder="把每句话拆成词&#10;逐词高亮跟读"
          />
        </label>
      )}

      {type === "counter" && (
        <div className="ts-subpanel">
          <div className="ts-row">
            <label className="ts-field" style={{ flex: 1 }}>
              <span>起始值</span>
              <input type="number" value={num(scene?.counterFrom, 0)} onChange={(e) => set({ counterFrom: num(e.target.value, 0) })} />
            </label>
            <label className="ts-field" style={{ flex: 1 }}>
              <span>目标值</span>
              <input type="number" value={num(scene?.counterTo, 0)} onChange={(e) => set({ counterTo: num(e.target.value, 0) })} />
            </label>
          </div>
          <div className="ts-row">
            <label className="ts-field" style={{ flex: 1 }}>
              <span>前缀</span>
              <input value={str(scene?.counterPrefix)} onChange={(e) => set({ counterPrefix: e.target.value })} placeholder="如 ¥" />
            </label>
            <label className="ts-field" style={{ flex: 1 }}>
              <span>后缀</span>
              <input value={str(scene?.counterSuffix)} onChange={(e) => set({ counterSuffix: e.target.value })} placeholder="如 % / 条" />
            </label>
            <label className="ts-field" style={{ width: 90 }}>
              <span>小数位</span>
              <input type="number" min={0} max={4} value={num(scene?.counterDecimals, 0)} onChange={(e) => set({ counterDecimals: num(e.target.value, 0) })} />
            </label>
          </div>
        </div>
      )}

      {type === "ring" && (
        <label className="ts-field">
          <span>百分比（0-100）</span>
          <input
            className="ts-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={num(scene?.percent, 0)}
            onChange={(e) => set({ percent: num(e.target.value, 0) })}
          />
          <span className="ts-hint">{num(scene?.percent, 0)}%</span>
        </label>
      )}

      {type === "bars" && (
        <div className="ts-subpanel">
          <div className="ts-subpanel-head"><span>数据条</span></div>
          <div className="ts-list">
            {(scene?.bars || []).map((b: any, i: number) => (
              <div key={i} className="ts-list-row">
                <input
                  value={str(b?.label)}
                  placeholder="标签"
                  onChange={(e) => {
                    const next = [...(scene.bars || [])];
                    next[i] = { ...next[i], label: e.target.value };
                    set({ bars: next });
                  }}
                />
                <input
                  type="number"
                  style={{ width: 90 }}
                  value={num(b?.value, 0)}
                  placeholder="值"
                  onChange={(e) => {
                    const next = [...(scene.bars || [])];
                    next[i] = { ...next[i], value: num(e.target.value, 0) };
                    set({ bars: next });
                  }}
                />
                <button
                  className="ts-icon-btn"
                  onClick={() => {
                    const next = [...(scene.bars || [])];
                    next.splice(i, 1);
                    set({ bars: next });
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="ts-btn" onClick={() => set({ bars: [...(scene.bars || []), { label: "", value: 0 }] })}>
              ＋ 添加一项
            </button>
          </div>
        </div>
      )}

      {type === "cards" && (
        <div className="ts-subpanel">
          <div className="ts-subpanel-head"><span>卡片（图标 / 标题 / 描述）</span></div>
          <div className="ts-list">
            {(scene?.cards || []).map((cd: any, i: number) => (
              <div key={i} className="ts-list-col">
                <div className="ts-list-row">
                  <input
                    style={{ width: 64 }}
                    value={str(cd?.emoji)}
                    placeholder="图标"
                    onChange={(e) => {
                      const next = [...(scene.cards || [])];
                      next[i] = { ...next[i], emoji: e.target.value };
                      set({ cards: next });
                    }}
                  />
                  <input
                    value={str(cd?.title)}
                    placeholder="卡片标题"
                    onChange={(e) => {
                      const next = [...(scene.cards || [])];
                      next[i] = { ...next[i], title: e.target.value };
                      set({ cards: next });
                    }}
                  />
                  <button
                    className="ts-icon-btn"
                    onClick={() => {
                      const next = [...(scene.cards || [])];
                      next.splice(i, 1);
                      set({ cards: next });
                    }}
                  >
                    ×
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={str(cd?.desc)}
                  placeholder="卡片说明"
                  onChange={(e) => {
                    const next = [...(scene.cards || [])];
                    next[i] = { ...next[i], desc: e.target.value };
                    set({ cards: next });
                  }}
                />
              </div>
            ))}
            <button className="ts-btn" onClick={() => set({ cards: [...(scene.cards || []), { emoji: "⭐", title: "标题", desc: "说明" }] })}>
              ＋ 添加卡片
            </button>
          </div>
        </div>
      )}

      {type === "code" && (
        <div className="ts-subpanel">
          <label className="ts-field">
            <span>语言标注（仅显示）</span>
            <input value={str(scene?.codeLang)} onChange={(e) => set({ codeLang: e.target.value })} placeholder="如 ts / python" />
          </label>
          <label className="ts-field">
            <span>代码正文（每行一条，逐行显现）</span>
            <textarea
              rows={8}
              value={str(scene?.code)}
              onChange={(e) => set({ code: e.target.value })}
              style={{ fontFamily: "ui-monospace, Consolas, monospace" }}
            />
          </label>
        </div>
      )}

      {type === "chat" && (
        <div className="ts-subpanel">
          <div className="ts-subpanel-head"><span>对话（左右气泡）</span></div>
          <div className="ts-list">
            {(scene?.messages || []).map((m: any, i: number) => (
              <div key={i} className="ts-list-col">
                <div className="ts-list-row">
                  <select
                    value={m?.side === "me" ? "me" : "other"}
                    style={{ width: 96 }}
                    onChange={(e) => {
                      const next = [...(scene.messages || [])];
                      next[i] = { ...next[i], side: e.target.value };
                      set({ messages: next });
                    }}
                  >
                    <option value="other">对方</option>
                    <option value="me">我</option>
                  </select>
                  <input
                    value={str(m?.from)}
                    placeholder="昵称（可空）"
                    onChange={(e) => {
                      const next = [...(scene.messages || [])];
                      next[i] = { ...next[i], from: e.target.value };
                      set({ messages: next });
                    }}
                  />
                  <button
                    className="ts-icon-btn"
                    onClick={() => {
                      const next = [...(scene.messages || [])];
                      next.splice(i, 1);
                      set({ messages: next });
                    }}
                  >
                    ×
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={str(m?.text)}
                  placeholder="消息内容"
                  onChange={(e) => {
                    const next = [...(scene.messages || [])];
                    next[i] = { ...next[i], text: e.target.value };
                    set({ messages: next });
                  }}
                />
              </div>
            ))}
            <button className="ts-btn" onClick={() => set({ messages: [...(scene.messages || []), { side: "other", from: "", text: "" }] })}>
              ＋ 添加消息
            </button>
          </div>
        </div>
      )}

      <label className="ts-field">
        <span>旁白（本场景口播）</span>
        <textarea
          value={str(scene?.narration)}
          onChange={(e) => set({ narration: e.target.value })}
          placeholder="会用于配音与字幕"
          rows={3}
        />
      </label>

      {/* 样式与节奏 */}
      <div className="ts-subpanel">
        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>入场动效</span>
            <select
              value={scene?.animation || "fade"}
              onChange={(e) => set({ animation: e.target.value })}
            >
              <option value="fade">淡入</option>
              <option value="slide">滑动</option>
              <option value="zoom">缩放</option>
              <option value="blur">模糊</option>
              <option value="wipe">擦除</option>
              <option value="flip">翻转 3D</option>
              <option value="iris">圆形展开</option>
              <option value="none">无</option>
            </select>
          </label>
        </div>

        {/* 场景级口播叠加方式：本节点可单独切换（底片混排/硬切/画中画），缺省跟随全局 */}
        <label className="ts-field">
          <span>口播叠加（本场景）</span>
          <select
            value={scene?.videoLayout || ""}
            onChange={(e) =>
              set({ videoLayout: e.target.value || undefined })
            }
          >
            <option value="">跟随全局</option>
            <option value="underlay">底片混排</option>
            <option value="cross-cut">硬切交替</option>
            <option value="pip">画中画</option>
          </select>
        </label>

        {/* 本场景为画中画时：大小/位置可按节点单独覆盖（缺省跟随全局） */}
        {scene?.videoLayout === "pip" && (
          <div className="ts-subpanel">
            <label className="ts-field">
              <span>画中画大小 {scene?.pipSize || globalPipSize}%{scene?.pipSize ? "" : "（全局）"}</span>
              <input
                className="ts-range"
                type="range"
                min={10}
                max={70}
                step={2}
                value={scene?.pipSize || globalPipSize}
                onChange={(e) => set({ pipSize: Number(e.target.value) })}
              />
            </label>
            <label className="ts-field">
              <span>画中画位置</span>
              <select
                value={scene?.pipPos || ""}
                onChange={(e) => set({ pipPos: e.target.value || undefined })}
              >
                <option value="">跟随全局（{PIP_POS_OPTIONS.find((p) => p.value === globalPipPos)?.label || "右下"}）</option>
                {PIP_POS_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </label>
            {(scene?.pipSize || scene?.pipPos) && (
              <button
                className="ts-btn"
                onClick={() => set({ pipSize: undefined, pipPos: undefined })}
              >
                ↺ 恢复跟随全局
              </button>
            )}
          </div>
        )}

        <label className="ts-field">
          <span>时长（帧 @30fps）</span>
          <input
            type="number"
            min={30}
            step={15}
            value={scene?.durationFrames || 90}
            onChange={(e) => set({ durationFrames: Math.max(30, parseInt(e.target.value || "90", 10)) })}
          />
        </label>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>场景主色覆盖</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.color1 || "#5eead4"}
                onChange={(e) => set({ color1: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.color1)}
                onChange={(e) => set({ color1: e.target.value })}
                placeholder="留空用全局主色"
              />
            </div>
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>场景辅色覆盖</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.color2 || "#8aa2ff"}
                onChange={(e) => set({ color2: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.color2)}
                onChange={(e) => set({ color2: e.target.value })}
                placeholder="留空用全局辅色"
              />
            </div>
          </label>
        </div>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>字号缩放</span>
            <input
              type="number"
              step={0.05}
              min={0.3}
              max={3}
              value={num(scene?.fontScale, 1)}
              onChange={(e) => set({ fontScale: num(e.target.value, 1) })}
            />
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>标题缩放</span>
            <input
              type="number"
              step={0.05}
              min={0.3}
              max={3}
              value={num(scene?.titleScale, 1)}
              onChange={(e) => set({ titleScale: num(e.target.value, 1) })}
            />
          </label>
        </div>

        <label className="ts-field">
          <span>强调词（每行一个，命中后视觉放大）</span>
          <textarea
            value={arrToLines(scene?.emphasis)}
            onChange={(e) => set({ emphasis: linesToArr(e.target.value) })}
            rows={2}
          />
        </label>
      </div>

      {/* 文字样式（影响播放器渲染）：每个场景可单独覆盖眉标/标题/要点/金句/说明
          各自的文字色 + 字号，让"位置只有 3 种"扩展到颜色/大小也都能逐元素调。 */}
      <div className="ts-subpanel">
        <div className="ts-subpanel-head">
          <span>文字样式</span>
          {(scene?.kickerColor || scene?.titleColor || scene?.pointsColor || scene?.quoteColor ||
            scene?.captionColor || scene?.narrationColor ||
            (scene?.kickerScale && scene.kickerScale !== 1) ||
            (scene?.pointsScale && scene.pointsScale !== 1) ||
            (scene?.quoteScale && scene.quoteScale !== 1)) && (
            <button
              className="ts-btn"
              onClick={() => set({
                kickerColor: undefined, titleColor: undefined, pointsColor: undefined,
                quoteColor: undefined, captionColor: undefined, narrationColor: undefined,
                kickerScale: undefined, pointsScale: undefined, quoteScale: undefined,
              })}
            >
              ↺ 恢复跟随全局
            </button>
          )}
        </div>
        <p className="ts-hint" style={{ marginTop: 0 }}>影响播放器里的渲染与导出成片。每个场景可单独覆盖。</p>

        <label className="ts-field">
          <span>版式</span>
          <select
            value={scene?.layout || "center"}
            onChange={(e) => set({ layout: e.target.value })}
          >
            <option value="center">居中</option>
            <option value="left">左对齐</option>
            <option value="right">右对齐</option>
            <option value="split">分栏（左侧色条）</option>
            <option value="top">顶部对齐</option>
            <option value="bottom">底部对齐</option>
            <option value="card">卡片（带背景框）</option>
            <option value="magazine">杂志（左侧竖排眉标 + 右侧大标题）</option>
          </select>
        </label>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>眉标色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.kickerColor || "#5eead4"}
                onChange={(e) => set({ kickerColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.kickerColor)}
                onChange={(e) => set({ kickerColor: e.target.value })}
                placeholder="留空用主色"
              />
            </div>
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>标题色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.titleColor || "#f5f7fa"}
                onChange={(e) => set({ titleColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.titleColor)}
                onChange={(e) => set({ titleColor: e.target.value })}
                placeholder="留空用全局标题色"
              />
            </div>
          </label>
        </div>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>要点色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.pointsColor || "#c2cad6"}
                onChange={(e) => set({ pointsColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.pointsColor)}
                onChange={(e) => set({ pointsColor: e.target.value })}
                placeholder="留空用全局正文色"
              />
            </div>
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>金句/引用色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.quoteColor || "#f5f7fa"}
                onChange={(e) => set({ quoteColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.quoteColor)}
                onChange={(e) => set({ quoteColor: e.target.value })}
                placeholder="留空用全局标题色"
              />
            </div>
          </label>
        </div>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>说明色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.captionColor || "#c2cad6"}
                onChange={(e) => set({ captionColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.captionColor)}
                onChange={(e) => set({ captionColor: e.target.value })}
                placeholder="留空用全局正文色"
              />
            </div>
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>旁白色</span>
            <div className="ts-color-row">
              <input
                type="color"
                value={scene?.narrationColor || "#c2cad6"}
                onChange={(e) => set({ narrationColor: e.target.value })}
              />
              <input
                type="text"
                value={str(scene?.narrationColor)}
                onChange={(e) => set({ narrationColor: e.target.value })}
                placeholder="留空用全局正文色"
              />
            </div>
          </label>
        </div>

        <div className="ts-row">
          <label className="ts-field" style={{ flex: 1 }}>
            <span>眉标字号 {num(scene?.kickerScale, 1).toFixed(2)}×</span>
            <input
              className="ts-range"
              type="range"
              min={0.5}
              max={2.5}
              step={0.05}
              value={num(scene?.kickerScale, 1)}
              onChange={(e) => set({ kickerScale: num(e.target.value, 1) })}
            />
          </label>
          <label className="ts-field" style={{ flex: 1 }}>
            <span>要点字号 {num(scene?.pointsScale, 1).toFixed(2)}×</span>
            <input
              className="ts-range"
              type="range"
              min={0.5}
              max={2.5}
              step={0.05}
              value={num(scene?.pointsScale, 1)}
              onChange={(e) => set({ pointsScale: num(e.target.value, 1) })}
            />
          </label>
        </div>

        <label className="ts-field">
          <span>金句字号 {num(scene?.quoteScale, 1).toFixed(2)}×</span>
          <input
            className="ts-range"
            type="range"
            min={0.5}
            max={2.5}
            step={0.05}
            value={num(scene?.quoteScale, 1)}
            onChange={(e) => set({ quoteScale: num(e.target.value, 1) })}
          />
        </label>
      </div>
    </div>
  );
}

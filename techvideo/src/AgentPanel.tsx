import { useRef, useState } from "react";

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
  chart?: { kind: string; unit?: string; labels: string[]; values: number[] };
  durationFrames?: number;
}

export interface Plan {
  color1: string;
  color2: string;
  scenes: Scene[];
  audio_url: string;
}

interface Props {
  plan: Plan;
  language: string;
  sceneCount: number;
  voiceName: string;
  onApply: (plan: Plan, reply: string) => void;
  messages: Msg[];
  onMessagesChange: (messages: Msg[]) => void;
}

export interface Msg {
  role: "user" | "agent";
  text: string;
}

export default function AgentPanel({
  plan,
  language,
  sceneCount,
  voiceName,
  onApply,
  messages,
  onMessagesChange,
}: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    onMessagesChange([...messages, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/v1/techvideo/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: text,
          plan,
          language,
          scene_count: sceneCount,
          voice_name: voiceName,
        }),
      });
      const data = await res.json();
      const payload = data?.data || {};
      const scenes = payload.scenes || [];
      if (!scenes.length) {
        throw new Error(payload.reply || "操作未完成，请换种说法再试。");
      }
      const newPlan: Plan = {
        color1: payload.color1 || plan.color1,
        color2: payload.color2 || plan.color2,
        scenes,
        audio_url: payload.audio_url || plan.audio_url,
      };
      onApply(newPlan, payload.reply || "");
      onMessagesChange([...messages, { role: "agent", text: payload.reply || "已更新方案。" }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTimeout(() => listRef.current?.scrollTo({ top: 1e9 }), 50);
    }
  }

  return (
    <div className="agent">
      <div className="agent-msgs" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="bubble agent typing">思考中…</div>}
      </div>
      {error && <div className="agent-err">{error}</div>}
      <div className="agent-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="用自然语言描述你想要的样子…（Ctrl/⌘+Enter 发送）"
          rows={2}
        />
        <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
          {busy ? "生成中…" : "发送"}
        </button>
      </div>
    </div>
  );
}

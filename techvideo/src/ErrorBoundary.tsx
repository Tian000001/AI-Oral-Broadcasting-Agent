import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[TalkStudio ErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: "fixed", inset: 0, background: "#0b0f17", color: "#f87171",
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif',
          padding: 40, whiteSpace: "pre-wrap", overflow: "auto", zIndex: 9999,
        }}>
          <h2 style={{ color: "#f87171", marginTop: 0 }}>口播视频工作台加载失败</h2>
          <p style={{ color: "#c2cad6" }}>请把下面的错误信息复制给开发排查：</p>
          <code style={{ color: "#fff", display: "block", marginTop: 16 }}>
            {this.state.error.stack || this.state.error.message}
          </code>
        </div>
      );
    }
    return this.props.children;
  }
}

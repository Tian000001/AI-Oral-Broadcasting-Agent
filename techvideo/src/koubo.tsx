import React from "react";
import { createRoot } from "react-dom/client";
import TalkStudio from "./TalkStudio";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <TalkStudio />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

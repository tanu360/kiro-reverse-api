import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <main className="p-6">
      <h1 className="font-medium text-base">Kiro Proxy</h1>
    </main>
  </StrictMode>,
);

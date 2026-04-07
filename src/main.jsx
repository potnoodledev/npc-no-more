import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

document.title = import.meta.env.VITE_APP_TITLE || "NPC No More";

// Inject branding colors from env vars into CSS custom properties
const accent = import.meta.env.VITE_ACCENT_COLOR;
if (accent) {
  // Parse hex to RGB
  const hex = accent.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  // Derive dim (80%), bright (lighter), glow (low opacity)
  const dim = `#${Math.round(r * 0.8).toString(16).padStart(2, "0")}${Math.round(g * 0.8).toString(16).padStart(2, "0")}${Math.round(b * 0.8).toString(16).padStart(2, "0")}`;
  const bright = `#${Math.min(255, r + 40).toString(16).padStart(2, "0")}${Math.min(255, g + 40).toString(16).padStart(2, "0")}${Math.min(255, b + 40).toString(16).padStart(2, "0")}`;

  const root = document.documentElement;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-dim", dim);
  root.style.setProperty("--accent-bright", bright);
  root.style.setProperty("--accent-glow", `rgba(${r}, ${g}, ${b}, 0.08)`);
  root.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--success", accent);

  // Update favicon to match accent color
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='${encodeURIComponent(accent)}'/></svg>`;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

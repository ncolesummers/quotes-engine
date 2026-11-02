import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import "./styles/globals.css";

const elem = document.getElementById("root");
if (!elem) throw new Error("Missing #root element");

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// Reuse the root across hot reloads: https://bun.com/docs/bundler/hot-reloading
if (import.meta.hot) {
  const data = import.meta.hot.data as { root?: Root };
  data.root ??= createRoot(elem);
  data.root.render(app);
} else {
  createRoot(elem).render(app);
}

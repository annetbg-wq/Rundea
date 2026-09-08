import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RuntimeMetricsMount } from "./runtime-metrics";
import "./styles.css";
import "./interaction-fixes.css";
import "./runtime-metrics.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App/>
    <RuntimeMetricsMount/>
  </React.StrictMode>,
);

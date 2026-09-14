import React from "react";
import { createRoot } from "react-dom/client";
import CanonicalApp from "./CanonicalApp";
import { GitHubConnectPanel } from "./GitHubConnectPanel";
import "./canonical.css";
import "./github-connect.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CanonicalApp/>
    <GitHubConnectPanel/>
  </React.StrictMode>,
);

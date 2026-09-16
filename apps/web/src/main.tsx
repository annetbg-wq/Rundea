import React from "react";
import { createRoot } from "react-dom/client";
import CanonicalApp from "./CanonicalApp";
import { GitHubConnectPanel } from "./GitHubConnectPanel";
import { PersistentVolumesPanel } from "./PersistentVolumesPanel";
import "./canonical.css";
import "./github-connect.css";
import "./persistent-volumes.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CanonicalApp/>
    <GitHubConnectPanel/>
    <PersistentVolumesPanel/>
  </React.StrictMode>,
);
import React from "react";
import { createRoot } from "react-dom/client";
import CanonicalApp from "./CanonicalApp";
import "./canonical.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CanonicalApp/>
  </React.StrictMode>,
);

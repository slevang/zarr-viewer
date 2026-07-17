import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import { ZarrViewer } from "./ZarrViewer";
import "./globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("Static application root was not found");

createRoot(root).render(
  <StrictMode>
    <ZarrViewer />
  </StrictMode>,
);

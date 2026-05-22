import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Register the service worker (the piece that makes the app installable + offline).
// It only registers in production over HTTPS/localhost, exactly where it's allowed.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // BASE_URL is "/clearmind/" on Pages, "/" in dev — keeps the path correct under a subpath.
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

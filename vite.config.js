import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: `base` must match your GitHub repo name so asset paths resolve under
// https://<username>.github.io/<repo>/ . If your repo is not "clearmind", change the
// one line below to "/<your-repo-name>/" and nothing else needs to change.
export default defineConfig({
  base: "/clearmind/",
  plugins: [react()],
  build: {
    outDir: "dist",
    // Inline nothing as base64 so the service worker can cache real asset files.
    assetsInlineLimit: 0,
  },
});

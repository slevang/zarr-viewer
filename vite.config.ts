import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function crossOriginHeaders() {
  const applyHeaders = (
    request: { url?: string },
    response: {
      removeHeader: (name: string) => void;
      setHeader: (name: string, value: string) => void;
    },
    next: () => void,
  ) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/google-auth.html")) {
      response.setHeader(
        "Cross-Origin-Opener-Policy",
        "same-origin-allow-popups",
      );
      response.removeHeader("Cross-Origin-Embedder-Policy");
    } else {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    next();
  };
  return {
    name: "cross-origin-isolation-with-auth-bridge",
    configureServer(server: {
      middlewares: { use: (handler: typeof applyHeaders) => void };
    }) {
      server.middlewares.use(applyHeaders);
    },
    configurePreviewServer(server: {
      middlewares: { use: (handler: typeof applyHeaders) => void };
    }) {
      server.middlewares.use(applyHeaders);
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [crossOriginHeaders(), react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

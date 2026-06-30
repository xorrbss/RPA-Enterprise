import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// D7 운영 콘솔. vitest(jsdom)로 컴포넌트 스모크. 백엔드 호출은 주입형 ApiClient(포트)로 테스트서 fake 대체.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (!normalized.includes("/node_modules/")) return undefined;
          if (normalized.includes("/node_modules/lucide-react/")) return "vendor-icons";
          if (normalized.includes("/node_modules/@tanstack/react-query/")) return "vendor-query";
          if (normalized.includes("/node_modules/react-dom/") || normalized.includes("/node_modules/react/")) return "vendor-react";
          return "vendor";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    css: false,
  },
});

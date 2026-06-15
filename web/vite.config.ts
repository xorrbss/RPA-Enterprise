import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// D7 운영 콘솔. vitest(jsdom)로 컴포넌트 스모크. 백엔드 호출은 주입형 ApiClient(포트)로 테스트서 fake 대체.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});

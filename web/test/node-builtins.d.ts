// @types/node 미설치 환경에서 테스트가 쓰는 node 빌트인 일부만 선언(런타임은 vitest/node가 제공).
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

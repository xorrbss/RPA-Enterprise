# syntax=docker/dockerfile:1.7

# CI(contract-gates.yml NODE_VERSION=24)와 동일 메이저 — 테스트된 런타임=배포 런타임(R4-2 skew 방지).
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS app-deps
WORKDIR /workspace
COPY app/package.json app/package-lock.json ./app/
RUN npm ci --prefix app --include=dev && npm cache clean --force

# 런타임은 codegen 산출물(validators/transitions/…)을 직접 임포트하고 validators 는 ajv 를 요구한다.
# app/node_modules 는 /workspace/codegen/*.ts 의 해석 경로가 아니므로(Node 는 codegen/node_modules → /node_modules
# 로만 올라간다) codegen 의 프로덕션 의존을 별도로 설치해 이미지에 넣는다.
FROM node:${NODE_VERSION} AS codegen-deps
WORKDIR /workspace
COPY codegen/package.json codegen/package-lock.json ./codegen/
RUN npm ci --prefix codegen --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION} AS web-deps
WORKDIR /workspace
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci && npm cache clean --force

FROM web-deps AS web-build
WORKDIR /workspace
ARG VITE_API_BASE_URL=/api
ARG VITE_OIDC_AUTH_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_OIDC_AUTH_URL=${VITE_OIDC_AUTH_URL}
# 콘솔은 레포 루트의 계약 패키지를 직접 임포트한다(web/src/views/security/RbacMatrixPanel.tsx → ../../../../ts/rbac-policy).
# web/ 만 복사하면 tsc/vite 가 그 모듈을 못 찾아 콘솔 이미지 빌드가 통째로 실패한다.
COPY ts ./ts
COPY web ./web
RUN npm --prefix web run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS console-runtime
ENV RPA_API_UPSTREAM=http://rpa-api:8080
COPY deploy/nginx/console.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /workspace/web/dist /usr/share/nginx/html
EXPOSE 8080

FROM node:${NODE_VERSION} AS runtime
WORKDIR /workspace

ENV NODE_ENV=production \
    RUN_MODE=api \
    PORT=8080 \
    HEALTH_PORT=8081 \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-noto-cjk \
      postgresql-client \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=app-deps /workspace/app/node_modules ./app/node_modules
COPY app/package.json app/package-lock.json ./app/
COPY app/src ./app/src
COPY codegen ./codegen
COPY --from=codegen-deps /workspace/codegen/node_modules ./codegen/node_modules
COPY db ./db
COPY gateway ./gateway
COPY schema ./schema
COPY security ./security
COPY scripts ./scripts
COPY ts ./ts

RUN mkdir -p /var/lib/rpa/artifacts \
    && chown -R node:node /workspace /var/lib/rpa

USER node
EXPOSE 8080 8081

ENTRYPOINT ["tini", "--"]
CMD ["npm", "--prefix", "app", "run", "start"]

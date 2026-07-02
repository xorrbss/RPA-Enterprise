# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20-bookworm-slim

FROM node:${NODE_VERSION} AS app-deps
WORKDIR /workspace
COPY app/package.json app/package-lock.json ./app/
RUN npm ci --prefix app --include=dev && npm cache clean --force

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

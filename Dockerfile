# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20-bookworm-slim

FROM node:${NODE_VERSION} AS app-deps
WORKDIR /workspace
COPY app/package.json app/package-lock.json ./app/
RUN npm ci --prefix app --include=dev && npm cache clean --force

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

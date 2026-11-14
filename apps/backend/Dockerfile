# syntax=docker/dockerfile:1
#
# minidock app for the Flixa API (built from git, deniaiapp/flixa)
#   Dockerfile path: apps/backend/Dockerfile
#   Docker context:  . (the monorepo root; apps/backend/Dockerfile.dockerignore applies)
#   Port:            3000
#
# Local (from the monorepo root):
#   docker build -f apps/backend/Dockerfile -t flixa-backend .
#   docker run --rm -p 3000:3000 --env-file apps/backend/.env flixa-backend

FROM node:26-alpine AS deps

WORKDIR /app

# Matches `packageManager` in the root package.json (lockfile format and settings).
RUN npm install -g pnpm@12.18.0

# Every workspace manifest is copied so the frozen lockfile matches; only the
# backend is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json apps/vscode/webview-ui/package.json packages/*/package.json ./
# Dev dependencies are needed for the esbuild step. Install scripts are skipped:
# the bundle only needs sources. The pnpm store is a BuildKit cache mount shared
# with the other projects (id=pnpm-store).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts --filter "@deniai/flixa-backend..." --store-dir=/pnpm/store

FROM deps AS build

WORKDIR /app/apps/backend

COPY apps/backend/server.ts apps/backend/app.ts apps/backend/tsconfig.json ./
COPY apps/backend/middleware ./middleware
COPY apps/backend/routes ./routes
COPY apps/backend/utils ./utils

RUN node_modules/.bin/esbuild server.ts --bundle --platform=node --format=esm --target=node26 \
  --outdir=./dist --external:pg-native --minify \
  --banner:js="import { createRequire as __flixaCreateRequire } from 'node:module'; const require = __flixaCreateRequire(import.meta.url);"

# Distroless: Node.js and its runtime libraries only (no shell, package manager,
# or npm). The `nonroot` tag runs as uid 65532 and its entrypoint is `node`.
# For an interactive shell while debugging, swap in the `debug-nonroot` tag.
FROM gcr.io/distroless/nodejs26-debian13:nonroot AS app

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Self-contained ESM bundle; .mjs so Node does not need a package.json "type".
COPY --from=build /app/apps/backend/dist/server.js ./server.mjs

EXPOSE 3000

# The image's entrypoint is already `node`, so CMD carries only the script.
CMD ["server.mjs"]

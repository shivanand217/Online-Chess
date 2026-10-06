# Multi-stage build: pnpm install + tsup bundle in a fat image, then copy just dist/ into a slim runtime.
# tsup's `noExternal: [/.*/]` bundles every dep into dist, so the runtime image needs no node_modules.
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chess/gateway build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /repo/apps/gateway/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
# `--import ./dist/tracing.js` loads the OTel SDK before any instrumented module is first imported.
CMD ["--import", "./dist/tracing.js", "dist/index.js"]

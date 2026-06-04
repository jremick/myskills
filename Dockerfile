# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-alpine
ARG NPM_VERSION=11.12.1

FROM node:${NODE_VERSION} AS deps
ARG NPM_VERSION
WORKDIR /app
RUN npm install -g npm@${NPM_VERSION}
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci

FROM deps AS api-build
RUN npm run build -w @ai-skills-share/core \
  && npm run build -w @ai-skills-share/auth \
  && npm run build -w @ai-skills-share/skill-package \
  && npm run build -w @ai-skills-share/api
RUN npm prune --omit=dev

FROM deps AS mcp-build
RUN npm run build -w @ai-skills-share/core \
  && npm run build -w @ai-skills-share/mcp
RUN npm prune --omit=dev

FROM deps AS web-build
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN node -e "const value = process.env.VITE_API_BASE_URL; if (!value) throw new Error('VITE_API_BASE_URL build arg is required for the web image.'); const url = new URL(value); const local = ['localhost','127.0.0.1','::1'].includes(url.hostname); if (url.protocol !== 'https:' && !local) throw new Error('VITE_API_BASE_URL must use https outside local builds.');"
RUN npm run build -w @ai-skills-share/core \
  && npm run build -w @ai-skills-share/web

FROM node:${NODE_VERSION} AS api
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=api-build /app/package.json /app/package-lock.json ./
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/packages ./packages
COPY --from=api-build /app/apps/api/package.json ./apps/api/package.json
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
COPY --from=api-build /app/apps/api/migrations ./apps/api/migrations
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM node:${NODE_VERSION} AS mcp-http
ENV NODE_ENV=production \
    AI_SKILLS_MCP_HOST=0.0.0.0 \
    AI_SKILLS_MCP_PORT=3002
WORKDIR /app
COPY --from=mcp-build /app/package.json /app/package-lock.json ./
COPY --from=mcp-build /app/node_modules ./node_modules
COPY --from=mcp-build /app/packages ./packages
COPY --from=mcp-build /app/apps/mcp/package.json ./apps/mcp/package.json
COPY --from=mcp-build /app/apps/mcp/dist ./apps/mcp/dist
USER node
EXPOSE 3002
CMD ["node", "apps/mcp/dist/http-index.js"]

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

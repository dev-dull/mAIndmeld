# mAIndmeld server image. No build step and no runtime dependencies, so a
# single small stage is enough. Runs as the unprivileged node user with
# /data as the only writable location.

FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

ENV NODE_ENV=production \
    MAINDMELD_DATA_DIR=/data \
    MAINDMELD_BIND=0.0.0.0 \
    MAINDMELD_PORT=7340

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 7340

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:7340/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/maindmeld.js", "serve"]

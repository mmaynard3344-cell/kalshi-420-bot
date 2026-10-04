FROM node:24-alpine
WORKDIR /app
COPY artifacts/btc-shadow/*.mjs ./artifacts/btc-shadow/
COPY artifacts/btc-perp-shadow/*.mjs ./artifacts/btc-perp-shadow/
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "artifacts/btc-perp-shadow/index.mjs"]

FROM node:24-alpine
WORKDIR /app
COPY artifacts/btc-shadow/*.mjs ./artifacts/btc-shadow/
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "artifacts/btc-shadow/index.mjs"]

FROM node:24-alpine
WORKDIR /app
COPY artifacts/btc-shadow/*.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "index.mjs"]

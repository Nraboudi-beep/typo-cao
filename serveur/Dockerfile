FROM node:22-alpine
WORKDIR /app
COPY server.js .
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "server.js"]

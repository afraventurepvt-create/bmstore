FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY server.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]

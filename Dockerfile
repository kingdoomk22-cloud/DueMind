FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY index.html 404.html app.js styles.css ./
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DUEMIND_DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]

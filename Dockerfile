FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DB_FILE=/data/shop.db
VOLUME /data
EXPOSE 3000
CMD ["node","--no-warnings","server.js"]

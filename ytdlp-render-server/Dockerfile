FROM node:18-alpine

# Install Python and FFmpeg (required for yt-dlp)
RUN apk add --no-cache python3 ffmpeg

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY server.js .

EXPOSE 9000

CMD ["node", "server.js"]

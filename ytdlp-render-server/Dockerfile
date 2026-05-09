FROM node:18-alpine

# Install Python and FFmpeg (required for yt-dlp)
RUN apk add --no-cache python3 ffmpeg wget

# Install latest yt-dlp natively
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY server.js .

EXPOSE 9000

CMD ["node", "server.js"]

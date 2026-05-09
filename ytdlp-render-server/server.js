const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const output = await youtubedl(url, {
      dumpJson: true,
      noWarnings: true,
      preferFreeFormats: true,
      extractorArgs: "youtube:player_client=ios,web_creator,tv",
    });

    // Mimic the Cobalt API response structure so Cloudflare proxy doesn't need changing
    let videoUrl = null;
    let audioUrl = null;

    if (output.formats) {
      // Find the best video and audio formats
      const videoFormats = output.formats.filter(f => f.hasVideo && f.vcodec !== 'none');
      const audioFormats = output.formats.filter(f => !f.hasVideo && f.acodec !== 'none');
      
      if (videoFormats.length > 0) videoUrl = videoFormats[videoFormats.length - 1].url;
      if (audioFormats.length > 0) audioUrl = audioFormats[audioFormats.length - 1].url;
    }

    res.json({
      status: "success",
      url: req.body.isAudioOnly ? (audioUrl || output.url) : (videoUrl || output.url),
      title: output.title,
      thumbnail: output.thumbnail,
    });
  } catch (err) {
    console.error("YTDLP Error:", err.message);
    res.status(500).json({ status: "error", error: { code: err.message } });
  }
});

app.get('/wake', (req, res) => res.send('Awake!'));

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => console.log(`YT-DLP Server listening on port ${PORT}`));


const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const app = express();
const runFile = promisify(execFile);

const PORT = process.env.PORT || 3000;
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_DURATION = 60;
const VIDEO_DIR = path.join(os.tmpdir(), "primfed-videos");

fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({ status: "Primfed video processor is running" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function authenticate(req, res, next) {
  const key = process.env.PRIMFED_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: "Server API key is not configured"
    });
  }

  if (req.get("x-api-key") !== key) {
    return res.status(401).json({
      error: "Invalid API key"
    });
  }

  next();
}

async function downloadVideo(url, destination) {
  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    throw new Error("Video URL must use HTTPS");
  }

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error("Could not download the source video");
  }

  if (!response.body) {
    throw new Error("The source video is empty");
  }

  const declaredSize = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredSize > MAX_SIZE) {
    throw new Error("Video exceeds the 10 MB limit");
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.length;

    if (total > MAX_SIZE) {
      throw new Error("Video exceeds the 10 MB limit");
    }

    chunks.push(chunk);
  }

  if (total === 0) {
    throw new Error("The source video is empty");
  }

  await fs.promises.writeFile(
    destination,
    Buffer.concat(chunks)
  );
}

app.post("/process", authenticate, async (req, res) => {
  const sourceUrl = req.body?.source_video_url;

  if (typeof sourceUrl !== "string") {
    return res.status(400).json({
      error: "source_video_url is required"
    });
  }

  let parsed;

  try {
    parsed = new URL(sourceUrl);
  } catch {
    return res.status(400).json({
      error: "Invalid video URL"
    });
  }

  if (parsed.protocol !== "https:") {
    return res.status(400).json({
      error: "HTTPS URLs are required"
    });
  }

  const id = crypto.randomUUID();
  const folder = path.join(VIDEO_DIR, id);
  const input = path.join(folder, "source.mp4");
  const playlist = path.join(folder, "index.m3u8");

  try {
    await fs.promises.mkdir(folder, { recursive: true });

    await downloadVideo(sourceUrl, input);

    const probe = await runFile("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      input
    ], { timeout: 20000 });

    const duration = Number(probe.stdout.trim());

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine video duration");
    }

    if (duration > MAX_DURATION) {
      throw new Error("Video exceeds 60 seconds");
    }

    await runFile("ffmpeg", [
      "-y",
      "-i", input,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-f", "hls",
      "-hls_time", "1",
      "-hls_playlist_type", "vod",
      "-hls_segment_filename",
      path.join(folder, "segment_%03d.ts"),
      playlist
    ], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024
    });

    await fs.promises.unlink(input);

    return res.json({
      status: "processed",
      job_id: id,
      duration_seconds: duration,
      manifest_url: `/videos/${id}/index.m3u8`
    });
  } catch (error) {
    await fs.promises.rm(folder, {
      recursive: true,
      force: true
    });

    console.error("Primfed processing error:", error);

    return res.status(400).json({
      error: error.message || "Video processing failed"
    });
  }
});

app.get("/videos/:id/:file", async (req, res) => {
  const { id, file } = req.params;

  if (
    !/^[a-f0-9-]{36}$/i.test(id) ||
    !/^(index\.m3u8|segment_\d+\.ts)$/.test(file)
  ) {
    return res.sendStatus(404);
  }

  const filename = path.join(VIDEO_DIR, id, file);

  try {
    await fs.promises.access(filename);
  } catch {
    return res.sendStatus(404);
  }

  res.type(
    file.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t"
  );

  res.sendFile(filename);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Primfed server listening on port ${PORT}`);
});

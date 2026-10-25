
"use strict";

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const app = express();
const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PRIMFED_API_KEY;
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_DURATION = 60;
const VIDEO_DIR = path.join(os.tmpdir(), "primfed-videos");

fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    service: "Primfed Video Processor",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function authenticate(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "PRIMFED_API_KEY is not configured"
    });
  }

  if (req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function safePublicHttpsUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;

    // Only allow your Bubble file host here.
    // Replace this with your verified Bubble storage hostname.
    const allowedHost = process.env.ALLOWED_VIDEO_HOST;

    if (!allowedHost || url.hostname !== allowedHost) return false;

    return true;
  } catch {
    return false;
  }
}

async function downloadVideo(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    redirect: "error"
  });

  if (!response.ok || !response.body) {
    throw new Error("Could not download the source video");
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength > MAX_SIZE) {
    throw new Error("Video exceeds the 10 MB limit");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_SIZE) {
        await reader.cancel();
        throw new Error("Video exceeds the 10 MB limit");
      }

      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    throw error;
  }

  await fs.promises.writeFile(destination, Buffer.concat(chunks));
}

app.post("/process", authenticate, async (req, res) => {
  const sourceUrl = req.body && req.body.source_video_url;

  if (typeof sourceUrl !== "string" || !safePublicHttpsUrl(sourceUrl)) {
    return res.status(400).json({
      error: "Provide a valid HTTPS video URL from the configured allowed host"
    });
  }

  const id = crypto.randomUUID();
  const workDir = path.join(VIDEO_DIR, id);
  const inputPath = path.join(workDir, "source.mp4");
  const playlistPath = path.join(workDir, "index.m3u8");

  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    await downloadVideo(sourceUrl, inputPath);

    const probe = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath
    ]);

    const duration = Number(probe.stdout.trim());

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine video duration");
    }

    if (duration > MAX_DURATION) {
      throw new Error("Video must be 60 seconds or shorter");
    }

    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vf", "scale=w='min(720,iw)':h=-2",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-hls_time", "2",
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", path.join(workDir, "segment_%03d.ts"),
      playlistPath
    ], { timeout: 240000, maxBuffer: 1024 * 1024 * 4 });

    const files = await fs.promises.readdir(workDir);
    const segmentCount = files.filter(file => /^segment_\d+\.ts$/.test(file)).length;

    if (!files.includes("index.m3u8") || segmentCount === 0) {
      throw new Error("FFmpeg did not create the expected video segments");
    }

    await fs.promises.unlink(inputPath);

    const baseUrl = process.env.PUBLIC_BASE_URL;

    if (!baseUrl) {
      throw new Error("PUBLIC_BASE_URL is not configured");
    }

    res.json({
      status: "processed",
      job_id: id,
      duration_seconds: duration,
      segment_count: segmentCount,
      manifest_url: `${baseUrl.replace(/\/$/, "")}/videos/${id}/index.m3u8`
    });
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true });

    res.status(400).json({
      error: error.message || "Video processing failed"
    });
  }
});

app.get("/videos/:id/:file", async (req, res) => {
  const { id, file } = req.params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).send("Invalid video ID");
  }

  if (file !== "index.m3u8" && !/^segment_\d+\.ts$/.test(file)) {
    return res.status(404).send("File not found");
  }

  const filePath = path.join(VIDEO_DIR, id, file);

  try {
    await fs.promises.access(filePath);

    res.setHeader(
      "Content-Type",
      file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t"
    );

    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(filePath);
  } catch {
    res.status(404).send("Video file not found");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Primfed Video Processor listening on ${PORT}`);
});

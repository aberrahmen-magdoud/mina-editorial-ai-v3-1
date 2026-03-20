// server/mma/mma-ugc-stitch.js — ffmpeg-based clip stitching for UGC pipeline
"use strict";

import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { storeRemoteToR2Public, getR2, guessExt } from "./mma-r2.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Point fluent-ffmpeg to the bundled binary
ffmpeg.setFfmpegPath(ffmpegStatic);

// ============================================================================
// Download a remote URL to a local file
// ============================================================================
async function downloadToFile(url, localPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`STITCH_DOWNLOAD_FAILED_${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(localPath, buf);
  return localPath;
}

// ============================================================================
// Upload a local file buffer to R2
// ============================================================================
async function uploadFileToR2(localPath, r2Key, contentType) {
  const { enabled, client, bucket, publicBase } = getR2();
  if (!enabled || !client) throw new Error("R2_NOT_CONFIGURED");

  const buf = await fs.readFile(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: buf,
      ContentType: contentType || "video/mp4",
    })
  );

  return `${publicBase.replace(/\/$/, "")}/${r2Key}`;
}

// ============================================================================
// ffmpeg concat — all Kling clips share the same codec so -c copy works
// ============================================================================
function ffmpegConcat(concatFilePath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFilePath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

// ============================================================================
// ffmpeg audio overlay — mix stitched video with audio track
// ============================================================================
function ffmpegAddAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

// ============================================================================
// stitchClips — download clips → concat → optional audio → upload to R2
// ============================================================================
export async function stitchClips({ clipUrls, audioUrl, r2KeyPrefix }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-stitch-"));

  try {
    // 1. Download all clips to temp
    const localClips = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const localPath = path.join(tmpDir, `clip-${i}.mp4`);
      await downloadToFile(clipUrls[i], localPath);
      localClips.push(localPath);
    }

    // 2. Build ffmpeg concat list
    const concatFile = path.join(tmpDir, "concat.txt");
    const concatContent = localClips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await fs.writeFile(concatFile, concatContent);

    // 3. Concat clips
    const stitchedPath = path.join(tmpDir, "stitched.mp4");
    await ffmpegConcat(concatFile, stitchedPath);

    // 4. Optional audio overlay
    let finalPath = stitchedPath;
    if (audioUrl && typeof audioUrl === "string" && audioUrl.startsWith("http")) {
      const audioExt = audioUrl.includes(".wav") ? ".wav" : audioUrl.includes(".m4a") ? ".m4a" : ".mp3";
      const audioPath = path.join(tmpDir, `audio${audioExt}`);
      await downloadToFile(audioUrl, audioPath);

      finalPath = path.join(tmpDir, "final.mp4");
      await ffmpegAddAudio(stitchedPath, audioPath, finalPath);
    }

    // 5. Upload final to R2
    const r2Key = `${r2KeyPrefix || "mma/ugc"}/final.mp4`;
    const publicUrl = await uploadFileToR2(finalPath, r2Key, "video/mp4");
    return publicUrl;
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

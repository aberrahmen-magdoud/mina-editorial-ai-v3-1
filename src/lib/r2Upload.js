// src/lib/r2Upload.js
// MMA upload flow: presign PUT -> upload -> return permanent publicUrl
// Server returns { key, putUrl, publicUrl } (no expiring GET links)

export async function presignR2Upload({
  apiBase = "", // e.g. "" if same origin, or "https://api.yourdomain.com"
  kind = "mma",
  contentType,
  customerId = "anon",
  filename = "upload",
}) {
  if (!contentType) throw new Error("presignR2Upload: contentType is required");

  const resp = await fetch(`${apiBase}/api/r2/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, contentType, customerId, filename }),
  });

  if (!resp.ok) {
    const msg = await safeReadJson(resp);
    throw new Error(msg?.error || `PRESIGN_FAILED_${resp.status}`);
  }

  return resp.json(); // { key, putUrl, publicUrl }
}

export async function uploadFileToR2({
  file, // File or Blob
  apiBase = "",
  kind = "mma",
  customerId = "anon",
  filename, // optional
  onProgress, // optional (best-effort)
}) {
  if (!file) throw new Error("uploadFileToR2: file is required");

  const contentType = file.type || "application/octet-stream";
  const name = filename || file.name || "upload";

  const { key, putUrl, publicUrl } = await presignR2Upload({
    apiBase,
    kind,
    contentType,
    customerId,
    filename: name,
  });

  // Simple PUT upload
  // NOTE: fetch doesn't expose upload progress well; onProgress is best-effort only.
  const putResp = await fetch(putUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      // CacheControl/Disposition are already baked into the signed command,
      // but sending content-type here helps correctness.
    },
    body: file,
  });

  if (!putResp.ok) {
    throw new Error(`R2_PUT_FAILED_${putResp.status}`);
  }

  // Some callers like both:
  return { key, publicUrl, url: publicUrl };
}

export function putWithProgress(putUrl, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", putUrl, true);
    xhr.setRequestHeader("Content-Type", contentType || "application/octet-stream");

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      onProgress?.(evt.loaded / evt.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(true);
      else reject(new Error(`R2_PUT_FAILED_${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("R2_PUT_NETWORK_ERROR"));
    xhr.send(file);
  });
}

async function safeReadJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

const fs = require("fs/promises");

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTimestampForName(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + "_" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function sanitizeUploadName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 120);
}

function buildUploadName(messageId, date) {
  const timestamp = formatTimestampForName(date || new Date());
  const suffix = sanitizeUploadName(messageId).substring(0, 32);
  return suffix ? timestamp + "_" + suffix : timestamp;
}

async function uploadBufferToImgbb(buffer, apiKey, uploadName) {
  if (!apiKey) {
    return {
      host: "",
      url: "",
      error: "IMGBB_API_KEY is not configured."
    };
  }

  const body = new URLSearchParams({
    key: apiKey,
    image: Buffer.from(buffer).toString("base64")
  });
  if (uploadName) {
    body.set("name", sanitizeUploadName(uploadName));
  }

  const response = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.success || !data.data) {
    throw new Error(data.error && data.error.message ? data.error.message : "imgbb upload failed.");
  }
  return {
    host: "imgbb",
    url: data.data.url,
    error: ""
  };
}

async function uploadFileToImgbb(filePath, apiKey, uploadName) {
  return uploadBufferToImgbb(await fs.readFile(filePath), apiKey, uploadName);
}

module.exports = {
  buildUploadName,
  uploadBufferToImgbb,
  uploadFileToImgbb
};

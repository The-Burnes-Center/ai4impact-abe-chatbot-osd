import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.BUCKET;
const EXPIRATION_SECONDS = 3600;

const CONTENT_TYPE_MAP = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

// Files Bedrock cites are uploaded with these extensions; anything else (e.g.
// random binaries) is rejected so an authenticated user cannot pull arbitrary
// objects out of the KB bucket.
const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPE_MAP));
const SAFE_KEY = /^[a-zA-Z0-9._\-/ ()&,+]+$/;

// System files that must never be handed out via a presigned URL even though
// their extension is otherwise allowed. `metadata.txt` is the auto-generated
// document inventory (every filename + AI summary); exposing it would let any
// authenticated user enumerate the whole KB and then pull each document.
const BLOCKED_BASENAMES = new Set(["metadata.txt"]);

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const s3Key = body.s3Key;

    if (!s3Key || typeof s3Key !== "string") {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "s3Key is required" }) };
    }

    if (s3Key.includes("..") || s3Key.startsWith("/") || !SAFE_KEY.test(s3Key)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid key" }) };
    }

    const basename = (s3Key.split("/").pop() || "").toLowerCase();
    if (BLOCKED_BASENAMES.has(basename)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid key" }) };
    }

    const ext = s3Key.split(".").pop()?.toLowerCase() || "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "File type not allowed" }) };
    }
    const contentType = CONTENT_TYPE_MAP[ext] || "application/octet-stream";

    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ResponseContentDisposition: "inline",
        ResponseContentType: contentType,
      }),
      { expiresIn: EXPIRATION_SECONDS }
    );

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ signedUrl }) };
  } catch (err) {
    console.error("Failed to generate signed URL:", err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Failed to generate signed URL" }) };
  }
};

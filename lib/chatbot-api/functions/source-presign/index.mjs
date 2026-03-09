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

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const s3Key = body.s3Key;

    if (!s3Key || typeof s3Key !== "string") {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "s3Key is required" }) };
    }

    if (s3Key.includes("..")) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid key" }) };
    }

    const ext = s3Key.split(".").pop()?.toLowerCase() || "";
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

/**
 * Trade Index REST API: status, preview, upload-url.
 * Admin-only (JWT authorizer on routes).
 */
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const lambda = new LambdaClient({});
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const QUERY_FUNCTION = process.env.TRADE_INDEX_QUERY_FUNCTION;
const BUCKET = process.env.BUCKET;
const URL_EXPIRATION_SECONDS = 300;
const FIXED_KEY = "trade-index/latest.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function checkAdmin(event) {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims || !claims["custom:role"]) return false;
    const roles = JSON.parse(claims["custom:role"]);
    return Array.isArray(roles) && roles.some((r) => String(r).includes("Admin"));
  } catch (e) {
    return false;
  }
}

export const handler = async (event) => {
  if (!checkAdmin(event)) {
    return jsonResponse(403, { message: "Not authorized" });
  }

  const path = event.rawPath || event.requestContext?.http?.path || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "";

  try {
    if (path.endsWith("/status") && (method === "GET" || method === "OPTIONS")) {
      if (method === "OPTIONS") return jsonResponse(200, "");
      const payload = JSON.stringify({ action: "status" });
      const cmd = new InvokeCommand({ FunctionName: QUERY_FUNCTION, Payload: payload, InvocationType: "RequestResponse" });
      const resp = await lambda.send(cmd);
      const body = resp.Payload ? Buffer.from(resp.Payload).toString() : "{}";
      const parsed = JSON.parse(body);
      const statusCode = parsed.statusCode ?? 200;
      const bodyStr = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? {});
      return { statusCode, headers: corsHeaders, body: bodyStr };
    }

    if (path.endsWith("/preview") && (method === "GET" || method === "OPTIONS")) {
      if (method === "OPTIONS") return jsonResponse(200, "");
      const payload = JSON.stringify({ action: "preview", preview_rows: 10 });
      const cmd = new InvokeCommand({ FunctionName: QUERY_FUNCTION, Payload: payload, InvocationType: "RequestResponse" });
      const resp = await lambda.send(cmd);
      const body = resp.Payload ? Buffer.from(resp.Payload).toString() : "{}";
      const parsed = JSON.parse(body);
      const statusCode = parsed.statusCode ?? 200;
      const bodyStr = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? {});
      return { statusCode, headers: corsHeaders, body: bodyStr };
    }

    if (path.endsWith("/upload-url") && (method === "POST" || method === "OPTIONS")) {
      if (method === "OPTIONS") return jsonResponse(200, "");
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: FIXED_KEY, ContentType: XLSX_MIME });
      const signedUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRATION_SECONDS });
      return jsonResponse(200, { signedUrl });
    }

    return jsonResponse(404, { error: "Not found" });
  } catch (err) {
    console.error("Trade index API error:", err);
    return jsonResponse(500, { error: err.message || "Internal error" });
  }
};

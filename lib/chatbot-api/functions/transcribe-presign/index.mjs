/**
 * TranscribePresignFunction
 *
 * Returns a short-lived, SigV4 query-presigned WebSocket URL for Amazon
 * Transcribe streaming. The browser opens this URL directly to stream
 * microphone audio and receive live transcripts — no AWS credentials ever
 * reach the client (the dictation feature replaced the browser Web Speech
 * API, which is blocked on the OSD network because it streams audio to
 * Google's servers; Transcribe keeps audio inside this AWS account).
 *
 * The URL is signed with this Lambda's execution-role credentials (which are
 * temporary, so the session token must be folded into the canonical query
 * string before signing). SigV4 is implemented with node:crypto so the
 * function has zero external dependencies.
 *
 * Auth: route is behind the HTTP API JWT authorizer, so only signed-in users
 * can mint a URL. The URL itself is valid for EXPIRES seconds (time to OPEN
 * the socket); once connected the stream may run for the Transcribe session
 * limit.
 */
import { createHash, createHmac } from "node:crypto";

const REGION = process.env.AWS_REGION || "us-east-1";
const LANGUAGE_CODE = process.env.LANGUAGE_CODE || "en-US";
const SAMPLE_RATE = process.env.SAMPLE_RATE || "16000";
const EXPIRES = 300; // seconds the presigned URL stays valid for opening the socket

const SERVICE = "transcribe";
const HOST = `transcribestreaming.${REGION}.amazonaws.com:8443`;
const ENDPOINT_PATH = "/stream-transcription-websocket";
const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("", "utf8").digest("hex");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256hex(data) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// RFC 3986 unreserved-only encoding (encodeURIComponent leaves !'()* unescaped).
function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export const handler = async () => {
  try {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!accessKey || !secretKey) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Lambda credentials unavailable" }),
      };
    }

    // amzDate: YYYYMMDDTHHMMSSZ, dateStamp: YYYYMMDD
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    // SigV4 query params. The security token (temp creds) MUST be part of the
    // canonical query string that gets signed, not appended afterwards.
    const params = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKey}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(EXPIRES),
      ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
      "X-Amz-SignedHeaders": "host",
      "language-code": LANGUAGE_CODE,
      "media-encoding": "pcm",
      "sample-rate": SAMPLE_RATE,
    };

    // Canonical query string: keys sorted, every key and value URI-encoded.
    const canonicalQuerystring = Object.keys(params)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
      .join("&");

    const canonicalRequest = [
      "GET",
      ENDPOINT_PATH,
      canonicalQuerystring,
      `host:${HOST}\n`,
      "host",
      EMPTY_PAYLOAD_SHA256,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256hex(canonicalRequest),
    ].join("\n");

    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign, "utf8")
      .digest("hex");

    const url = `wss://${HOST}${ENDPOINT_PATH}?${canonicalQuerystring}&X-Amz-Signature=${signature}`;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        url,
        sampleRate: Number(SAMPLE_RATE),
        languageCode: LANGUAGE_CODE,
      }),
    };
  } catch (err) {
    console.error("Failed to presign Transcribe URL:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to presign Transcribe URL" }),
    };
  }
};

// Import necessary modules
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, ListKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent';

const s3Client = new S3Client();
const bedrockAgentClient = new BedrockAgentClient({});

// In-warm-container cache for the Bedrock sync-status map. Bedrock's
// ListKnowledgeBaseDocuments is the dominant cost on this Lambda (~500ms
// per 100 docs, sequential pagination), so caching for a short TTL turns
// repeat tab loads into single-digit-ms responses. Per-Lambda-container
// (not shared), which is fine: each admin's repeat loads benefit.
const SYNC_STATUS_TTL_MS = 30_000;
let syncStatusCache = null;

/**
 * Map Bedrock KB's per-document status to the 4 states the admin UI cares
 * about. Bedrock's status vocabulary is broader (includes things like
 * METADATA_PARTIAL_FAILURE) but admins only need to know: is this doc in
 * the KB, on its way in, broken, or never tried?
 */
function mapBedrockStatus(s) {
  if (!s) return 'not_yet_synced';
  if (s === 'INDEXED') return 'synced';
  if (s === 'STARTING' || s === 'IN_PROGRESS') return 'syncing';
  if (
    s === 'FAILED' ||
    s === 'METADATA_PARTIAL_FAILURE' ||
    s === 'METADATA_UPDATE_FAILED'
  ) return 'failed';
  // PENDING, DELETING, NOT_FOUND, IGNORED, etc. → effectively "not in the
  // index right now and not on the way" from an admin perspective.
  return 'not_yet_synced';
}

/**
 * Load per-document sync status from Bedrock KB, keyed by S3 object key
 * (the same key the listing returns). Returns an empty map if Bedrock can't
 * be reached or no KB is configured -- the document list still renders, it
 * just won't have a status chip until next refresh.
 */
async function fetchSyncStatusMap(kbId, dataSourceId, bucket) {
  const map = {};
  if (!kbId || !dataSourceId) {
    console.warn('KB_ID or DATA_SOURCE_ID not set; skipping sync-status lookup');
    return map;
  }
  const expectedPrefix = `s3://${bucket}/`;
  try {
    let nextToken;
    do {
      const resp = await bedrockAgentClient.send(new ListKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: kbId,
        dataSourceId: dataSourceId,
        maxResults: 100,
        nextToken,
      }));
      for (const doc of resp.documentDetails || []) {
        const uri = doc?.identifier?.s3?.uri;
        if (!uri || !uri.startsWith(expectedPrefix)) continue;
        const key = uri.slice(expectedPrefix.length);
        map[key] = mapBedrockStatus(doc.status);
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (e) {
    // Don't fail the whole page load just because the status column can't
    // be hydrated. The status chip will fall back to "not_yet_synced" which
    // is the safe ambiguous state.
    console.warn('Could not load KB document status:', e?.message || e);
  }
  return map;
}

async function getSyncStatusMap(kbId, dataSourceId, bucket, { bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && syncStatusCache && now - syncStatusCache.fetchedAt < SYNC_STATUS_TTL_MS) {
    return { map: syncStatusCache.map, cached: true, age: now - syncStatusCache.fetchedAt };
  }
  const map = await fetchSyncStatusMap(kbId, dataSourceId, bucket);
  syncStatusCache = { map, fetchedAt: now };
  return { map, cached: false, age: 0 };
}

/**
 * True when a summary is missing or is a known failure artifact rather than a
 * real document summary. Mirrors `_is_placeholder_summary` in the
 * sync-orchestrator Lambda (lambda_function.py) -- keep the two in sync so
 * the admin UI "Missing" chip agrees with what the backfill will regenerate.
 *
 * Artifacts: explicit error markers ("Error generating summary"), and LLM
 * filler produced when summarization ran before KB ingestion ("No relevant
 * document content was found in the knowledge base...").
 */
function isPlaceholderSummary(summary) {
  if (typeof summary !== 'string') return true;
  const s = summary.trim().toLowerCase();
  if (!s) return true;
  if (s.startsWith('error ')) return true;
  if (
    s.includes('knowledge base') &&
    ['no relevant', 'could not be retrieved', 'could not be analyzed', 'not found', 'no text', 'cannot be provided']
      .some((marker) => s.includes(marker))
  ) {
    return true;
  }
  return false;
}

/**
 * Load the metadata.txt index from the KB bucket and return a map of
 * filename → boolean indicating whether that file has a real `summary`.
 *
 * metadata.txt is maintained by the metadata-handler Lambda and looks like:
 *   { "ITC80.pdf": { "summary": "...", "tag_category": "user guide" },
 *     "FAC120.pdf": {} }
 *
 * A file is considered to have metadata only when its entry contains a real
 * summary -- empty values, error markers, and pre-ingestion LLM filler all
 * count as missing so the UI reflects what the hourly backfill will redo.
 * Files missing from the map are treated as having no metadata yet.
 */
async function loadMetadataPresenceMap(bucket) {
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: 'metadata.txt' }));
    const body = await resp.Body.transformToString();
    const parsed = JSON.parse(body);
    const map = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (key === 'metadata.txt') continue;
      const summary = entry && typeof entry === 'object' ? entry.summary : null;
      map[key] = !isPlaceholderSummary(summary);
    }
    return map;
  } catch (e) {
    console.warn('Could not load metadata.txt for presence map:', e?.message || e);
    return {};
  }
}

async function listAllObjects(bucket) {
  const out = [];
  let continuationToken;
  do {
    const result = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }));
    for (const obj of result.Contents || []) {
      if (obj.Key && obj.Key !== 'metadata.txt') out.push(obj);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

function isAdmin(event) {
  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const roles = JSON.parse(claims['custom:role']);
    return Array.isArray(roles) && roles.includes('Admin');
  } catch {
    return null;
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
};

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS' || event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({}) };
  }

  const admin = isAdmin(event);
  if (admin === null) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: 'Unable to check user role, please ensure you have Cognito configured correctly with a custom:role attribute.' }),
    };
  }
  if (!admin) {
    return {
      statusCode: 403,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: 'User is not authorized to perform this action' }),
    };
  }

  const s3Bucket = process.env.BUCKET;

  // Parse body once; we accept either {} or { mode: "files" | "syncStatus" | "all" }.
  // Default mode is "files" -- the fast path. The documents tab fetches
  // syncStatus separately so the table can render before Bedrock answers.
  let body = {};
  if (typeof event.body === 'string' && event.body.length > 0) {
    try { body = JSON.parse(event.body); } catch { body = {}; }
  }
  const mode = body.mode || 'files';
  const bypassCache = !!body.refreshStatus;

  try {
    if (mode === 'syncStatus') {
      const { map, cached, age } = await getSyncStatusMap(
        process.env.KB_ID,
        process.env.DATA_SOURCE_ID,
        s3Bucket,
        { bypassCache },
      );
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ syncStatus: map, cached, ageMs: age }),
      };
    }

    if (mode === 'all') {
      // Legacy single-call mode -- kept so older clients keep working
      // until everyone is on the progressive-load path. Internally uses
      // the same caching as the split endpoints.
      console.log(`[mode=all] Listing all objects in bucket ${s3Bucket}`);
      const [objects, metadataPresence, syncStatusResult] = await Promise.all([
        listAllObjects(s3Bucket),
        loadMetadataPresenceMap(s3Bucket),
        getSyncStatusMap(process.env.KB_ID, process.env.DATA_SOURCE_ID, s3Bucket, { bypassCache }),
      ]);
      const contents = objects.map(obj => ({
        ...obj,
        HasMetadata: !!metadataPresence[obj.Key],
        SyncStatus: syncStatusResult.map[obj.Key] || 'not_yet_synced',
      }));
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ Contents: contents }),
      };
    }

    // Default: fast files-only path. Skips Bedrock entirely so the table
    // can render in ~300-500ms; sync chips hydrate from a follow-up call.
    console.log(`[mode=files] Listing all objects in bucket ${s3Bucket}`);
    const [objects, metadataPresence] = await Promise.all([
      listAllObjects(s3Bucket),
      loadMetadataPresenceMap(s3Bucket),
    ]);
    const contents = objects.map(obj => ({
      ...obj,
      HasMetadata: !!metadataPresence[obj.Key],
    }));
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ Contents: contents }),
    };
  } catch (error) {
    console.error('Error in get-s3 handler:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        message: 'Get S3 Bucket data failed - Internal Server Error',
        error: error.message,
      }),
    };
  }
};

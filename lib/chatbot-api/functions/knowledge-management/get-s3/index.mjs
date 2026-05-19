// Import necessary modules
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, ListKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent';

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
async function loadSyncStatusMap(bedrockClient, kbId, dataSourceId, bucket) {
  const map = {};
  if (!kbId || !dataSourceId) {
    console.warn('KB_ID or DATA_SOURCE_ID not set; skipping sync-status lookup');
    return map;
  }
  const expectedPrefix = `s3://${bucket}/`;
  try {
    let nextToken;
    do {
      const resp = await bedrockClient.send(new ListKnowledgeBaseDocumentsCommand({
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

/**
 * Load the metadata.txt index from the KB bucket and return a map of
 * filename → boolean indicating whether that file has a non-empty `summary`.
 *
 * metadata.txt is maintained by the metadata-handler Lambda and looks like:
 *   { "ITC80.pdf": { "summary": "...", "tag_category": "user guide" },
 *     "FAC120.pdf": {} }
 *
 * A file is considered to have metadata only when its entry contains a
 * non-empty summary string. Files missing from the map are treated as having
 * no metadata yet.
 */
async function loadMetadataPresenceMap(s3Client, bucket) {
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: 'metadata.txt' }));
    const body = await resp.Body.transformToString();
    const parsed = JSON.parse(body);
    const map = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (key === 'metadata.txt') continue;
      const summary = entry && typeof entry === 'object' ? entry.summary : null;
      map[key] = !!(summary && typeof summary === 'string' && summary.trim().length > 0 && !summary.startsWith('Error '));
    }
    return map;
  } catch (e) {
    console.warn('Could not load metadata.txt for presence map:', e?.message || e);
    return {};
  }
}

export const handler = async (event) => {
  // CORS headers to include in all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'OPTIONS,POST'
  };

  // Handle OPTIONS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({})
    };
  }

  const s3Client = new S3Client();    
  try {
    const claims = event.requestContext.authorizer.jwt.claims
    const roles = JSON.parse(claims['custom:role'])
    console.log(roles)
    if (Array.isArray(roles) && roles.includes("Admin")) {
      console.log("authorized")
    } else {
      console.log("not an admin")
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({message: 'User is not authorized  to perform this action'}),
      };
    }
  } catch (e) {
    console.log("could not check admin access")
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({message: 'Unable to check user role, please ensure you have Cognito configured correctly with a custom:role attribute.'}),
    };
  }
  
  const s3Bucket = process.env.BUCKET;

  try {
    // Return every document in the KB bucket in a single response. The admin
    // table is shown to a small admin audience and the bucket holds a few
    // hundred files (PDFs/docx) -- well under any payload limits -- so
    // streaming the full inventory keeps the client logic simple: search
    // filters everything, and pagination operates on the filtered set
    // client-side. Server-side ContinuationToken-per-click pagination broke
    // search because the search box could only filter the rows on the
    // currently-loaded page.
    console.log(`Listing all objects in bucket ${s3Bucket}`);
    const allObjects = [];
    let continuationToken = undefined;
    do {
      const result = await s3Client.send(new ListObjectsV2Command({
        Bucket: s3Bucket,
        ContinuationToken: continuationToken,
      }));
      for (const obj of result.Contents || []) {
        if (obj.Key && obj.Key !== 'metadata.txt') {
          allObjects.push(obj);
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    // Hydrate metadata-presence and KB sync status in parallel so the page
    // doesn't pay for two sequential round-trips.
    const bedrockAgentClient = new BedrockAgentClient({});
    const [metadataPresence, syncStatusMap] = await Promise.all([
      loadMetadataPresenceMap(s3Client, s3Bucket),
      loadSyncStatusMap(
        bedrockAgentClient,
        process.env.KB_ID,
        process.env.DATA_SOURCE_ID,
        s3Bucket,
      ),
    ]);
    const contents = allObjects.map(obj => ({
      ...obj,
      HasMetadata: !!metadataPresence[obj.Key],
      // Files in S3 that Bedrock has never seen show up as not_yet_synced
      // (either uploaded after the last sync or filtered out by Bedrock).
      SyncStatus: syncStatusMap[obj.Key] || 'not_yet_synced',
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ Contents: contents }),
    };
  } catch (error) {
    console.error("Error listing objects in S3:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Get S3 Bucket data failed- Internal Server Error',
        error: error.message
      }),
    };
  }
};

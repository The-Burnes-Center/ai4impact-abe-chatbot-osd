// Import necessary modules
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

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

    const metadataPresence = await loadMetadataPresenceMap(s3Client, s3Bucket);
    const contents = allObjects.map(obj => ({
      ...obj,
      HasMetadata: !!metadataPresence[obj.Key],
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

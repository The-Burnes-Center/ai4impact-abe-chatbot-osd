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
  
  // Parse the body to get parameters
  let continuationToken, pageIndex;
  try {
    if (event.body) {
      const body = JSON.parse(event.body);
      console.log("Request body:", body);
      continuationToken = body.continuationToken;
      pageIndex = body.pageIndex;
    }
  } catch (error) {
    console.error("Error parsing request body:", error);
  }
  
  const s3Bucket = process.env.BUCKET;
  
  try {
    console.log(`Listing objects in bucket ${s3Bucket} with continuationToken: ${continuationToken}`);
    const command = new ListObjectsV2Command({
      Bucket: s3Bucket,
      ContinuationToken: continuationToken,
    });

    const result = await s3Client.send(command);
    console.log("S3 List Objects result:", result);

    const metadataPresence = await loadMetadataPresenceMap(s3Client, s3Bucket);
    const contents = (result.Contents || [])
      .filter(obj => obj.Key !== 'metadata.txt')
      .map(obj => ({ ...obj, HasMetadata: !!metadataPresence[obj.Key] }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        Contents: contents,
        NextContinuationToken: result.NextContinuationToken
      }),
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

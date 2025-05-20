// Import necessary modules
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

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
    
    if (roles.includes("Admin")) {
      // User is authorized
    } else {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({message: 'User is not authorized to perform this action'}),
      };
    }
  } catch (e) {
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
      continuationToken = body.continuationToken;
      pageIndex = body.pageIndex;
    }
  } catch (error) {
    // Continue with null parameters if parsing fails
  }
  
  const s3Bucket = process.env.BUCKET;
  
  try {
    const command = new ListObjectsV2Command({
      Bucket: s3Bucket,
      ContinuationToken: continuationToken,
    });

    const result = await s3Client.send(command);
    
    // Filter out files from the 'evaluations' folder
    const filteredContents = result.Contents ? result.Contents.filter(item => {
      // Skip files that start with 'evaluations/'
      return !item.Key.startsWith('evaluations/');
    }) : [];
    
    // Format the response to match what the frontend expects
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        Contents: filteredContents,
        NextContinuationToken: result.NextContinuationToken
      }),
    };
  } catch (error) {
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
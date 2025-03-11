// Import necessary modules
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const handler = async (event) => {
  const s3Client = new S3Client();    
  try {
    const claims = event.requestContext.authorizer.jwt.claims
    const roles = JSON.parse(claims['custom:role'])
    console.log(roles)
    if (roles.some(role => role.includes("Admin"))) {
      console.log("authorized")
    } else {
      console.log("not an admin")
      return {
        statusCode: 403,
         headers: {
              'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({message: 'User is not authorized  to perform this action'}),
      };
    }
  } catch (e) {
    console.log("could not check admin access")
    return {
      statusCode: 500,
       headers: {
            'Access-Control-Allow-Origin': '*'
      },
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
    
    // Format the response to match what the frontend expects
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        Contents: result.Contents,
        NextContinuationToken: result.NextContinuationToken
      }),
    };
  } catch (error) {
    console.error("Error listing objects in S3:", error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'Get S3 Bucket data failed- Internal Server Error',
        error: error.message
      }),
    };
  }
};

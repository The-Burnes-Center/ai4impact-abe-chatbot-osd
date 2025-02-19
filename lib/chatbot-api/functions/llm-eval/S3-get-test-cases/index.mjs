// Import necessary modules
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const handler = async (event) => {
  const s3Client = new S3Client();    
  try {
    const claims = event.requestContext.authorizer.jwt.claims
    const roles = JSON.parse(claims['custom:role'])
    console.log(roles)
    if (roles.includes("Admin")) {
      console.log("authorized")      
    } else {
      console.log("not an admin")
      return {
        statusCode: 403,
         headers: {
              'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({message: 'User is not authorized to perform this action'}),
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
  //const {continuationToken, pageIndex } = event;
  const s3Bucket = process.env.BUCKET;

  let continuationToken, pageIndex;
  try {
    console.log("event: ", event)
    const body = JSON.parse(event.body || '{}');
    console.log("body: ", body)
    continuationToken = body.continuationToken; 
    pageIndex = body.pageIndex;
    console.log("continuationToken", continuationToken);
    console.log("pageIndex", pageIndex);
    const command = new ListObjectsV2Command({
      Bucket: s3Bucket,

      ContinuationToken: continuationToken,
    });
    console.log("command: ", command)

    const result = await s3Client.send(command);
    console.log("result: ", result)
    const filteredResults = result.Contents?.filter(
      (item) => !item.Key.startsWith("evaluations/")
    );
    console.log("filtered results: ", filteredResults)

    return {
      statusCode: 200,
      headers: {
            'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        Contents: filteredResults,
        NextContinuationToken: result.NextContinuationToken,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
       headers: {
            'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({message: 'Get S3 Bucket data failed- Internal Server Error'}),
    };
  }
};
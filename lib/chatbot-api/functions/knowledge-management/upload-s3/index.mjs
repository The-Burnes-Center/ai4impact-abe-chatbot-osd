// Import necessary modules from AWS SDK for S3 interaction
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const URL_EXPIRATION_SECONDS = 300;

// Restrict admin uploads to a single allowlisted prefix and a safe character
// set so an admin token cannot overwrite system-managed keys like
// `metadata.txt` or `indexes/.../latest.xlsx`.
const SAFE_FILENAME = /^[a-zA-Z0-9._\-/ ]+$/;

// Main Lambda entry point
export const handler = async (event) => {
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
  return await getUploadURL(event); //Call the helper function
};

//Helper function to generate a presigned upload URL for S3
const getUploadURL = async function (event) {
  const body = JSON.parse(event.body); //Parse the incoming request body
  const fileName = body.fileName; //Retrieve the file name
  const fileType = body.fileType; //Retrieve the file type

  if (!fileName || typeof fileName !== "string" || !SAFE_FILENAME.test(fileName) || fileName.includes("..")) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid filename' }),
    };
  }
  // Block writes to system-managed keys at the bucket root and to the Excel
  // index path so an admin cannot clobber the chat metadata file or replace a
  // live index file outside the normal index management API.
  const normalized = fileName.replace(/^\/+/, "");
  if (normalized === "metadata.txt" || normalized.startsWith("indexes/")) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Key not allowed' }),
    };
  }

  const s3Params = { //Parameters for S3 PutObjectCommand
    Bucket: process.env.BUCKET, //S3 bucket name for environment
    Key: normalized, //S3 object key (filename)
    ContentType: fileType, //MIME type of the file

  };

  const s3 = new S3Client({ region: 'us-east-1' }); //Initlialize S3 client
  const command = new PutObjectCommand(s3Params); //Create PutObjectCommand with given params

  try {
    const signedUrl = await getSignedUrl(s3, command, {
      expiresIn: URL_EXPIRATION_SECONDS, //Set URL expiration time
    });
    return {
      statusCode: 200, 
      headers: {
            'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ signedUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500,
       headers: {
            'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Failed to generate signed URL' }),
    };
  }
};



// Import necessary modules from AWS SDK for S3 interaction
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const URL_EXPIRATION_SECONDS = 300;

// Restrict eval-test-cases uploads to a known prefix and a safe character set,
// so an admin token cannot place objects in arbitrary paths (e.g. clobbering
// state-machine intermediate keys like `chunks/`, `partial_results/`, etc.).
// Allows the same character set as source-presign so any file that can be
// uploaded can also be served back. Parens are common in browser/OS dedupe
// suffixes (e.g. "test-cases (2).csv").
const ALLOWED_PREFIX = "test-cases/";
const SAFE_FILENAME = /^[a-zA-Z0-9._\-/ ()&,+]+$/;
const SAFE_CHAR = /[a-zA-Z0-9._\-/ ()&,+]/;
const ALLOWED_DESCRIPTION = 'letters, numbers, spaces, and these symbols: ( ) & , + . _ - /';

// Main Lambda entry point
export const handler = async (event) => {
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
  return await getUploadURL(event); //Call the helper function
};

//Helper function to generate a presigned upload URL for S3
const getUploadURL = async function (event) {
  const body = JSON.parse(event.body); //Parse the incoming request body
  const fileName = body.fileName; //Retrieve the file name
  const fileType = body.fileType; //Retrieve the file type

  if (!fileName || typeof fileName !== "string") {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Filename is required.' }),
    };
  }
  if (fileName.includes("..")) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Filename cannot contain ".." for path-traversal safety.' }),
    };
  }
  if (!SAFE_FILENAME.test(fileName)) {
    const badChars = [...new Set([...fileName].filter((c) => !SAFE_CHAR.test(c)))]
      .map((c) => `"${c}"`)
      .join(', ');
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: `Filename contains characters that aren't allowed: ${badChars}. Use only ${ALLOWED_DESCRIPTION}.`,
      }),
    };
  }
  const normalized = fileName.replace(/^\/+/, "");
  const key = normalized.startsWith(ALLOWED_PREFIX) ? normalized : `${ALLOWED_PREFIX}${normalized}`;

  const s3Params = { //Parameters for S3 PutObjectCommand
    Bucket: process.env.BUCKET, //S3 bucket name for environment
    Key: key, //S3 object key (filename)
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


// import step functions from aws-sdk
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "crypto";

//const stepfunctions = new AWS.StepFunctions();
const stepFunctionsClient = new SFNClient({ region: "us-east-1" });

export const handler = async (event) => {
  // Get the origin from the request
  const origin = event.headers?.origin || event.headers?.Origin || 'https://dcf43zj2k8alr.cloudfront.net';
  
  // Add CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
    'Access-Control-Allow-Credentials': 'true'
  };
  
  // Handle OPTIONS request (preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ message: 'CORS preflight request successful' })
    };
  }
  
  try {
    // Safely parse the body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      console.error(`Error parsing request body: ${error.message}`);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({
          message: "Invalid request body format",
          error: error.message
        })
      };
    }
    
    // Validate and extract the test cases key
    let testCasesKey = body?.testCasesKey;
    
    // Normalize the key if needed (handle different path formats)
    if (testCasesKey) {
      // Check file extension - we support both JSON and CSV
      const fileExtension = testCasesKey.split('.').pop().toLowerCase();
      
      if (fileExtension !== 'json' && fileExtension !== 'csv') {
        console.warn(`File extension '${fileExtension}' may not be supported. Expecting 'json' or 'csv'.`);
      }
    } else {
      console.error("Missing required parameter: testCasesKey");
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({
          message: "Missing required parameter: testCasesKey"
        })
      };
    }
    
    // Extract evaluation name with fallback to empty string
    const evalName = body?.evaluation_name || "";
    
    // Generate a UUID for the evaluation_id instead of timestamp to avoid conflicts
    const evaluationId = randomUUID();
    
    // Prepare Step Functions input
    const params = {
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify({
        "test_cases_key": testCasesKey,
        "evaluation_id": evaluationId,
        "evaluation_name": evalName
      })
    };
    
    // Execute Step Functions state machine
    const command = new StartExecutionCommand(params);
    const data = await stepFunctionsClient.send(command);
    
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        message: "Evaluation started successfully",
        executionArn: data.executionArn,
        evaluationId: evaluationId,
        startDate: data.startDate
      })
    };
  } catch (err) {
    console.error(`Error starting evaluation: ${err.message}`);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: "Failed to start evaluation",
        error: err.message
      })
    };
  }
}
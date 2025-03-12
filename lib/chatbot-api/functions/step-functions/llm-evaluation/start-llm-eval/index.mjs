// import step functions from aws-sdk
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

//const stepfunctions = new AWS.StepFunctions();
const stepFunctionsClient = new SFNClient({ region: "us-east-1" });

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  
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
    console.log("Attempting to start evaluation");
    
    // Safely parse the body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      console.log("Parsed request body:", JSON.stringify(body, null, 2));
    } catch (error) {
      console.error("Error parsing request body:", error);
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
      // Log the original key for debugging
      console.log("Original testCasesKey:", testCasesKey);
      
      // Check file extension - we support both JSON and CSV
      const fileExtension = testCasesKey.split('.').pop().toLowerCase();
      console.log("File extension:", fileExtension);
      
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
    
    console.log(`Starting evaluation with testCasesKey: ${testCasesKey}, evalName: ${evalName}`);
    
    // Prepare Step Functions input
    const params = {
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify({
        "test_cases_key": testCasesKey,
        "evaluation_id": Date.now().toString(),
        "evaluation_name": evalName
      })
    };
    
    console.log("Step Functions params:", JSON.stringify(params, null, 2));
    const command = new StartExecutionCommand(params);
    
    // Execute Step Functions state machine
    const data = await stepFunctionsClient.send(command);
    console.log("Step Functions execution started:", JSON.stringify(data, null, 2));
    
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        message: "Evaluation started successfully",
        executionArn: data.executionArn,
        startDate: data.startDate
      })
    };
  } catch (err) {
    console.error("Error starting evaluation:", err);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: "Failed to start evaluation",
        error: err.message,
        stack: err.stack
      })
    };
  }
}
// import step functions from aws-sdk
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

//const stepfunctions = new AWS.StepFunctions();
const stepFunctionsClient = new SFNClient({ region: "us-east-1" });

export const handler = async (event) => {
  // Add CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
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
    console.log("trying to start evaluation");
    const body = JSON.parse(event.body);
    const testCasesKey = body.testCasesKey;
    const evalName = body.evaluation_name;
    
    if (!testCasesKey) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({
          message: "Missing required parameter: testCasesKey"
        })
      };
    }
    
    const params = {
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify({
        "testCasesKey": testCasesKey,
        "evalName": evalName
      })
    };
    
    const command = new StartExecutionCommand(params);
    const data = await stepFunctionsClient.send(command);
    console.log("data: ", data);
    
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
    console.log(err);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: "Internal server error",
        error: err.message
      })
    };
  }
}
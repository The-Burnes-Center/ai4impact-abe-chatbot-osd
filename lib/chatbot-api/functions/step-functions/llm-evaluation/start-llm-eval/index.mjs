// import step functions from aws-sdk
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

//const stepfunctions = new AWS.StepFunctions();
const stepFunctionsClient = new SFNClient({ region: "us-east-1" });

export const handler = async (event) => {
  try{
    console.log ("trying to start evaluation")
    const body = JSON.parse(event.body);
    const testCasesKey = body.testCasesKey;
    const evalName = body.evaluation_name;
    const params = {
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        input: JSON.stringify({
            "testCasesKey": testCasesKey,
            "evalName": evalName
        })
    }
    const command = new StartExecutionCommand(params);
    const data = await stepFunctionsClient.send(command);
    console.log("data: ", data)
    //const data = await stepfunctions.startExecution(params).promise();
    return data; 
  } catch (err) {
    console.log(err);
    return {
        statusCode: 500,
        body: JSON.stringify({
            message: "Internal server error"
        }),
    };     
  }
}
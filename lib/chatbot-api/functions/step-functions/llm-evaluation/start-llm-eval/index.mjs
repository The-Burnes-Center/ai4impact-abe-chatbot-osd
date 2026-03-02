import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

const sfnClient = new SFNClient({ region: "us-east-1" });
const ddbClient = new DynamoDBClient({ region: "us-east-1" });
const s3Client = new S3Client({ region: "us-east-1" });

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
  };

  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "Invalid request body format", error: error.message }),
      };
    }

    let testCasesKey = body?.testCasesKey;
    const testCasesInline = body?.testCasesInline;
    const evalName = body?.evaluation_name || "";
    const evaluationId = randomUUID();
    const bucket = process.env.TEST_CASES_BUCKET;

    if (testCasesInline && Array.isArray(testCasesInline) && testCasesInline.length > 0) {
      testCasesKey = `test-cases/inline-${evaluationId}.json`;
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: testCasesKey,
        Body: JSON.stringify(testCasesInline),
        ContentType: 'application/json',
      }));
    }

    if (!testCasesKey) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "Either testCasesKey or testCasesInline is required" }),
      };
    }

    const sfnInput = {
      test_cases_key: testCasesKey,
      evaluation_id: evaluationId,
      evaluation_name: evalName,
    };

    const command = new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify(sfnInput),
    });
    const data = await sfnClient.send(command);

    const timestamp = new Date().toISOString();
    const summariesTable = process.env.EVAL_SUMMARIES_TABLE;
    if (summariesTable) {
      try {
        await ddbClient.send(new PutItemCommand({
          TableName: summariesTable,
          Item: {
            PartitionKey: { S: "Evaluation" },
            Timestamp: { S: timestamp },
            EvaluationId: { S: evaluationId },
            evaluation_name: { S: evalName },
            test_cases_key: { S: testCasesKey },
            executionArn: { S: data.executionArn },
            status: { S: "RUNNING" },
          },
        }));
      } catch (ddbErr) {
        console.error("Failed to write eval summary to DDB:", ddbErr.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Evaluation started successfully",
        executionArn: data.executionArn,
        evaluationId,
        startDate: data.startDate,
      }),
    };
  } catch (err) {
    console.error(`Error starting evaluation: ${err.message}`);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: "Failed to start evaluation", error: err.message }),
    };
  }
};

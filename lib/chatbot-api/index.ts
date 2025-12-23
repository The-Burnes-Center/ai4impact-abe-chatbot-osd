import * as cdk from "aws-cdk-lib";
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AuthorizationStack } from '../authorization'
import { WebsocketBackendAPI } from "./gateway/websocket-api"
import { RestBackendAPI } from "./gateway/rest-api"
import { LambdaFunctionStack } from "./functions/functions"
import { TableStack } from "./tables/tables"
import { S3BucketStack } from "./buckets/buckets"
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { WebSocketLambdaAuthorizer, HttpUserPoolAuthorizer, HttpJwtAuthorizer  } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { Construct } from "constructs";
import { OpenSearchStack } from "./opensearch/opensearch";
import { KnowledgeBaseStack } from "./knowledge-base/knowledge-base"
import * as lambda from "aws-cdk-lib/aws-lambda";

// import { NagSuppressions } from "cdk-nag";

export interface ChatBotApiProps {
  readonly authentication: AuthorizationStack; 
}

export class ChatBotApi extends Construct {
  public readonly httpAPI: RestBackendAPI;
  public readonly wsAPI: WebsocketBackendAPI;
  // public readonly byUserIdIndex: string;
  // public readonly filesBucket: s3.Bucket;
  // public readonly userFeedbackBucket: s3.Bucket;
  // public readonly wsAPI: apigwv2.WebSocketApi;

  constructor(scope: Construct, id: string, props: ChatBotApiProps) {
    super(scope, id);
    
    // Create dedicated Lambda function to handle OPTIONS requests for CORS
    const corsHandler = new lambda.Function(this, 'OptionsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          // Get the origin from the request
          const origin = event.headers?.origin || event.headers?.Origin || 'https://dcf43zj2k8alr.cloudfront.net';
          
          return {
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
              "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Credentials": "true"
            },
            body: JSON.stringify({}),
          };
        };
      `)
    });
    
    const corsHandlerIntegration = new HttpLambdaIntegration('CorsHandlerIntegration', corsHandler);

    const tables = new TableStack(this, "TableStack");
    const buckets = new S3BucketStack(this, "BucketStack");
    
    const openSearch = new OpenSearchStack(this,"OpenSearchStack",{})
    const knowledgeBase = new KnowledgeBaseStack(this,"KnowledgeBaseStack",{ openSearch : openSearch,
      s3bucket : buckets.knowledgeBucket})

    const restBackend = new RestBackendAPI(this, "RestBackend", {})
    this.httpAPI = restBackend;
    const websocketBackend = new WebsocketBackendAPI(this, "WebsocketBackend", {})
    this.wsAPI = websocketBackend;

    const lambdaFunctions = new LambdaFunctionStack(this, "LambdaFunctions",
      {
        wsApiEndpoint: websocketBackend.wsAPIStage.url,
        sessionTable: tables.historyTable,        
        feedbackTable: tables.feedbackTable,
        feedbackBucket: buckets.feedbackBucket,
        knowledgeBucket: buckets.knowledgeBucket,
        knowledgeBase: knowledgeBase.knowledgeBase,
        knowledgeBaseSource : knowledgeBase.dataSource,
        evalSummariesTable : tables.evalSummaryTable,
        evalResutlsTable : tables.evalResultsTable,
        evalTestCasesBucket : buckets.evalTestCasesBucket,
        evalResultsBucket : buckets.evalResultsBucket,
      })

    const wsAuthorizer = new WebSocketLambdaAuthorizer('WebSocketAuthorizer', props.authentication.lambdaAuthorizer, {identitySource: ['route.request.querystring.Authorization']});

    websocketBackend.wsAPI.addRoute('getChatbotResponse', {
      integration: new WebSocketLambdaIntegration('chatbotResponseIntegration', lambdaFunctions.chatFunction),
      // authorizer: wsAuthorizer
    });
    websocketBackend.wsAPI.addRoute('$connect', {
      integration: new WebSocketLambdaIntegration('chatbotConnectionIntegration', lambdaFunctions.chatFunction),
      authorizer: wsAuthorizer
    });
    websocketBackend.wsAPI.addRoute('$default', {
      integration: new WebSocketLambdaIntegration('chatbotConnectionIntegration', lambdaFunctions.chatFunction),
      // authorizer: wsAuthorizer
    });
    websocketBackend.wsAPI.addRoute('$disconnect', {
      integration: new WebSocketLambdaIntegration('chatbotDisconnectionIntegration', lambdaFunctions.chatFunction),
      // authorizer: wsAuthorizer
    });    

    websocketBackend.wsAPI.grantManageConnections(lambdaFunctions.chatFunction);

    
    const httpAuthorizer = new HttpJwtAuthorizer('HTTPAuthorizer', props.authentication.userPool.userPoolProviderUrl,{
      jwtAudience: [props.authentication.userPoolClient.userPoolClientId],
    })

    const sessionAPIIntegration = new HttpLambdaIntegration('SessionAPIIntegration', lambdaFunctions.sessionFunction);
    restBackend.restAPI.addRoutes({
      path: "/user-session",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.DELETE],
      integration: sessionAPIIntegration,
      authorizer: httpAuthorizer,
    })

    // SESSION_HANDLER
    // lambdaFunctions.chatFunction.addEnvironment(
    //   "mvp_user_session_handler_api_gateway_endpoint", restBackend.restAPI.apiEndpoint + "/user-session")
    lambdaFunctions.chatFunction.addEnvironment(
      "SESSION_HANDLER", lambdaFunctions.sessionFunction.functionName)
    

    const feedbackAPIIntegration = new HttpLambdaIntegration('FeedbackAPIIntegration', lambdaFunctions.feedbackFunction);
    restBackend.restAPI.addRoutes({
      path: "/user-feedback",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.DELETE],
      integration: feedbackAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const feedbackAPIDownloadIntegration = new HttpLambdaIntegration('FeedbackDownloadAPIIntegration', lambdaFunctions.feedbackFunction);
    restBackend.restAPI.addRoutes({
      path: "/user-feedback/download-feedback",
      methods: [apigwv2.HttpMethod.POST],
      integration: feedbackAPIDownloadIntegration,
      authorizer: httpAuthorizer,
    })

    const s3GetAPIIntegration = new HttpLambdaIntegration('S3GetAPIIntegration', lambdaFunctions.getS3Function);
    restBackend.restAPI.addRoutes({
      path: "/s3-bucket-data",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });
    
    restBackend.restAPI.addRoutes({
      path: "/s3-bucket-data",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3GetAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const s3DeleteAPIIntegration = new HttpLambdaIntegration('S3DeleteAPIIntegration', lambdaFunctions.deleteS3Function);
    restBackend.restAPI.addRoutes({
      path: "/delete-s3-file",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });
    
    restBackend.restAPI.addRoutes({
      path: "/delete-s3-file",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3DeleteAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const s3UploadAPIIntegration = new HttpLambdaIntegration('S3UploadAPIIntegration', lambdaFunctions.uploadS3Function);
    restBackend.restAPI.addRoutes({
      path: "/signed-url",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });
    
    restBackend.restAPI.addRoutes({
      path: "/signed-url",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3UploadAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const kbSyncProgressAPIIntegration = new HttpLambdaIntegration('KBSyncAPIIntegration', lambdaFunctions.syncKBFunction);
    restBackend.restAPI.addRoutes({
      path: "/kb-sync/still-syncing",
      methods: [apigwv2.HttpMethod.GET],
      integration: kbSyncProgressAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const kbSyncAPIIntegration = new HttpLambdaIntegration('KBSyncAPIIntegration', lambdaFunctions.syncKBFunction);
    restBackend.restAPI.addRoutes({
      path: "/kb-sync/sync-kb",
      methods: [apigwv2.HttpMethod.GET],
      integration: kbSyncAPIIntegration,
      authorizer: httpAuthorizer,
    })
    
    const kbLastSyncAPIIntegration = new HttpLambdaIntegration('KBLastSyncAPIIntegration', lambdaFunctions.syncKBFunction);
    restBackend.restAPI.addRoutes({
      path: "/kb-sync/get-last-sync",
      methods: [apigwv2.HttpMethod.GET],
      integration: kbLastSyncAPIIntegration,
      authorizer: httpAuthorizer,
    })

      // this.wsAPI = websocketBackend.wsAPI;




    // const api = new appsync.GraphqlApi(this, "ChatbotApi", {
    //   name: "ChatbotGraphqlApi",
    //   definition: appsync.Definition.fromFile(
    //     path.join(__dirname, "schema/schema.graphql")
    //   ),
    //   authorizationConfig: {
    //     additionalAuthorizationModes: [
    //       {
    //         authorizationType: appsync.AuthorizationType.IAM,
    //       },
    //       {
    //         authorizationType: appsync.AuthorizationType.USER_POOL,
    //         userPoolConfig: {
    //           userPool: props.userPool,
    //         },
    //       },
    //     ],
    //   },
    //   logConfig: {
    //     fieldLogLevel: appsync.FieldLogLevel.ALL,
    //     retention: RetentionDays.ONE_WEEK,
    //     role: loggingRole,
    //   },
    //   xrayEnabled: true,
    //   visibility: props.config.privateWebsite ? appsync.Visibility.PRIVATE : appsync.Visibility.GLOBAL
    // });

    // new ApiResolvers(this, "RestApi", {
    //   ...props,
    //   sessionsTable: chatTables.sessionsTable,
    //   byUserIdIndex: chatTables.byUserIdIndex,
    //   api,
    //   userFeedbackBucket: chatBuckets.userFeedbackBucket,
    // });

    // const realtimeBackend = new RealtimeGraphqlApiBackend(this, "Realtime", {
    //   ...props,
    //   api,
    // });

    // realtimeBackend.resolvers.outgoingMessageHandler.addEnvironment(
    //   "GRAPHQL_ENDPOINT",
    //   api.graphqlUrl
    // );

    // api.grantMutation(realtimeBackend.resolvers.outgoingMessageHandler);

    // // Prints out URL
    // new cdk.CfnOutput(this, "GraphqlAPIURL", {
    //   value: api.graphqlUrl,
    // });

    // // Prints out the AppSync GraphQL API key to the terminal
    new cdk.CfnOutput(this, "WS-API - apiEndpoint", {
      value: websocketBackend.wsAPI.apiEndpoint || "",
    });
    new cdk.CfnOutput(this, "HTTP-API - apiEndpoint", {
      value: restBackend.restAPI.apiEndpoint || "",
    });

    // this.messagesTopic = realtimeBackend.messagesTopic;
    // this.sessionsTable = chatTables.sessionsTable;
    // this.byUserIdIndex = chatTables.byUserIdIndex;
    // this.userFeedbackBucket = chatBuckets.userFeedbackBucket;
    // this.filesBucket = chatBuckets.filesBucket;
    // this.graphqlApi = api;

    /**
     * CDK NAG suppression
     */
    // NagSuppressions.addResourceSuppressions(loggingRole, [
    //   {
    //     id: "AwsSolutions-IAM5",
    //     reason:
    //       "Access to all log groups required for CloudWatch log group creation.",
    //   },
    // ]);
  
    const evalResultsHandlerIntegration = new HttpLambdaIntegration(
      'EvalResultsHandlerIntegration',
      lambdaFunctions.handleEvalResultsFunction
    );
    restBackend.restAPI.addRoutes({
      path: "/eval-results-handler",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });

    restBackend.restAPI.addRoutes({
      path: "/eval-results-handler",
      methods: [apigwv2.HttpMethod.POST],
      integration: evalResultsHandlerIntegration,
      authorizer: httpAuthorizer,
    });

    const evalRunHandlerIntegration = new HttpLambdaIntegration(
      'EvalRunHandlerIntegration',
      lambdaFunctions.stepFunctionsStack.startLlmEvalStateMachineFunction
    );
    restBackend.restAPI.addRoutes({
      path: "/eval-run-handler",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });

    restBackend.restAPI.addRoutes({
      path: "/eval-run-handler",
      methods: [apigwv2.HttpMethod.POST],
      integration: evalRunHandlerIntegration,
      authorizer: httpAuthorizer,
    }); 

    const metricsHandlerIntegration = new HttpLambdaIntegration(
      'MetricsHandlerIntegration',
      lambdaFunctions.metricsHandlerFunction
    );
    restBackend.restAPI.addRoutes({
      path: "/metrics",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });

    restBackend.restAPI.addRoutes({
      path: "/metrics",
      methods: [apigwv2.HttpMethod.GET],
      integration: metricsHandlerIntegration,
      authorizer: httpAuthorizer,
    });

    const s3UploadTestCasesAPIIntegration = new HttpLambdaIntegration('S3UploadTestCasesAPIIntegration', lambdaFunctions.uploadS3TestCasesFunction);
    restBackend.restAPI.addRoutes({
      path: "/signed-url-test-cases",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });
    
    restBackend.restAPI.addRoutes({
      path: "/signed-url-test-cases",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3UploadTestCasesAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const s3GetTestCasesAPIIntegration = new HttpLambdaIntegration('S3GetTestCasesAPIIntegration', lambdaFunctions.getS3TestCasesFunction);
    
    // Add proper CORS response for OPTIONS preflight request
    restBackend.restAPI.addRoutes({
      path: "/s3-test-cases-bucket-data",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: corsHandlerIntegration,
    });

    restBackend.restAPI.addRoutes({
      path: "/s3-test-cases-bucket-data",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3GetTestCasesAPIIntegration,
      authorizer: httpAuthorizer,
    })
  }
}
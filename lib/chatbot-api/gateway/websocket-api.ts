import * as cdk from "aws-cdk-lib";
import { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";

interface WebsocketBackendAPIProps {}

export class WebsocketBackendAPI extends Construct {
  public readonly wsAPI: apigwv2.WebSocketApi;
  public readonly wsAPIStage: apigwv2.WebSocketStage;
  constructor(
    scope: Construct,
    id: string,
    props: WebsocketBackendAPIProps
  ) {
    super(scope, id);

    const webSocketApi = new apigwv2.WebSocketApi(this, 'WS-API');

    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webSocketApiStage = new apigwv2.WebSocketStage(this, 'WS-API-prod', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    const cfnStage = webSocketApiStage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        eventType: '$context.eventType',
        routeKey: '$context.routeKey',
        status: '$context.status',
        connectionId: '$context.connectionId',
        integrationError: '$context.integrationErrorMessage',
      }),
    };
    cfnStage.defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit: 100,
    };

    this.wsAPI = webSocketApi;
    this.wsAPIStage = webSocketApiStage;
  }
}

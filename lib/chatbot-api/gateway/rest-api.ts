import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration, aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";

export interface RestBackendAPIProps {}

export class RestBackendAPI extends Construct {
  public readonly restAPI: apigwv2.HttpApi;
  constructor(scope: Construct, id: string, props: RestBackendAPIProps) {
    super(scope, id);

    const httpApi = new apigwv2.HttpApi(this, 'HTTP-API', {
      corsPreflight: {
        allowHeaders: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.HEAD,
          apigwv2.CorsHttpMethod.OPTIONS,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowOrigins: ['*'],
        maxAge: Duration.days(10),
      },
    });
    this.restAPI = httpApi;

    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationError: '$context.integrationErrorMessage',
      }),
    };
    defaultStage.defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit: 100,
    };
  }
}

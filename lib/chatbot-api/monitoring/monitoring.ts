import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { Construct } from "constructs";

export interface MonitoringProps {
  readonly lambdaFunctions: lambda.Function[];
  readonly chatFunction: lambda.Function;
  readonly tables: dynamodb.Table[];
  readonly restApi: apigwv2.HttpApi;
  readonly webSocketApi: apigwv2.WebSocketApi;
  readonly evalStateMachine: stepfunctions.StateMachine;
  readonly alarmEmail?: string;
}

export class MonitoringConstruct extends Construct {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    const stackName = cdk.Stack.of(this).stackName;

    // ─── SNS Alert Topic ───
    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `${stackName} Monitoring Alerts`,
    });

    if (props.alarmEmail) {
      new sns.Subscription(this, "AlarmEmailSub", {
        topic: this.alarmTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alarmEmail,
      });
    }

    const alarmAction = new cw_actions.SnsAction(this.alarmTopic);

    // ─── Lambda Alarms ───
    const lambdaWidgets: cloudwatch.IWidget[] = [];

    for (const fn of props.lambdaFunctions) {
      const errorAlarm = new cloudwatch.Alarm(this, `${fn.node.id}Errors`, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 3,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${fn.functionName}: ≥3 errors in 5 min`,
      });
      errorAlarm.addAlarmAction(alarmAction);

      const throttleAlarm = new cloudwatch.Alarm(this, `${fn.node.id}Throttles`, {
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${fn.functionName}: throttled invocations`,
      });
      throttleAlarm.addAlarmAction(alarmAction);
    }

    // Chat function gets a dedicated duration alarm (5-min timeout, alert at 60s avg)
    const chatDurationAlarm = new cloudwatch.Alarm(this, "ChatDurationHigh", {
      metric: props.chatFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 60_000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Chat Lambda avg duration >60s — potential upstream latency issue",
    });
    chatDurationAlarm.addAlarmAction(alarmAction);

    // ─── DynamoDB Alarms ───
    for (const table of props.tables) {
      const readThrottle = new cloudwatch.Alarm(this, `${table.node.id}ReadThrottle`, {
        metric: table.metricThrottledRequestsForOperations({
          operations: [dynamodb.Operation.QUERY, dynamodb.Operation.GET_ITEM, dynamodb.Operation.SCAN],
          period: cdk.Duration.minutes(5),
        }),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${table.tableName}: read throttles`,
      });
      readThrottle.addAlarmAction(alarmAction);

      const writeThrottle = new cloudwatch.Alarm(this, `${table.node.id}WriteThrottle`, {
        metric: table.metricThrottledRequestsForOperations({
          operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM, dynamodb.Operation.DELETE_ITEM],
          period: cdk.Duration.minutes(5),
        }),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${table.tableName}: write throttles`,
      });
      writeThrottle.addAlarmAction(alarmAction);
    }

    // ─── API Gateway Alarms ───
    const httpApiId = props.restApi.httpApiId;

    const http5xxAlarm = new cloudwatch.Alarm(this, "HttpApi5xx", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: httpApiId },
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "HTTP API: ≥10 5xx errors in 5 min",
    });
    http5xxAlarm.addAlarmAction(alarmAction);

    const http4xxAlarm = new cloudwatch.Alarm(this, "HttpApi4xx", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "4xx",
        dimensionsMap: { ApiId: httpApiId },
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 50,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "HTTP API: ≥50 4xx errors in 5 min — possible abuse or misconfiguration",
    });
    http4xxAlarm.addAlarmAction(alarmAction);

    const wsApiId = props.webSocketApi.apiId;

    const wsConnectErrorAlarm = new cloudwatch.Alarm(this, "WsApiConnectErrors", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "ConnectCount",
        dimensionsMap: { ApiId: wsApiId },
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 0,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "WebSocket API: zero connections for 15 min — possible outage",
    });
    wsConnectErrorAlarm.addAlarmAction(alarmAction);

    // ─── Step Functions Alarms ───
    const sfnFailedAlarm = new cloudwatch.Alarm(this, "EvalSfnFailed", {
      metric: props.evalStateMachine.metricFailed({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Eval pipeline state machine execution failed",
    });
    sfnFailedAlarm.addAlarmAction(alarmAction);

    // ─── CloudWatch Dashboard ───
    this.dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `${stackName}-Operations`,
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // Row 1: Lambda invocations + errors (key functions)
    const keyFunctions = [props.chatFunction, ...props.lambdaFunctions.slice(0, 5)];
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda Invocations",
        width: 12,
        left: keyFunctions.map((fn) =>
          fn.metricInvocations({ period: cdk.Duration.minutes(5) })
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda Errors",
        width: 12,
        left: keyFunctions.map((fn) =>
          fn.metricErrors({ period: cdk.Duration.minutes(5) })
        ),
      }),
    );

    // Row 2: Chat Lambda latency + throttles
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Chat Lambda Duration (ms)",
        width: 12,
        left: [
          props.chatFunction.metricDuration({ statistic: "Average", period: cdk.Duration.minutes(5) }),
          props.chatFunction.metricDuration({ statistic: "p99", period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda Throttles",
        width: 12,
        left: keyFunctions.map((fn) =>
          fn.metricThrottles({ period: cdk.Duration.minutes(5) })
        ),
      }),
    );

    // Row 3: API Gateway
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "HTTP API Requests & Errors",
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "Count",
            dimensionsMap: { ApiId: httpApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: "Requests",
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "5xx",
            dimensionsMap: { ApiId: httpApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: "5xx",
          }),
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "4xx",
            dimensionsMap: { ApiId: httpApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: "4xx",
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "HTTP API Latency (ms)",
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "Latency",
            dimensionsMap: { ApiId: httpApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Average",
            label: "Avg",
          }),
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "Latency",
            dimensionsMap: { ApiId: httpApiId },
            period: cdk.Duration.minutes(5),
            statistic: "p99",
            label: "p99",
          }),
        ],
      }),
    );

    // Row 4: WebSocket connections + DynamoDB
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "WebSocket Connections",
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "ConnectCount",
            dimensionsMap: { ApiId: wsApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: "Connects",
          }),
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "MessageCount",
            dimensionsMap: { ApiId: wsApiId },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: "Messages",
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "DynamoDB Throttles",
        width: 12,
        left: props.tables.map((table) =>
          new cloudwatch.Metric({
            namespace: "AWS/DynamoDB",
            metricName: "ThrottledRequests",
            dimensionsMap: { TableName: table.tableName },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
            label: table.node.id,
          })
        ),
      }),
    );

    // Row 5: Step Functions
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Eval Pipeline Executions",
        width: 12,
        left: [
          props.evalStateMachine.metricStarted({ period: cdk.Duration.hours(1) }),
          props.evalStateMachine.metricSucceeded({ period: cdk.Duration.hours(1) }),
          props.evalStateMachine.metricFailed({ period: cdk.Duration.hours(1) }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: "Active Alarms",
        width: 12,
        metrics: [
          http5xxAlarm.metric,
          chatDurationAlarm.metric,
          sfnFailedAlarm.metric,
        ],
      }),
    );

    // ─── Outputs ───
    new cdk.CfnOutput(this, "DashboardURL", {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/cloudwatch/home#dashboards:name=${stackName}-Operations`,
      description: "CloudWatch Dashboard URL",
    });

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS Topic ARN for monitoring alerts",
    });
  }
}

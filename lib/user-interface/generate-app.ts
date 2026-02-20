import * as cdk from "aws-cdk-lib";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { ChatBotApi } from "../chatbot-api";
import { NagSuppressions } from "cdk-nag";


export interface WebsiteProps {  
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly api: ChatBotApi;
  readonly websiteBucket: s3.Bucket;
}

export class Website extends Construct {
    readonly distribution: cf.Distribution;

  constructor(scope: Construct, id: string, props: WebsiteProps) {
    super(scope, id);

    /////////////////////////////////////
    ///// WAF WEB ACL                /////
    /////////////////////////////////////

    const webAcl = new wafv2.CfnWebACL(this, "WebACL", {
      defaultAction: { allow: {} },
      scope: "CLOUDFRONT",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "ABECloudFrontWebACL",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesAmazonIpReputationList",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesAmazonIpReputationList",
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 30,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesKnownBadInputsRuleSet",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
        {
          name: "RateLimitPerIP",
          priority: 40,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitPerIP",
          },
        },
      ],
    });

    /////////////////////////////////////
    ///// CLOUDFRONT DISTRIBUTION    /////
    /////////////////////////////////////

    const distributionLogsBucket = new s3.Bucket(
      this,
      "DistributionLogsBucket",
      {
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        enforceSSL: true,
      }
    );

    const s3Origin = new origins.S3Origin(props.websiteBucket);

    const distribution = new cf.Distribution(
      this,
      "Dist",
      {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        additionalBehaviors: {
          "/chatbot/files/*": {
            origin: s3Origin,
            viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cf.AllowedMethods.ALLOW_ALL,
            cachePolicy: cf.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cf.OriginRequestPolicy.CORS_S3_ORIGIN,
          },
        },
        defaultRootObject: "index.html",
        priceClass: cf.PriceClass.PRICE_CLASS_100,
        httpVersion: cf.HttpVersion.HTTP2_AND_3,
        enableLogging: true,
        logBucket: distributionLogsBucket,
        webAclId: webAcl.attrArn,
        errorResponses: [
          {
            httpStatus: 404,
            ttl: cdk.Duration.seconds(0),
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
          },
        ],
      }
    );

    this.distribution = distribution;

    // ###################################################
    // Outputs
    // ###################################################
    new cdk.CfnOutput(this, "UserInterfaceDomainName", {
      value: `https://${distribution.distributionDomainName}`,
    });

    NagSuppressions.addResourceSuppressions(
      distributionLogsBucket,
      [
        {
          id: "AwsSolutions-S1",
          reason: "Bucket is the server access logs bucket for the CloudFront distribution.",
        },
      ]
    );

    NagSuppressions.addResourceSuppressions(props.websiteBucket, [
      { id: "AwsSolutions-S5", reason: "OAI is configured via S3Origin for CloudFront read access." },
    ]);

    NagSuppressions.addResourceSuppressions(distribution, [
      { id: "AwsSolutions-CFR1", reason: "US-focused user base; no geo restrictions needed." },
      { id: "AwsSolutions-CFR4", reason: "TLS 1.2 is the CloudFront default minimum protocol version." },
      { id: "AwsSolutions-CFR5", reason: "S3 origins use AWS-internal HTTPS; origin SSL protocol is not configurable for S3 origin types." },
    ]);
    }

  }

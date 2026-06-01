#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GenAiMvpStack } from '../lib/gen-ai-mvp-stack';
import { stackName } from "../lib/constants";

const app = new cdk.App();

// Custom domain + ACM cert ARN are supplied per-deployment, never hardcoded, so every
// branch/account that deploys this code provides its own values (or none, falling back to
// the default CloudFront domain). Precedence: CDK context (`-c customDomain=... -c
// certificateArn=...`) then env vars (CUSTOM_DOMAIN / CERTIFICATE_ARN).
const customDomain =
  (app.node.tryGetContext('customDomain') as string | undefined) ?? process.env.CUSTOM_DOMAIN;
const certificateArn =
  (app.node.tryGetContext('certificateArn') as string | undefined) ?? process.env.CERTIFICATE_ARN;

new GenAiMvpStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  customDomain,
  certificateArn,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
# Welcome to ABE - Assistive Buyers Engine

## Overview

The Assistive Buyers Engine (ABE) is a serverless application designed to assist users in navigating procurement processes effectively. Built using AWS CDK (Cloud Development Kit), it integrates AWS Cognito for user management and AWS Lambda for custom authorization logic. ABE provides clear, tailored guidance to users while maintaining a professional and approachable tone.

## Implementation Playbook
[Playbook (Contains all required information)](https://drive.google.com/file/d/1VGy9SLVDIfwF0VHEA8sdsHzm85cuEeG_/view?usp=sharing)

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (version 14.x or later)
- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/work-with-cdk-nodejs.html)
- [Python](https://www.python.org/) (for Lambda functions)
- [AWS CLI](https://aws.amazon.com/cli/) configured with your AWS credentials


## Development

Clone the repository and check all pre-requisites.

### Useful commands

* `git clone <Github url>` clone the repo
* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
* `npm i`  Install dependencies

### Deployment Instructions

1. Change the constants in `lib/constants.ts`
2. Install frontend dependencies: `cd lib/user-interface/app && npm install && cd ../../..`
3. Deploy: `npx cdk deploy ABEStackNonProd`
4. Configure Cognito using the CDK outputs

### Monitoring & Alerts

The stack deploys a CloudWatch monitoring construct that provides operational visibility into every layer of the application.

#### CloudWatch Dashboard

A pre-built dashboard named **`ABEStackNonProd-Operations`** is created automatically on deploy. It consolidates key metrics across the entire stack:

| Row | Widgets | What it shows |
|-----|---------|---------------|
| 1 | Lambda Invocations, Lambda Errors | Call volume and error counts for all key functions |
| 2 | Chat Lambda Duration, Lambda Throttles | Avg and p99 latency for the chat function; throttle events |
| 3 | HTTP API Requests & Errors, HTTP API Latency | Request counts, 4xx/5xx rates, avg and p99 latency |
| 4 | WebSocket Connections, DynamoDB Throttles | Connect/message counts; throttled requests per table |
| 5 | Eval Pipeline Executions, Active Alarms | Step Functions started/succeeded/failed; current alarm states |

**How to access the dashboard:**

1. Sign in to the [AWS Console](https://console.aws.amazon.com/) with the correct account (158878148642).
2. Navigate to **CloudWatch → Dashboards** (or search "CloudWatch" in the top search bar).
3. Select **`ABEStackNonProd-Operations`** from the dashboard list.
4. Alternatively, use the direct URL output by CDK after deploy — look for `DashboardURL` in the CloudFormation outputs, or run:

```bash
aws cloudformation describe-stacks --stack-name ABEStackNonProd \
  --query "Stacks[0].Outputs[?OutputKey=='MonitoringDashboardURL'].OutputValue" \
  --output text --profile 158878148642_eoanf-osd-ai-admins
```

> **Tip:** You can adjust the time range in the top-right corner of the dashboard (e.g., 1h, 3h, 12h, 1d, 1w) and enable auto-refresh to use it as a live operations screen.

#### Alarms

The following CloudWatch alarms are created automatically:

- **Lambda errors** — triggers when any Lambda function has errors (threshold: ≥1 error in 5 min)
- **Lambda throttles** — triggers when any Lambda function is throttled
- **Chat Lambda high latency** — triggers when average duration exceeds 60 seconds
- **API Gateway 5xx errors** — triggers on server-side errors
- **API Gateway 4xx errors** — triggers on elevated client errors
- **WebSocket zero connections** — detects potential outages (no connections for 15 min)
- **DynamoDB throttles** — triggers when any table experiences throttled requests
- **Eval pipeline failures** — triggers when the Step Functions evaluation pipeline fails

All alarms are visible on the dashboard's "Active Alarms" widget. You can also view them in **CloudWatch → Alarms → All alarms**.

#### Email Alerts

All alarms publish to an SNS topic. There are two ways to subscribe an email address for notifications:

**Option A: Via CDK at deploy time (recommended)**

Pass the `alarmEmail` context variable when deploying:

```bash
npx cdk deploy ABEStackNonProd -c alarmEmail=you@example.com
```

In CI/CD, set the `ALARM_EMAIL` GitHub Actions secret — the workflow passes it automatically. To change the alert recipient, update the secret and re-deploy; no code change required.

**Option B: Manually via the AWS Console**

If you want to add additional recipients or set up alerts without redeploying:

1. Sign in to the [AWS Console](https://console.aws.amazon.com/).
2. Navigate to **SNS → Topics**.
3. Find the topic named **`ABEStackNonProd Monitoring Alerts`** (or search for "Monitoring Alerts").
4. Click the topic, then click **Create subscription**.
5. Set **Protocol** to `Email` and **Endpoint** to the email address you want to receive alerts.
6. Click **Create subscription**.
7. Check the recipient's inbox for a **confirmation email** from AWS and click the confirmation link — subscriptions do not activate until confirmed.

> **Note:** You can add multiple email subscriptions (or use other protocols like SMS, HTTPS, or Slack via Lambda) by repeating the steps above. To unsubscribe, click the unsubscribe link at the bottom of any alert email, or delete the subscription from the SNS console.

## Architecture
![Architecture Flow](https://github.com/user-attachments/assets/e36f3313-b345-4e0d-8403-31e9b0473854)


## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/YourFeature`).
3. Make your changes and commit them (`git commit -m 'Add some feature'`).
4. Push to the branch (`git push origin feature/YourFeature`).
5. Open a pull request.

## Developers
  - [Prasoon Raj](https://www.linkedin.com/in/prasoon-raj-902/)
  - Rui Ge

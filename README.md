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

### Deployment Instructions:

1. Change the constants in lib/constants.ts!
2. Deploy with `npm run build && npx cdk deploy [stack name from constants.ts]`
3. Configure Cognito using the CDK outputs

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

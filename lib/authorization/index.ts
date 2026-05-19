import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { cognitoDomainName } from '../constants'
import { UserPool, UserPoolIdentityProviderOidc,UserPoolClient, UserPoolClientIdentityProvider, ProviderAttribute } from 'aws-cdk-lib/aws-cognito';
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as fs from 'fs';
import * as path from 'path';
import { MANAGED_LOGIN_BRANDING_SETTINGS } from './managed-login-branding';

// The Cognito Managed Login screen shows the OSD logo (not the state seal
// used in the in-app header) so users see the brand of the agency that owns
// the tool at sign-in.
const LOGIN_LOGO_PATH = path.join(
  __dirname,
  '../user-interface/app/public/images/osd-logo.png',
);
const LOGIN_LOGO_BASE64 = fs.readFileSync(LOGIN_LOGO_PATH).toString('base64');

export class AuthorizationStack extends Construct {
  public readonly lambdaAuthorizer : lambda.Function;
  public readonly userPool : UserPool;
  public readonly userPoolClient : UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id);

    // Replace these values with your Azure client ID, client secret, and issuer URL
    // const azureClientId = 'your-azure-client-id';
    // const azureClientSecret = 'your-azure-client-secret';
    // const azureIssuerUrl = 'https://your-azure-issuer.com';

    // Create the Cognito User Pool
    const userPool = new UserPool(this, 'UserPool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
      mfa: cognito.Mfa.OPTIONAL,
      featurePlan: cognito.FeaturePlan.PLUS,
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
      autoVerify: { email: true, phone: true },
      signInAliases: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      customAttributes: {
        'role': new cognito.StringAttribute({ minLen: 0, maxLen: 30, mutable: true }),
      },
    });
    this.userPool = userPool;

    // Create a provider attribute for mapping Azure claims
    // const providerAttribute = new ProviderAttribute({
    //   name: 'custom_attr',
    //   type: 'String',
    // });
    userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainName,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    
    
    // Add the Azure OIDC identity provider to the User Pool
    // const azureProvider = new UserPoolIdentityProviderOidc(this, 'AzureProvider', {
    //   clientId: azureClientId,
    //   clientSecret: azureClientSecret,
    //   issuerUrl: azureIssuerUrl,
    //   userPool: userPool,
    //   attributeMapping: {
    //     // email: ProviderAttribute.fromString('email'),
    //     // fullname: ProviderAttribute.fromString('name'),
    //     // custom: {
    //     //   customKey: providerAttribute,
    //     // },
    //   },
    //   // ... other optional properties
    // });

    const userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool,      
      // supportedIdentityProviders: [UserPoolClientIdentityProvider.custom(azureProvider.providerName)],
    });

    this.userPoolClient = userPoolClient;

    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: false,
      returnMergedResources: false,
      settings: MANAGED_LOGIN_BRANDING_SETTINGS,
      assets: [
        {
          bytes: LOGIN_LOGO_BASE64,
          category: 'FORM_LOGO',
          colorMode: 'LIGHT',
          extension: 'PNG',
        },
      ],
    });

    const authorizerHandlerFunction = new lambda.Function(this, 'AuthorizationFunction', {
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'websocket-api-authorizer')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "USER_POOL_ID" : userPool.userPoolId,
        "APP_CLIENT_ID" : userPoolClient.userPoolClientId
      },
      timeout: cdk.Duration.seconds(30)
    });

    this.lambdaAuthorizer = authorizerHandlerFunction;
    
    new cdk.CfnOutput(this, "UserPool ID", {
      value: userPool.userPoolId || "",
    });

    new cdk.CfnOutput(this, "UserPool Client ID", {
      value: userPoolClient.userPoolClientId || "",
    });

    // new cdk.CfnOutput(this, "UserPool Client Name", {
    //   value: userPoolClient.userPoolClientName || "",
    // });


    
  }
}

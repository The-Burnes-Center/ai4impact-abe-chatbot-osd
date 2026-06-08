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

export interface AuthorizationStackProps {
  /**
   * Sign-in / sign-out callback URLs for the app client. Lazy-resolved at synth to
   * the site URL (custom domain when bound, else the CloudFront domain) so they
   * always match the redirect URLs the frontend writes into aws-exports.json.
   */
  readonly callbackUrls: string[];
  /**
   * Name of the (console-managed) OIDC identity provider to enable on the app
   * client, e.g. "MassGov-Login". Supplied per-deployment via context/env — never
   * hardcoded — so each environment enables its own SSO provider, or none (in which
   * case only the built-in COGNITO provider is enabled). Must name a provider that
   * already exists in the pool, or the deploy will fail.
   */
  readonly oidcProviderName?: string;
}

export class AuthorizationStack extends Construct {
  public readonly lambdaAuthorizer : lambda.Function;
  public readonly userPool : UserPool;
  public readonly userPoolClient : UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthorizationStackProps) {
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

    // The app client's full OAuth/IdP configuration is declared here so it lives in
    // source control and a deploy can no longer silently reset it (the L2 emits every
    // field, so anything left unset reverts to a CDK/Cognito default on deploy).
    //
    // Security: the OAuth scopes intentionally EXCLUDE `aws.cognito.signin.user.admin`,
    // and the auth flows exclude USER_PASSWORD / USER_SRP, so no token a user can obtain
    // is able to call Cognito self-service APIs (UpdateUserAttributes) to self-assign
    // `custom:role: ["Admin"]`. Admin roles come only from the SSO IdP mapping
    // (roles -> custom:role). read/write attributes are deliberately left at the default
    // (ALL) so that IdP mapping can still write `custom:role` at federated sign-in.
    const supportedIdentityProviders = [UserPoolClientIdentityProvider.COGNITO];
    if (props.oidcProviderName) {
      supportedIdentityProviders.push(
        UserPoolClientIdentityProvider.custom(props.oidcProviderName),
      );
    }

    const userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool,
      authFlows: { custom: true }, // -> ALLOW_CUSTOM_AUTH + ALLOW_REFRESH_TOKEN_AUTH (no password / SRP)
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.PHONE,
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.callbackUrls,
      },
      supportedIdentityProviders,
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
      authSessionValidity: cdk.Duration.minutes(3),
      enableTokenRevocation: true,
    });

    // The L2 always serialises refresh-token validity in minutes (30 days -> 43200).
    // Pin it back to days on the L1 child so the synthesized template matches the live
    // client byte-for-byte and no needless diff is produced (43200 minutes == 30 days).
    const cfnUserPoolClient = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
    cfnUserPoolClient.refreshTokenValidity = 30;
    cfnUserPoolClient.tokenValidityUnits = {
      accessToken: 'minutes',
      idToken: 'minutes',
      refreshToken: 'days',
    };

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

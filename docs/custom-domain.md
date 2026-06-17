# Custom domain & SSL certificate

How to put the ABE web app behind a custom domain (e.g. `app.example.gov`) with HTTPS. Walks through the **AWS Console** steps for the certificate and Cognito, plus the per-deployment config that actually binds the domain.

---

## How it works

- The app is served from S3 through a **CloudFront distribution**, and **TLS terminates at CloudFront**. The SSL certificate is attached to that distribution as the cert for its *alternate domain name (CNAME)*.
- The certificate must be an **AWS Certificate Manager (ACM) certificate in `us-east-1`** — CloudFront only accepts certs from us-east-1, regardless of where the rest of the stack runs — and it must live in the **same AWS account** as the distribution.
- Binding is **config-gated and never hardcoded**: you supply two values at deploy time — the hostname (`customDomain`) and the cert ARN (`certificateArn`). With neither set, the app stays on the default `*.cloudfront.net` domain. So each branch/account brings its own domain, or none.

| Thing | Where it's done | Managed by |
|---|---|---|
| ACM certificate | ACM console (us-east-1) | Manual / out-of-band (not CloudFormation) |
| DNS records (validation + app) | The domain's DNS zone | Whoever owns the zone |
| Alias + cert on the distribution | CDK config (context / CI vars) | CDK / CloudFormation |
| Cognito callback + sign-out URLs | CDK config (derived from the bound domain) | CDK / CloudFormation |
| SSO provider on the app client | CDK config (`OIDC_PROVIDER_NAME`) — the provider itself is created in the Cognito console | CDK / CloudFormation |
| Sign-in/out redirects + API/S3 CORS origin | CDK config (derived from the bound domain) | CDK / CloudFormation |

> **Why the cert is requested by hand and not in CDK:** ACM DNS validation depends on a record being added to the domain's zone (often by a different team). Putting the cert in the stack would hang `cdk deploy` until that record exists. So the cert is created out-of-band (Steps 1–2) and the stack only *references* its ARN (Step 3).

---

## Prerequisites

- Access to the AWS account that holds the stack — Console access, and the ability to request an ACM certificate in **us-east-1**.
- Ability to add DNS records in the domain's zone, or someone who can (e.g. the team that owns the domain).
- For the CI binding option: admin on the GitHub repo (to add an Actions Variable + Secret).

---

## Step 1 — Request the certificate (ACM console)

1. Open **AWS Certificate Manager (ACM)**. **Set the Region to `US East (N. Virginia) / us-east-1`** in the top-right Region selector — this is required for CloudFront.
2. Click **Request** → **Request a public certificate** → **Next**.
3. **Fully qualified domain name:** enter your hostname, e.g. `app.example.gov`.
4. **Validation method:** select **DNS validation – recommended**.
5. **Key algorithm:** leave **RSA 2048** (default). Click **Request**.
6. Open the new certificate from the list — its status is **Pending validation**.

## Step 2 — Validate the certificate (DNS CNAME)

1. On the certificate page, under **Domains**, copy the **CNAME name** and **CNAME value**.
   - If the domain's zone is in **Route 53 in this same account**, click **Create records in Route 53** — done.
   - Otherwise, send the CNAME name + value to whoever manages the zone and have them add a **CNAME** record.
2. The values are shown **fully-qualified (with a trailing dot)**. Enter them so they're treated as **absolute** — in particular, don't let the DNS system append the zone to the **value** (`…acm-validations.aws`), or validation will never complete.
3. **CAA gotcha:** if the domain has a CAA record, it must allow Amazon (`amazon.com` / `amazontrust.com`) as a certificate authority, or ACM can't issue.
4. Wait until the certificate status flips to **Issued** (usually a few minutes after the record propagates).
5. Copy the certificate **ARN** — `arn:aws:acm:us-east-1:<account-id>:certificate/<id>`.

## Step 3 — Bind the domain to the distribution

You have two ways to attach the alias + cert. **Method B is the one that persists on this codebase** — read the warning under Method A first.

### Method A — CloudFront console (manual)

1. Open the **CloudFront** console → **Distributions** → select the app's distribution (match it by its domain, e.g. `xxxxxxxx.cloudfront.net`, or its S3 origin name).
2. **General** tab → **Settings** → **Edit**.
3. **Alternate domain names (CNAME):** add your hostname (`app.example.gov`).
4. **Custom SSL certificate:** choose your ACM certificate (it must be **Issued** and in **us-east-1**).
5. **Save changes.**

> ⚠️ **This stack's distribution is created and redeployed by CDK** (on every push to `main`). A change you make by hand in the CloudFront console is **drift** — the next `cdk deploy` rebuilds the distribution from the CDK definition and **drops your manual alias/cert**. Use Method A only for a quick test, or for a distribution that isn't managed by this stack. To make the binding stick, use **Method B**.

### Method B — CDK config (persistent)

Supply the hostname + cert ARN to the deployment. Pick one:

**CI (recommended) — GitHub Actions.** In the repo, add:
- **Variable** `CUSTOM_DOMAIN` = `app.example.gov`
- **Secret** `CERTIFICATE_ARN` = the ARN from Step 2
- **Variable** `OIDC_PROVIDER_NAME` = your SSO provider's name — required if the app uses SSO (see Step 5); leave unset only for a COGNITO-only pool

Then push to `main`, **or re-run the latest deploy workflow** (a re-run reads the current Variables/Secret at runtime, so you don't need a new commit). The workflow only passes the domain through when **both** `CUSTOM_DOMAIN` and `CERTIFICATE_ARN` are set. Scope them per environment with **GitHub Environments** so other branches/stacks don't inherit them (if there's no Environment, repo-level values apply to all branches).

**Manual deploy — CDK context.**
```bash
export AWS_PROFILE=<your-aws-profile>
npx cdk deploy ABEStackNonProd \
  -c customDomain=app.example.gov \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<id> \
  -c oidcProviderName=<your-sso-provider>   # omit only if the pool is COGNITO-only
```

> ⚠️ These values must be supplied on **every** deploy. A deploy without `customDomain`/`certificateArn` removes the alias/cert and reverts the app to the `*.cloudfront.net` domain; a deploy without `oidcProviderName` **drops the SSO provider from the app client and breaks sign-in**. The CI option handles this automatically as long as the repo Variables/Secret stay set — if you ever deploy manually, pass *all* the flags (plus any others CI sets, e.g. `alarmEmail`).

## Step 4 — Point your domain at CloudFront

In the domain's DNS zone, add a **CNAME**: `app.example.gov` → the distribution domain (`xxxxxxxx.cloudfront.net`). Find the distribution domain in the **CloudFormation stack outputs** (`UserInterfaceDomainName`) or in the CloudFront console.

## Step 5 — Sign-in URLs & SSO provider (automatic via CDK — do *not* edit the console)

The Cognito app client — its **callback + sign-out URLs**, OAuth scopes, and which **SSO identity provider** is enabled — is **fully declared in CDK** (`lib/authorization/index.ts`, brought in by commit *"Bring Cognito app client config into CDK"*). There is **no manual Cognito console step** for sign-in URLs:

- **Callback + sign-out URLs** are set to the bound domain (`https://app.example.gov`) automatically when you complete Step 3 Method B — together with the app's sign-in/out redirects in `aws-exports.json` and the HTTP API + S3 **CORS** origin. They all derive from one `siteUrl`, so they can never drift apart.
- **SSO provider:** the identity provider object (issuer, client secret, attribute mapping) is created **once in the Cognito console**, out of band. CDK only *enables* it on the app client, by name, via the `OIDC_PROVIDER_NAME` value from Step 3. **If `OIDC_PROVIDER_NAME` is unset on a deploy, the app client is rebuilt with only the built-in COGNITO provider and SSO breaks** — so keep it set for any SSO environment.

> ⚠️ **Do not add callback URLs in the Cognito console.** The app client is rebuilt from `lib/authorization/index.ts` on every deploy, so a manual console edit is **drift that the next `cdk deploy` silently overwrites** (the client was deliberately codified to stop exactly this). To change sign-in URLs, change the bound domain (Step 3) and redeploy. The client is set to a **single** callback URL (the bound domain), so the old `*.cloudfront.net` URL stops being a valid sign-in target after cutover — this is expected.

> After cutover, use the custom domain. Loading the app via the raw `*.cloudfront.net` URL still serves the static files, but **sign-in and API calls will fail** — the callback URL and CORS origin are now the custom domain.

## Step 6 — Verify

- `https://app.example.gov` loads the app over HTTPS with a valid certificate (no browser warning).
- SSO sign-in completes and redirects back to the custom domain.
- Chat works — no CORS errors in the browser console (WebSocket + API calls succeed).

After the deploy, you can confirm all four CDK-managed pieces switched to the new domain (replace IDs with your stack's):

```bash
# 1. DNS + TLS + CloudFront serving the domain
curl -sI https://app.example.gov | head -5

# 2. App config the browser fetches — redirectSignIn/Out should be the custom domain
curl -s https://app.example.gov/aws-exports.json | tr ',' '\n' | grep -i redirect

# 3. Cognito callback/logout URLs should include the custom domain
aws cognito-idp describe-user-pool-client --region us-east-1 \
  --user-pool-id <pool-id> --client-id <client-id> \
  --query 'UserPoolClient.{Callback:CallbackURLs,Logout:LogoutURLs,IdPs:SupportedIdentityProviders}'

# 4. HTTP API CORS AllowOrigins should include the custom domain
aws apigatewayv2 get-api --region us-east-1 --api-id <http-api-id> \
  --query 'CorsConfiguration.AllowOrigins'
```

## Troubleshooting

**Symptom: the custom domain loads but the UI hangs on a spinner (or chat shows CORS errors), even though the cert is `Issued` and the page returns HTTP 200.**

The static site is served, but the app's auth/API config is still pinned to the old `*.cloudfront.net` domain. These values are baked at **deploy time**, so adding the CloudFront alias + DNS by hand is *not* enough — the stack must be **deployed with the domain bound**. Almost always the last deploy ran **without** `CUSTOM_DOMAIN` + `CERTIFICATE_ARN` (so `aws-exports.json` redirects, the Cognito callback URLs, and the API CORS origin all fell back to CloudFront). Fix: set the values (Step 3 Method B) and redeploy — don't hand-patch Cognito/CORS/`aws-exports.json`, since the next deploy reverts manual edits.

**Symptom: sign-in suddenly fails after a deploy that was otherwise fine.** The deploy likely ran without `OIDC_PROVIDER_NAME`, dropping the SSO provider from the app client. Re-add the Variable and redeploy.

---

## Removing or changing the domain

- **Remove:** clear `CUSTOM_DOMAIN` / `CERTIFICATE_ARN` (or deploy without the `-c` flags). The next deploy reverts the app to the default CloudFront domain.
- **Change:** request a new cert for the new hostname (Steps 1–2), update the two values and redeploy (Step 3), then update the DNS (Step 4) and Cognito URLs (Step 5).

## How it's wired (for maintainers)

`bin/gen-ai-mvp.ts` reads `customDomain` / `certificateArn` / `oidcProviderName` from CDK context (falling back to the `CUSTOM_DOMAIN` / `CERTIFICATE_ARN` / `OIDC_PROVIDER_NAME` env vars) and passes them to `GenAiMvpStack`. There, a single `siteUrl` is computed — the custom domain when **both** domain values are present, else the CloudFront domain — and fed via `Lazy` tokens into four places so they can't drift apart:

1. **CloudFront** alias + imported ACM cert (`UserInterface` → `Website`: `domainNames` + `certificate`)
2. **Cognito app client** callback + sign-out URLs (`AuthorizationStack`, via the `callbackUrls` prop)
3. **HTTP API + S3 CORS** origin (`allowedOrigin`)
4. **`aws-exports.json`** `redirectSignIn` / `redirectSignOut` (written by `UserInterface` into the S3 deployment)

`oidcProviderName` separately controls whether the SSO identity provider is enabled on the app client. The domain binding only renders when both domain values are present, so the default (CloudFront) path is unchanged for deployments that don't set them.

### Example mapping (this project)

| Environment | Hostname | Stack | Distribution |
|---|---|---|---|
| Dev / non-prod | `buyers.dev.virtualassistant.mass.gov` | `ABEStackNonProd` | `d39g9hl1ouzq6z.cloudfront.net` |
| Prod | `buyers.virtualassistant.mass.gov` | (future prod stack) | (future) |

> DNS for `virtualassistant.mass.gov` is managed externally by the Mass DNS team (there is no Route 53 zone in the account), so Steps 2 and 4 are handled on their side.

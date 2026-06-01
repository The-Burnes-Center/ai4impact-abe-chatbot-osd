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
| Cognito callback + sign-out URLs | Cognito console | Manual (not CDK) |

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

Then push to `main` (or re-run the deploy workflow). The workflow only passes them through when **both** are set. Scope them per environment with **GitHub Environments** so other branches/stacks don't inherit them.

**Manual deploy — CDK context.**
```bash
export AWS_PROFILE=<your-aws-profile>
npx cdk deploy ABEStackNonProd \
  -c customDomain=app.example.gov \
  -c certificateArn=arn:aws:acm:us-east-1:<account-id>:certificate/<id>
```

> The values must be supplied on **every** deploy. If a later deploy runs without them, CloudFormation removes the alias/cert. The CI option handles this automatically; if you deploy manually, always pass the flags.

## Step 4 — Point your domain at CloudFront

In the domain's DNS zone, add a **CNAME**: `app.example.gov` → the distribution domain (`xxxxxxxx.cloudfront.net`). Find the distribution domain in the **CloudFormation stack outputs** (`UserInterfaceDomainName`) or in the CloudFront console.

## Step 5 — Update Cognito sign-in URLs (console)

Sign-in is federated SSO, and the app client's redirect URLs are **managed in the Cognito console, not in CDK** — so add the new domain there or sign-in will fail:

1. **Cognito** console → **User pools** → select the pool → **App integration** → **App clients** → select the app client.
2. Edit the **login pages / Hosted UI** settings.
3. Add `https://app.example.gov` to **Allowed callback URLs** and **Allowed sign-out URLs**. Keep the existing `*.cloudfront.net` entries during the transition.
4. **Save.**

> When the custom domain is bound (Step 3 Method B), the app's sign-in/out redirects and the HTTP API + S3 **CORS** origin switch to it automatically. After cutover, use the custom domain — loading the app via the raw `*.cloudfront.net` URL still serves pages, but its API calls will be CORS-blocked.

## Step 6 — Verify

- `https://app.example.gov` loads the app over HTTPS with a valid certificate (no browser warning).
- SSO sign-in completes and redirects back to the custom domain.
- Chat works — no CORS errors in the browser console (WebSocket + API calls succeed).

---

## Removing or changing the domain

- **Remove:** clear `CUSTOM_DOMAIN` / `CERTIFICATE_ARN` (or deploy without the `-c` flags). The next deploy reverts the app to the default CloudFront domain.
- **Change:** request a new cert for the new hostname (Steps 1–2), update the two values and redeploy (Step 3), then update the DNS (Step 4) and Cognito URLs (Step 5).

## How it's wired (for maintainers)

`bin/gen-ai-mvp.ts` reads `customDomain` / `certificateArn` from CDK context (falling back to the `CUSTOM_DOMAIN` / `CERTIFICATE_ARN` env vars) → `GenAiMvpStack` → `UserInterface` → `Website`, which adds `domainNames` + the imported ACM `certificate` to the CloudFront distribution and flips the Cognito redirect + CORS origin. The binding only renders when **both** values are present, so the default path is unchanged.

### Example mapping (this project)

| Environment | Hostname | Stack | Distribution |
|---|---|---|---|
| Dev / non-prod | `buyers.dev.virtualassistant.mass.gov` | `ABEStackNonProd` | `d39g9hl1ouzq6z.cloudfront.net` |
| Prod | `buyers.virtualassistant.mass.gov` | (future prod stack) | (future) |

> DNS for `virtualassistant.mass.gov` is managed externally by the Mass DNS team (there is no Route 53 zone in the account), so Steps 2 and 4 are handled on their side.

#!/usr/bin/env node
/**
 * Backfill metadata summaries for every file in the Knowledge Source bucket.
 *
 * The metadata-handler Lambda generates summaries + tags on S3 ObjectCreated
 * events, but a long-standing bug skipped all ObjectCreated:Copy events to
 * avoid recursion from its own self-copy. The sync-orchestrator pushes files
 * into the KB bucket via s3.copy_object(), so every sync-pushed file silently
 * skipped processing and ended up with empty {} in metadata.txt.
 *
 * That bug is now fixed (recursion guard checks for an existing `summary`
 * marker instead of skipping all copies). This script triggers processing for
 * every existing file by invoking the metadata-handler Lambda with a synthetic
 * ObjectCreated:Put event, throttled to avoid hammering Bedrock.
 *
 * Usage:
 *   AWS_PROFILE=158878148642_eoanf-osd-ai-admins AWS_REGION=us-east-1 \
 *     node scripts/backfill-metadata.mjs [--bucket <name>] [--function <name>] \
 *     [--concurrency 3] [--force] [--dry-run]
 *
 * Defaults are resolved from the ABEStackNonProd CloudFormation stack if not
 * supplied on the command line.
 */

import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";

const region = process.env.AWS_REGION || "us-east-1";
const args = parseArgs(process.argv.slice(2));

const cfn = new CloudFormationClient({ region });
const s3 = new S3Client({ region });
const lambda = new LambdaClient({ region });

async function main() {
  const stackName = args.stack || "ABEStackNonProd";
  const bucket = args.bucket || await resolveResource(stackName, "AWS::S3::Bucket", /KnowledgeSourceBucket/);
  const fnName = args.function || await resolveResource(stackName, "AWS::Lambda::Function", /MetadataHandlerFunction/);

  console.log(`Stack:    ${stackName}`);
  console.log(`Bucket:   ${bucket}`);
  console.log(`Function: ${fnName}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Force re-process even when summary exists: ${args.force ? "yes" : "no"}`);
  console.log(`Dry run:  ${args.dryRun ? "yes" : "no"}\n`);

  const keys = await listAllKeys(bucket);
  const docKeys = keys.filter(k => k !== "metadata.txt");
  console.log(`Found ${docKeys.length} object(s) in bucket (excluding metadata.txt).`);

  const queue = [...docKeys];
  let processed = 0, skipped = 0, failed = 0;

  const workers = Array.from({ length: args.concurrency }, async (_, idx) => {
    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) return;
      try {
        if (!args.force) {
          const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          if (head.Metadata && head.Metadata.summary) {
            skipped++;
            console.log(`[skip] ${key} (summary already set)`);
            continue;
          }
        }
        if (args.dryRun) {
          console.log(`[dry-run] would invoke for ${key}`);
          processed++;
          continue;
        }
        const event = syntheticS3Event(bucket, key);
        await lambda.send(new InvokeCommand({
          FunctionName: fnName,
          InvocationType: "Event", // async; the handler runs in background
          Payload: Buffer.from(JSON.stringify(event)),
        }));
        processed++;
        console.log(`[invoke] ${key}`);
      } catch (e) {
        failed++;
        console.error(`[fail]   ${key} — ${e.message}`);
      }
    }
  });

  await Promise.all(workers);
  console.log(`\nDone. Invoked: ${processed}, Skipped: ${skipped}, Failed: ${failed}`);
  console.log("Lambda invocations are asynchronous. Watch CloudWatch logs for the metadata-handler to see per-file progress.");
}

function syntheticS3Event(bucket, key) {
  return {
    Records: [
      {
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        s3: {
          bucket: { name: bucket },
          object: { key: encodeURIComponent(key).replace(/%2F/g, "/") },
        },
      },
    ],
  };
}

async function resolveResource(stackName, type, nameRegex) {
  const resp = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const match = (resp.StackResources || []).find(r =>
    r.ResourceType === type && nameRegex.test(r.LogicalResourceId || "")
  );
  if (!match) throw new Error(`Could not resolve ${type} matching ${nameRegex} in ${stackName}`);
  return match.PhysicalResourceId;
}

async function listAllKeys(bucket) {
  const keys = [];
  let token;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
    }));
    for (const obj of resp.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function parseArgs(argv) {
  const out = { concurrency: 3, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bucket") out.bucket = argv[++i];
    else if (a === "--function") out.function = argv[++i];
    else if (a === "--stack") out.stack = argv[++i];
    else if (a === "--concurrency") out.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/backfill-metadata.mjs [options]

Options:
  --stack <name>         CloudFormation stack name (default: ABEStackNonProd)
  --bucket <name>        KB bucket physical name (auto-resolved from stack if omitted)
  --function <name>      Metadata-handler Lambda physical name (auto-resolved if omitted)
  --concurrency <n>      Parallel invocations (default: 3)
  --force                Re-process files even if their head metadata already has a summary
  --dry-run              List what would be invoked, but don't actually invoke
  -h, --help             Show this help
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

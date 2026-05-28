"""Generate ABE architecture diagram using the Python diagrams DSL.

Render with:
    python -m venv .venv && . .venv/bin/activate
    pip install diagrams           # requires the graphviz `dot` binary on PATH
    python docs/generate_architecture.py
Produces docs/architecture.png.
"""
import os
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.network import CloudFront, APIGateway
from diagrams.aws.security import WAF, Cognito
from diagrams.aws.ml import Bedrock
from diagrams.aws.integration import SQS, StepFunctions, SNS, Eventbridge
from diagrams.aws.storage import S3
from diagrams.aws.analytics import AmazonOpensearchService
from diagrams.aws.management import Cloudwatch
from diagrams.onprem.client import Users
from diagrams.programming.framework import React

os.chdir(os.path.dirname(os.path.abspath(__file__)))

graph_attr = {
    "fontsize": "14",
    "fontname": "Helvetica",
    "bgcolor": "white",
    "pad": "0.5",
    "nodesep": "0.6",
    "ranksep": "1.1",
}

edge_attr = {
    "color": "#555555",
    "penwidth": "1.5",
}

node_attr = {
    "fontsize": "11",
    "fontname": "Helvetica",
}

with Diagram(
    "ABE — Assistive Buyers Engine",
    show=False,
    filename="architecture",
    outformat="png",
    direction="LR",
    graph_attr=graph_attr,
    edge_attr=edge_attr,
    node_attr=node_attr,
):
    users = Users("Users")

    with Cluster("CDN & Auth"):
        waf = WAF("WAF")
        cf = CloudFront("CloudFront")
        cognito = Cognito("Cognito\n(OIDC / SSO)")
        frontend = React("React App\n(Vite + MUI)")

    with Cluster("API Layer"):
        rest = APIGateway("REST API")
        ws = APIGateway("WebSocket API")
        authorizer = Lambda("JWT Authorizer\n(Lambda)")

    with Cluster("Chat & RAG"):
        chat_fn = Lambda("Chat Lambda\n(Node.js, agentic loop)")
        bedrock_chat = Bedrock("Bedrock\nClaude Opus 4.6 / Sonnet 4.6")
        kb = Bedrock("Bedrock\nKnowledge Base")
        opensearch = AmazonOpensearchService("OpenSearch\nServerless")

    with Cluster("Excel Index"):
        idx_query = Lambda("Index Query\nLambda")
        idx_parser = Lambda("Index Parser\nLambda (S3 trigger)")
        idx_ddb = Dynamodb("DynamoDB\nExcelIndexData")
        idx_s3 = S3("S3\nContract Index Bucket")

    with Cluster("Data Ingestion & Sync"):
        upload_fn = Lambda("Upload / Knowledge\nMgmt Lambdas")
        staging_s3 = S3("S3\nData Staging")
        sync_fn = Lambda("Sync Orchestrator\nLambda")
        eventbridge = Eventbridge("EventBridge\nScheduler (weekly)")
        kb_s3 = S3("S3\nKnowledge Source")

    with Cluster("Sessions & Feedback"):
        session_fn = Lambda("Session / Feedback\nLambdas (Python)")
        session_ddb = Dynamodb("DynamoDB\nSessions & Feedback")

    with Cluster("LLM Evaluation Pipeline"):
        sfn = StepFunctions("Step Functions\n(Split > RAGAS > Agg > Save)")
        eval_ddb = Dynamodb("DynamoDB\nEval Results")
        eval_s3 = S3("S3\nEval Results")

    with Cluster("Feedback to Test Library"):
        sqs = SQS("SQS Queue\n(+ DLQ)")
        process_fn = Lambda("Process Lambda")
        rewrite = Bedrock("Bedrock\n(Rewrite Q)")
        test_lib = Dynamodb("DynamoDB\nTest Library")

    with Cluster("Analytics"):
        faq_fn = Lambda("FAQ Classifier\nLambda")
        analytics_ddb = Dynamodb("DynamoDB\nAnalytics")

    with Cluster("Monitoring"):
        cw = Cloudwatch("CloudWatch\nDashboard + Alarms")
        sns = SNS("SNS\nEmail Alerts")

    # User > CDN > Frontend > API
    users >> waf >> cf >> frontend
    cognito - Edge(style="dashed", label="Auth") - cf
    frontend >> rest
    frontend >> ws

    # WebSocket connect is JWT-authorized by a Lambda authorizer
    ws >> Edge(style="dashed", label="JWT") >> authorizer

    # Chat flow + agent tools
    ws >> chat_fn
    chat_fn >> Edge(label="LLM") >> bedrock_chat
    chat_fn >> Edge(label="query_db") >> kb >> opensearch
    chat_fn >> Edge(label="query_excel_index") >> idx_query >> idx_ddb

    # Excel index ingestion: index bucket S3 event -> parser -> DynamoDB
    idx_s3 >> Edge(label="S3 event") >> idx_parser >> idx_ddb

    # Data ingestion & sync: upload to staging, then orchestrator fans out
    rest >> upload_fn >> Edge(label="upload") >> staging_s3
    eventbridge >> Edge(label="weekly") >> sync_fn
    rest >> Edge(label="sync now") >> sync_fn
    staging_s3 >> sync_fn
    sync_fn >> Edge(label="docs") >> kb_s3
    sync_fn >> Edge(label="indexes") >> idx_s3
    sync_fn >> Edge(label="start ingestion") >> kb
    kb_s3 >> kb

    # Sessions & feedback
    rest >> session_fn >> session_ddb

    # Eval pipeline
    rest >> sfn
    sfn >> eval_ddb
    sfn >> eval_s3

    # Positive feedback > Test Library (SQS-buffered LLM rewrite)
    session_fn >> Edge(label="thumbs-up") >> sqs >> process_fn >> rewrite >> test_lib

    # Analytics
    chat_fn - Edge(style="dashed") - faq_fn >> analytics_ddb

    # Monitoring
    cw >> sns

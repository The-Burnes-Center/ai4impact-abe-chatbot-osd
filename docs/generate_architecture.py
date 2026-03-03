"""Generate ABE architecture diagram using the Python diagrams DSL."""
import os
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.network import CloudFront, APIGateway
from diagrams.aws.security import WAF, Cognito
from diagrams.aws.ml import Bedrock
from diagrams.aws.integration import SQS, StepFunctions, SNS
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
    "ranksep": "1.0",
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
        cognito = Cognito("Cognito\n(OIDC/SSO)")
        frontend = React("React App\n(Vite + MUI)")

    with Cluster("API Layer"):
        rest = APIGateway("REST API")
        ws = APIGateway("WebSocket API")

    with Cluster("Chat & RAG"):
        chat_fn = Lambda("Chat Lambda\n(Node.js)")
        bedrock_chat = Bedrock("Bedrock\nClaude Sonnet 4")
        kb = Bedrock("Bedrock\nKnowledge Base")
        opensearch = AmazonOpensearchService("OpenSearch\nServerless")

    with Cluster("Contract & Trade Index"):
        idx_query = Lambda("Index Query\nLambda")
        idx_parser = Lambda("Index Parser\nLambda (S3 trigger)")
        idx_ddb = Dynamodb("DynamoDB\nIndex Tables")
        idx_s3 = S3("S3\nIndex Bucket")

    with Cluster("Session & Knowledge Mgmt"):
        session_fn = Lambda("Session / Feedback\nLambdas (Python)")
        session_ddb = Dynamodb("DynamoDB\nSessions & Feedback")
        kb_mgmt = Lambda("Knowledge Mgmt\nLambdas")
        kb_s3 = S3("S3\nKnowledge Bucket")

    with Cluster("LLM Evaluation Pipeline"):
        sfn = StepFunctions("Step Functions\n(Split > RAGAS > Agg > Save)")
        eval_ddb = Dynamodb("DynamoDB\nEval Results")
        eval_s3 = S3("S3\nEval Results")

    with Cluster("Feedback to Test Library"):
        sqs = SQS("SQS Queue")
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

    # Chat flow
    ws >> chat_fn
    chat_fn >> bedrock_chat
    chat_fn >> kb >> opensearch
    chat_fn >> idx_query >> idx_ddb

    # Contract index (admin uploads .xlsx via REST presigned URL → S3 → parser)
    rest >> Edge(label="upload") >> idx_s3
    idx_s3 >> idx_parser >> idx_ddb

    # Session & Knowledge
    rest >> session_fn >> session_ddb
    rest >> kb_mgmt >> kb_s3
    kb_s3 >> kb

    # Eval pipeline
    rest >> sfn
    sfn >> eval_ddb
    sfn >> eval_s3

    # Feedback > Test Library
    rest >> sqs >> process_fn >> rewrite >> test_lib

    # Analytics
    chat_fn - Edge(style="dashed") - faq_fn >> analytics_ddb

    # Monitoring
    cw >> sns

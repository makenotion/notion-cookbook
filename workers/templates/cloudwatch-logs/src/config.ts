import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs"

export const REGION = process.env.AWS_REGION ?? "us-east-1"

export const logsClient = new CloudWatchLogsClient({ region: REGION })

# Worker tool: CloudWatch Logs

A Notion worker that lets a custom agent browse and read AWS CloudWatch Logs. It registers three tools:

- `listLogGroups` lists log groups matching a name prefix.
- `getLogStreams` lists log streams within a group, ordered by most recent activity.
- `getLogEvents` fetches events from a specific stream with optional time filtering.

Together they let the agent find the right log group, narrow to a stream, and read the events — without anyone digging through the AWS console. Everything runs on Notion Workers, so there is no separate service to host.

## How it works

```
src/
  index.ts   Worker definition and the three tools
  config.ts  CloudWatch client and error helper
```

The tools chain naturally: `listLogGroups` → `getLogStreams` → `getLogEvents`. All three return paginated, capped results so responses stay readable in the agent conversation.

## Tools

### `listLogGroups`

Lists log groups matching a name prefix. Results are capped at 50; default is 10.

Common prefixes:

- `/aws/lambda/` — Lambda function logs
- `/aws/kinesis-analytics/` — Kinesis Data Analytics / Flink job logs

### `getLogStreams`

Lists streams in a log group ordered by most recent event. Results are capped at 50; default is 10.

Pass `filterPrefix` to narrow by stream name prefix. For Airflow-style log groups that name streams after their tasks, `dag_id=my_dag_name` scopes results to a specific workflow.

### `getLogEvents`

Fetches events from a single stream in chronological order. Results are capped at 500; default is 100.

Pass `startTime` and/or `endTime` as ISO 8601 strings (e.g. `"2024-06-01T12:00:00Z"`) to filter by time range.

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/cloudwatch-logs
npm install
```

> **Note:** The AWS SDK has a large dependency tree. Expect `node_modules` to be 50-80 MB after install.

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name cloudwatch-logs
```

### 5. Set environment variables

```zsh
ntn workers env set AWS_REGION=us-east-1
ntn workers env set AWS_ACCESS_KEY_ID=your_access_key_id
ntn workers env set AWS_SECRET_ACCESS_KEY=your_secret_access_key
# Only needed for temporary credentials (e.g. assumed roles):
# ntn workers env set AWS_SESSION_TOKEN=your_session_token
```

### 6. Connect to an agent

Once deployed, add the worker to a custom agent under **Tools and access > Add connection**. The agent can then call `listLogGroups`, `getLogStreams`, and `getLogEvents`.

A prompt like:

> What errors appeared in the my-function Lambda logs in the last hour?

will have the agent list groups, find the right stream, and fetch the events.

## AWS credentials and IAM permissions

The worker uses the standard AWS SDK credential provider chain. Set credentials via environment variables (above) or, if running on EC2/ECS, rely on the instance or task role — the worker only reads `AWS_REGION` plus the standard `AWS_*` credential variables.

The IAM principal needs these permissions on the relevant log groups:

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:DescribeLogGroups",
    "logs:DescribeLogStreams",
    "logs:GetLogEvents"
  ],
  "Resource": "*"
}
```

Scope `Resource` to specific log group ARNs in production to follow least-privilege.

> **Note on error messages:** tool errors are returned to the agent verbatim to help it self-correct. An AWS authorization failure can include the caller's account id and IAM principal ARN (e.g. `User: arn:aws:iam::123456789012:user/foo is not authorized...`). That's your own identity surfaced to your own agent, but if you expose this worker more broadly, sanitize errors before returning them.

## Local testing

Copy `.env.example` to `.env`, fill in `AWS_REGION` and your AWS credentials, then run a tool without deploying:

```zsh
ntn workers exec listLogGroups --local -d '{"prefix": "/aws/lambda/", "limit": 5}'
ntn workers exec getLogStreams --local -d '{"logGroupName": "/aws/lambda/my-function", "limit": 5}'
ntn workers exec getLogEvents --local -d '{"logGroupName": "/aws/lambda/my-function", "logStreamName": "2024/06/01/[$LATEST]abc123", "limit": 10}'
```

Run the offline unit tests (no AWS needed):

```zsh
npm test
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [AWS CloudWatch Logs API reference](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)

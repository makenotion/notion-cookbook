# Examples

This directory contains working code examples that demonstrate how to build integrations with Notion's API.

## Available examples

### JavaScript

The [javascript](javascript/) directory includes examples built with Notion's official JavaScript SDK:

- **[intro-to-notion-api](javascript/intro-to-notion-api/)**: Learn the basics with simple examples of creating blocks, databases, and pages
- **[database-email-update](javascript/database-email-update/)**: Watch a database for changes and send email notifications
- **[generate-random-data](javascript/generate-random-data/)**: Populate a database with sample data for testing
- **[notion-github-sync](javascript/notion-github-sync/)**: Sync GitHub issues to a Notion database
- **[notion-task-github-pr-sync](javascript/notion-task-github-pr-sync/)**: Connect Notion tasks to GitHub pull requests
- **[parse-text-from-any-block-type](javascript/parse-text-from-any-block-type/)**: Extract text content from different block types
- **[web-form-with-express](javascript/web-form-with-express/)**: Build a web form that submits data to Notion

### Workers

The [workers](workers/) directory includes examples built with the [Notion Workers](https://developers.notion.com/docs/workers) platform:

- **[syncs/zendesk](workers/syncs/zendesk/)**: One-way sync from Zendesk tickets into a Notion database _(coming soon)_
- **[syncs/salesforce](workers/syncs/salesforce/)**: One-way sync from Salesforce records into a Notion database _(coming soon)_
- **[syncs/linear](workers/syncs/linear/)**: One-way sync from Linear issues into a Notion database _(coming soon)_
- **[tools/snowflake-query](workers/tools/snowflake-query/)**: Query Snowflake from a Notion agent and return results _(coming soon)_
- **[tools/spotify-control](workers/tools/spotify-control/)**: Start and control Spotify playback from a Notion agent _(coming soon)_


## Running an example

Each example has its own README with specific instructions. Generally you'll need to:

1. Create a [Notion integration](https://www.notion.com/my-integrations)
2. Share your test page or database with the integration
3. Set up environment variables (usually in a `.env` file)
4. Install dependencies with `npm install`
5. Run the example

## Contributing examples

Have an example you'd like to share? See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines on adding examples.

When adding an example:

- Include a clear README explaining what it does and how to use it
- Add any necessary configuration files (package.json, tsconfig.json, etc.)
- Make sure it's tested and works as documented
- Keep it focused on demonstrating a specific technique or integration

## Other languages

Currently we only have JavaScript examples, but we'd love to add examples in other languages. If you've built something in Python, Ruby, Go, or another language, please contribute!

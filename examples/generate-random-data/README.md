# Generate random data in Notion

Create schema-aware sample pages, read them back, and try common database
filters with the Notion API.

> [!CAUTION]
> Every run creates **10 pages in the first database the integration can
> access**. The script does not ask you to choose a database. Share the
> integration with only a test database that you are comfortable modifying.

## Quickstart

1. Duplicate the
   [example database](https://public-api-examples.notion.site/f3e098475baa45878759ed8d04ea79af)
   into your workspace.
2. Create a Notion integration in the
   [integrations dashboard](https://www.notion.com/my-integrations), then
   [connect it](https://developers.notion.com/docs/create-a-notion-integration#step-2-share-a-database-with-your-integration)
   only to the duplicated test database.
3. From the repository root, install and configure the example:

   ```sh
   cd examples/generate-random-data
   npm install
   cp example.env .env
   ```

   Set your integration secret in `.env`:

   ```dotenv
   NOTION_KEY=<your-notion-api-key>
   ```

4. Run it:

   ```sh
   npm run ts-run
   ```

The script creates 10 pages with values matched to the database schema. It
then reads the new pages, prints their properties, and runs example select and
rich-text filters. Use the provided database template if you want the complete
flow; a custom database needs both select and rich-text properties for the
filter examples.

Running the command again creates 10 more pages. The script does not remove the
sample data.

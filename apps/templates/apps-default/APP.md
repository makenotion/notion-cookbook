This app includes a scheduled hello workflow and an interactive hello block.

Replace this content with your app's home page: the place people come to use
the app. Start with a brief description of what it does and who it helps.
The deployed page uses the app's name as its title.

## Main views

Embed the most important pieces of your app here, in the order people need
them. Use database views or custom views to make this page the app's user
interface. For a CRM, that might mean Contacts and a pipeline view; for a
meeting app, a next-meeting card and upcoming meetings.

Give each view a clear heading and a short explanation when needed. Reference
declared data source or view resource IDs to embed linked views. For example,
after declaring the corresponding resources:

```text
<database inline="true" data-source-url="{{contacts-source}}">Contacts</database>
<database inline="true" data-source-url="{{pipeline-view}}">Pipeline</database>
```

## Using the app

Explain the few actions people need to get started: what to open, add, or
change, and what happens next. Put controls or views for common actions here
when the app provides them. Include any automatic updates or status indicators
that help people understand what they are seeing.

## More resources

Link to supporting pages and databases that people may need but do not need
to see embedded on the home page. For example, after declaring the resource:

```text
<mention url="companies-db">Companies</mention>
```

Keep the page focused on using the app. Put developer setup, deployment
commands, and implementation details in the README.

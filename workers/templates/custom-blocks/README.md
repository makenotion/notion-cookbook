```text
nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn
nnnn                           nnn
nnnnnn                           nnn
nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn
nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn
nnnnnnnn                           nnn
nnnnnnnn    nnnnnnnn     nnnnnnn   nnn
nnnnnnnn      nnnnnnn      nnn     nnn
nnnnnnnn      nnnnnnnn     nnn     nnn
nnnnnnnn      nnn nnnnn    nnn     nnn
nnnnnnnn      nnn  nnnnn   nnn     nnn
nnnnnnnn      nnn   nnnnn  nnn     nnn
nnnnnnnn      nnn    nnnnn nnn     nnn
nnnnnnnn      nnn     nnnnnnnn     nnn
nnnnnnnn      nnn      nnnnnnn     nnn
nnnnnnnn    nnnnnnn     nnnnnn     nnn
  nnnnnn                           nnn
    nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn
      nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn
```

This feature is in private alpha. Coming soon.

## Build and runtime dependencies

Each template uses one shared `package.json`. If a dependency is needed for
neither the Worker runtime nor repository operations, put it in `devDependencies`.

## Template documentation

Edit `README.template.md` to update all custom block template READMEs, then run
`npm run agents:sync` from the repository root. The sync uses each recipe’s title
and deploy command from `catalog.json`. `npm run agents:check` detects stale copies.

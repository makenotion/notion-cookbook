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

Keep server runtime imports, including `@notionhq/workers`, in `dependencies`.
Build tools and browser libraries such as `@notionhq/custom-blocks`, `react`,
and `react-dom` can be `devDependencies` when Vite bundles them into the
uploaded static browser assets. Packages externalized from the bundle or
used for server-side rendering must remain in `dependencies` if the server
needs them at runtime.

Install dev dependencies for the build (`npm install --include=dev`). Build
and upload the browser assets before running `npm install --omit=dev` for
the Worker server runtime. The production install cannot build the browser
assets on its own.

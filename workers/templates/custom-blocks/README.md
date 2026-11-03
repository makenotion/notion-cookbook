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

These templates share one `package.json` between the Worker server and its
custom block. Vite bundles browser libraries into static assets that are
uploaded separately from the Worker server package. The browser still runs
React after deployment, but the server does not need React's package files
in its `node_modules`.

Keep server runtime imports, including `@notionhq/workers`, in `dependencies`.
Put build tools and browser libraries such as `@notionhq/custom-blocks`,
`react`, and `react-dom` in `devDependencies` when Vite bundles them into the
browser assets. Here, `devDependencies` describes their role in the server
package: the build needs them, but the deployed server does not. Any package
that the server needs at runtime, including for server-side rendering, must
remain in `dependencies`.

Install dev dependencies for the build (`npm install --include=dev`). Build
and upload the browser assets before running `npm install --omit=dev` for
the Worker server runtime. The production install cannot build the browser
assets on its own.

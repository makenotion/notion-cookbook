# npm versions and Worker lockfiles

Use Node.js 22.23.4 or newer and npm 11.11.0 or newer for Worker projects. npm
11.11.0 includes the [upstream fix](https://github.com/npm/cli/pull/9025) that preserves native packages' `libc` field in
`package-lock.json`. Earlier versions can drop that field, so a later production
install adds an unused musl binary on GNU Linux.

The cookbook pins npm 11.21.1 in `.npm-version`. From this repository, `mise
install` selects the pinned Node and npm versions. For a standalone project:

```sh
npm install --global npm@11.21.1
npm --version
```

## Refresh an existing lockfile once

Upgrading npm preserves metadata when it creates new entries. It does not restore
missing metadata in an existing lockfile.

For an affected optional Rolldown or resvg Linux binding from the npm registry,
look up the `libc` field for its exact locked version. For example, if the lock
contains `@rolldown/binding-linux-x64-musl` version `1.2.15`:

```sh
npm view @rolldown/binding-linux-x64-musl@1.2.15 libc --json
```

Add the published field to that package's entry under `packages` in
`package-lock.json`. Repeat for affected GNU and musl bindings. Keep each entry's
`version`, `resolved`, and `integrity` unchanged. Check the diff before continuing;
do not delete the lockfile or native binaries to repair metadata.

Run the project's checks and the production reinstall with the upgraded npm:

```sh
npm install
npm run check
npm test
npm run build
npm install --omit=dev
```

Run only scripts the project declares. On GNU Linux, the GNU binding must remain
installed, and the musl binding should be absent. Native features such as Chart
rendering must still work. Commit the metadata-only lockfile change when the
project tracks its lockfile. Keep the npm upgrade in place so later installs do
not strip the metadata again.

# Screen Canvas

Screen Canvas opens a local Vite and React Router project on macOS, builds a
map from its JSX routes, and captures real screens and transitions. Select a
card to open the project in Chromium and inspect any bound data. Named variants
are stored as JSON in the selected project under `screen-canvas/scenarios/`.

## Development

Use arm64 macOS and Node.js 24 or newer.

```sh
npm ci
npx electron desktop/main.mjs
npm test
node test/transfer.mjs
```

Use **Открыть проект** to choose a trusted folder with its dev dependencies
installed. Screen Canvas runs the selected project's Vite config and optional
adapter in its project worker. The preview uses a separate Chromium session.

Use `node test/prepare-transfer.mjs --out <new-directory>` to prepare the
independent catalog. For a specific runtime archive, pass `--artifact <file>`.
The basic example in `fixtures/screen-canvas-basic` works with just `npm ci`
in a separate copy of that folder. The examples pin Vite 5.4, React 18.3, React
Router 6.30 and TypeScript 5.

For custom hosts, API fixtures or browser state, the
[connection prompt](packages/runtime/prompts/connect.md) explains the SDK and
the desktop checks.

## macOS package

```sh
npm run test:desktop
npm run package:mac
npm pack ./packages/runtime --pack-destination <artifact-directory>
```

The arm64 application and ad-hoc signed ZIP are written to `out/release`.
Use macOS Archive Utility or `ditto -x -k` to unpack the ZIP. Open
`Screen Canvas.app` in Finder. The app includes Chromium and its project worker.

Prepare the catalog outside the checkout with the exact runtime archive.

```sh
node test/prepare-transfer.mjs --artifact "$ARCHIVE" --out "$CATALOG"
npm run qa:packaged -- --app "$EXTRACTED_APP" --project "$CATALOG" --artifact "$ARCHIVE" --deny-root "$SOURCE"
```

Repeat `--deny-root` to check other source directories. The test launcher
probes the requested file-read restrictions and runs the unpacked executable
from a temporary working directory. For the SDK-free example, use
`node test/prepare-transfer.mjs --basic --out "$BASIC"` and run the same smoke
with `--project "$BASIC"` and without `--artifact`.

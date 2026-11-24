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

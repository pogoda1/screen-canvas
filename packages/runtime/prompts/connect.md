# Connect a React project to Screen Canvas

Identify the project's Vite version, dev script and TypeScript config. Open its
folder in Screen Canvas and inspect the graph before adding any integration.
The built-in driver discovers React Router JSX routes and local navigation.
Add an explicit adapter when the default driver cannot start or identify a
project scenario.

Install `react-screen-canvas` as a dev dependency from the supplied npm archive.
Create `screen-canvas.config.mjs` and export `defineAdapter({...})` from the SDK.

- Set `tsconfig` to the project-relative config when the default is unsuitable.
- Provide test-only `env`; use synthetic users and local responses. Keep service
  credentials and real backend endpoints out of previews and variant files.
- Map transformed API calls with `transports` and JSON operations with
  `openapi`. Use `scenario` to seed values and `entities` to share a record ID
  between the route parameter, request and response. Use `createMocks` to give
  each session its own mutable state. An unmapped request under an API prefix
  should be visible as a missing mock.
- Connect editable props or state by declaring `bindings`. Point `browser` to a
  project module and use `registerBrowserBindings` from
  `react-screen-canvas/browser`. Use `getInitialScenario` if the initial value
  must be available before the React entry point. Identify the current screen,
  wait for real readiness, apply data to the host, and read the visible state.
  When a form submits asynchronously, read after it settles and keep unfinished
  UI input separately in `draft`. Optionally register `captureReady` for static
  thumbnails. For example, return false while the application's startup cover
  hides an otherwise working form. Keep `ready` tied to live read/apply so a
  diagnostic card can still open, edit and save the form. Hooks can be async,
  but the scanner gives them a limited time.
- Declare known conditional destinations in `captureRules`. Each rule has
  `source`, optional scenario `role`, `target`, and an exact local `path`
  such as `/documents/terms`. A target state node needs a matching browser
  identity. A rule with the same source and target may specify a `state` caption
  for an intentional placeholder or error screen. Only label the state if your
  capture hook verifies that its visible content is the intended state.
- Add state nodes with stable IDs (for example, `route:/settings#theme`) and
  declarative actions with source, target, condition and an optional test role.
  Supply stable selectors for the real controls. Prefer the project's existing
  state and labels.
- For a custom startup mechanism, supply `createHost` with the
  `HostDriver` contract. Return HTTP middleware and a close method that releases
  everything it owns.

Open the folder again in the desktop app. Verify that nodes correspond to the
mounted UI, then perform a real transition. Check request method, path and
status when a screen uses an API. Edit one field, save a named variant, quit
Electron and reopen the project and the variant. Confirm that the live screen
restores the data and any unfinished input. Keep variants you want to share in
`screen-canvas/scenarios/` in that project's Git history.

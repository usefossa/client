# opencode integration

## scope

follow the [repository instructions](../AGENTS.md). `package.json` defines entrypoints, dependencies, supported runtime, and scripts.

- `src/account/`: authentication, encrypted storage, and signing.
- `src/inference/`: routing, bookings, provider responses, and recovery.
- `src/ui/`: native terminal controls and settings.
- `src/protocol.ts`: shared request validation. preserve provider compatibility and active instruction/account layouts.

## workflow

- read the affected host and integration behavior before editing. preserve unrelated OpenCode configuration and wallet data.
- installation is separate from testing: `bun install && bun run install:local` updates local OpenCode configuration and requires a requested installation.
- deployments and package publication require an explicit request. maintenance does not authorize signing, broadcasting, or fund movement.

## implementation

- match native OpenCode components, spacing, search/categories, keyboard selection, hover, and navigation. use reactive native theme tokens and composer/agent tint relationships; avoid custom colors and redundant navigation hints.
- open surfaces immediately and skeleton unknown data before populating it. keep loading distinct from empty results. dollar signs may represent USDC in native layouts.
- reuse known identity and initiate required authentication or unlock directly; offer a picker only when identity is unknown.
- consume verified per-model capabilities, context/output limits, and modalities. default effort to the model maximum unless the user chooses otherwise; avoid arbitrary shared output caps.
- warm validated data and signing state before inference. sign and broadcast locally when authorized, and act on actual booking readiness. benchmark reliable fallbacks instead of fixed waits; transfer confirmation policies remain separate.
- the installer replaces previous Fossa source entries while preserving unrelated configuration and wallet data.

## configuration and security

- default API: `https://api.fossa.ag`. installation accepts `FOSSA_API_URL`; plugin options accept `options.apiUrl`. never load service-side configuration.
- keep signing keys encrypted on the user's computer in every connection flow. manual key import requires no website; quick connect uses website approval. passphrase protection is optional in settings.
- preserve encrypted credentials, exact accounting, and pending transaction recovery across reloads and endpoint changes. never log or commit secrets or private state.

## verification

- the current package requires Bun 1.3.14 or newer. run relevant `bun test` coverage and `bun run typecheck` before a requested commit or push, then review the final diff.
- cover affected server and terminal behavior against the supported OpenCode version. ordinary tests must be self-contained and require no live services.
- external checks are opt-in: `FOSSA_PROVIDER_ROOT` selects a provider fixture checkout; `FOSSA_TEST_API_URL` and `FOSSA_TEST_ORIGIN` select authentication targets; `FOSSA_TEST_BASE_URL` selects a website for browser checks.
- never point authentication integration tests at production without explicit authorization.

## commits and releases

- create commits and push only when explicitly requested.
- use `[type] short description`; allowed types are `[fix]`, `[feat]`, `[add]`, and `[update]`.
- messages must be one lowercase line. combine multiple changes with `+`.
- never add attribution or `co-authored-by` trailers.
- bump affected versions with semver for behavior or release changes. tag requested releases `vX.Y.Z`.
- the OpenCode integration version lives in `opencode/package.json` relative to the repository root.

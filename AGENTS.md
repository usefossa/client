# client

## scope

client integrations live in their own directories. `opencode/` contains the OpenCode integration; read its [instructions](opencode/AGENTS.md) before changing it. see [client documentation](https://fossa.ag/docs/users/qs).

## workflow

- dependency updates and security fixes are manual; retain vulnerability alerts and dependency inventories.
- read the relevant implementation before editing. clarify uncertain requirements and keep changes focused.
- deployments and package publication require an explicit request. repository maintenance does not authorize signing, broadcasting, or fund movement.
- preserve unrelated configuration, wallet data, credentials, and pending transaction journals.

## implementation

- keep integrations independent of service-side configuration and private infrastructure.
- preserve each host application's native behavior, authorization boundaries, and existing integration contracts.
- favor concise code and low-latency request paths. keep accounting exact and display USDC values with two decimals.
- keep readmes to documentation links: one properly capitalized link per component, each on its own line. public documentation explains behavior and trust boundaries without private operational details.

## configuration and security

- use integration options and environment variables. expose only public configuration; never load service-side configuration.
- default API: `https://api.fossa.ag`. `FOSSA_API_URL` overrides the installation endpoint.
- keep local overrides ignored. never log or commit secrets, private keys, or private user state.
- preserve encrypted keys and pending transaction journals; configuration changes must not discard recovery state.

## verification

- before a requested commit or push, run the affected integration's checks and review the final diff.
- tests must use synthetic credentials and isolated fixtures. live integration checks require explicit opt-in; never use production credentials implicitly.
- each integration's instructions define its commands and compatibility requirements.

## commits and releases

- create commits and push only when explicitly requested.
- use `[type] short description`; allowed types are `[fix]`, `[feat]`, `[add]`, and `[update]`.
- messages must be one lowercase line. combine multiple changes with `+`.
- never add attribution or `co-authored-by` trailers.
- bump affected versions with semver for behavior or release changes. tag requested releases `vX.Y.Z`.
- the OpenCode integration version lives in `opencode/package.json` relative to the repository root.

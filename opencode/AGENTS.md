# opencode plugin

follow [shared rules](../AGENTS.md). current entrypoints and commands are defined in `package.json`.

install with `bun install && bun run install:local`; default api `https://api.fossa.ag`, overridden through installer `FOSSA_API_URL` or plugin `options.apiUrl`. client must not load service-side configuration. installer replaces previous fossa source entries while preserving unrelated opencode configuration and wallet data.

## native experience

- match native opencode components, spacing, search/categories, keyboard selection, hover, and navigation. use reactive native theme tokens and composer/agent tint relationships; avoid custom colors and redundant navigation hints.
- open surfaces immediately, skeleton unknown data, then populate; keep loading distinct from empty results. dollar signs may represent usdc in native layouts.
- reuse known identity and initiate required authentication/unlock directly; offer a picker only when identity is unknown.

## signing and inference

- keep signing keys encrypted on user's computer in every connection flow. manual key import needs no website; quick connect uses existing fossa site. passphrase protection is optional in settings.
- consume verified per-model capabilities, context/output limits, and modalities. default effort to model maximum unless user chooses otherwise; avoid arbitrary shared output caps.
- warm validated data and signing state before inference; sign/broadcast locally and act on actual booking readiness. benchmark fast, reliable fallbacks instead of fixed waits. transfer confirmation policies remain separate.
- changes to `src/protocol.ts` must preserve provider validation compatibility and active program/account layouts.

## verification

when shared workflow authorizes checks, use relevant `bun test` coverage and `bun run typecheck`; target affected server/tui behavior and pinned opencode compatibility.

external integration checks are opt-in: `FOSSA_PROVIDER_ROOT` selects an explicitly supplied provider fixture checkout; `FOSSA_TEST_API_URL` and `FOSSA_TEST_ORIGIN` select an api and origin for auth checks; `FOSSA_TEST_BASE_URL` selects website for browser checks. ordinary tests must be self-contained and require no live services. never point auth integration tests at production without explicit authorization.

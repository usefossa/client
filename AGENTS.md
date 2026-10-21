# fossa client

standalone client integrations; opencode plugin lives in `opencode/`. read `opencode/AGENTS.md` before investigation or changes there. use bun. use subagents only when explicitly requested. repository names lowercase.

no commits, pushes, deployments, dev servers, documentation files or screenshots unless requested. quick edits end after implementation without checks. requested commit/push requires relevant tests, typecheck, one final diff review, semver bump and `vX.Y.Z` tag. commits use `[fix]`, `[feat]`, `[add]` or `[update]`, short lowercase single line; no attribution.

client configuration uses plugin options and environment variables, never backend `config.toml`. default api `https://api.fossa.ag`; installation override `FOSSA_API_URL`. use ignored `.env.local` only for local environment overrides. expose public configuration only; preserve encrypted local keys, credentials and pending transaction journal. never log or commit secrets. no signing, broadcasting or fund movement without explicit authorization.

preserve native opencode behavior, compact copy and server authorization. prose/comments lowercase; identifiers, commands, urls and user-facing copy retain normal capitalization. keep accounting exact and displayed usdc values at two decimals.

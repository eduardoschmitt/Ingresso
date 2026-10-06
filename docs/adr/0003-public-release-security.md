# ADR 0003 — Public-release security posture (local educational use)

Date: 2026-10-06 · Status: accepted

## Context

Ingresso will be public as a local-run case study, not as a hosted service.
A full auth model is out of scope by design.

## Decision

1. **No authentication, by declaration.** The API has no auth/authz/rate
   limiting. Anyone with a reservation ID can read or cancel it; anyone can
   hold seats temporarily. This is documented in the README (Security
   section), not fixed in code.
2. **Never expose the API to the internet.** Binds default to local use;
   `CORS_ORIGIN` allowlists explicit origins (no wildcards); `/metrics` is
   unauthenticated by design for local Prometheus.
3. **Fail-safe configuration.** Destructive CLIs (`db:migrate`, `db:seed`)
   refuse non-loopback database hosts unless `INGRESSO_ALLOW_REMOTE_DB=1`
   is set deliberately. Test/load/e2e harnesses additionally require exact
   database names (`*_test`, `*_load`, `ingresso_e2e`) verified live.
4. **No secret ever versioned.** `.env` files, downloaded posters, Grafana
   credentials, and TMDB keys stay gitignored; examples carry placeholders.
5. **Dependency CVEs are tracked, not hidden.** `pnpm audit` output is
   reported verbatim; production-path fixes ship (drizzle-orm, sharp
   direct); major-line upgrades (Astro 5→7, vitest 3→4) and dev-only
   transitives are documented residuals with reachability analysis.

## Consequences

Evaluators must treat any internet-facing deployment as unsupported.
Rate limiting and authentication remain explicit future work (AGENTS.md
Phase 7), not silent gaps.

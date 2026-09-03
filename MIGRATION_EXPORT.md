# kalshi-420-bot source migration export

This is a source-only export prepared from commit:

`9d5bdb6fafb4d9b858e82e4f51a1621df02c0a88`

It intentionally contains no Git history, remotes, deployment state, environment
files, credentials, runtime state, databases, research datasets, generated
analysis output, replay captures, or attached conversation assets.

## Included

- API source, API scripts, build configuration, tests, and artifact service metadata
- Dashboard source, static public assets, Vite configuration, tests, and artifact service metadata
- Shared API client, API specification, validation, database schema, and TypeScript workspace libraries
- Root pnpm workspace files, package lock, TypeScript configuration, and shared scripts

## Before creating or pushing a GitHub repository

1. Review the deployment model and configure a single authoritative production
   runner; this export intentionally omits Replit deployment and environment state.
2. Add secrets only through the destination platform’s encrypted secret manager.
3. Review required production environment variables, database migration/backup
   strategy, durable runtime storage, and the dashboard/API routing model.
4. Run `pnpm install --frozen-lockfile`, `pnpm run typecheck`, and the relevant
   API and dashboard builds in the destination environment.

The `.gitignore` in this export is intentionally stricter than the source
repository’s prior policy and should remain in place before any broad `git add`.
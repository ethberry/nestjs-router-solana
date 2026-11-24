# nestjs-router-solana

`@ethberry/nestjs-router-solana`: a NestJS module that reads Solana block by block and routes the transfers of watched addresses to controllers (`@EventPattern`), the way `@ethberry/nestjs-router-eth` routes EVM logs. A single package, not a monorepo.

## Place in the package levels

Level 1: no dependencies on other `@ethberry/*` runtime packages.

## Commands

- Base branch: `main`.
- Install: `npm ci` (the lockfile is committed).
- Build: `npm run build` (`tsc`). Lint: `npm run lint`. Typecheck: `npm run typecheck`.
- Test: `npm run test`. It needs the local node: `docker compose up -d --wait` (container `nestjs-solana-node`, JSON-RPC 8999, WebSocket 9000).
- CI (`ci-test.yml`): by hand only; starts the node, then install, lint, build, test.

## Gotchas

- ESM only (`nodenext`, `.js` in relative imports). Jest runs with `NODE_OPTIONS=--experimental-vm-modules`.
- `@solana/kit` and `@nestjs/*` are peers: one copy per app.
- The chain test waits for real blocks: `testTimeout` in `jest.config.json` is raised for it (the testing rule's exception for chain tests).
- The container name and ports are this repository's own, so the node runs next to other EthBerry stands. Never `docker rm`; use `docker stop` / `docker start` (a restart is a new ledger).

## Docs

Usage is in `README.md`; how the reader works is in [docs/](docs/README.md). Rules are in `.claude/rules/`, synced from the shared agent kit.

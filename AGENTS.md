# nestjs-solana

`@ethberry/nestjs-solana`: a NestJS module that reads Solana block by block and routes the transfers of watched addresses to controllers (`@EventPattern`), the way `@ethberry/nestjs-viem` routes EVM logs. A single package, not a monorepo.

## Place in the package levels

Level 1: no dependencies on other `@ethberry/*` runtime packages.

## Commands

- Base branch: `main`.
- Install: `npm ci` (the lockfile is committed).
- Build: `npm run build` (`tsc`). Lint: `npm run lint`. Typecheck: `npm run typecheck`.
- Test: `npm run test`. It needs the local node: `docker compose up -d --wait` (service `solana`, JSON-RPC 8899, WebSocket 8900).
- CI (`ci-test.yml`): by hand only; starts the node, then install, lint, build, test.

## Gotchas

- ESM only (`nodenext`, `.js` in relative imports). Jest runs with `NODE_OPTIONS=--experimental-vm-modules`.
- `@solana/kit` and `@nestjs/*` are peers: one copy per app.
- The chain test waits for real blocks: `testTimeout` in `jest.config.json` is raised for it (the testing rule's exception for chain tests).
- The container name `solana` and its ports are the same as in other EthBerry stands (framework): one stand at a time; never `docker rm` it, `docker stop` / `docker start`.

## Docs

Usage is in `README.md`; how the reader works is in [docs/](docs/README.md). Rules are in `.claude/rules/`, synced from the shared agent kit.

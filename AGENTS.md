# Repository Guidelines

## Project Scope and Structure

This read-only TypeScript MCP server indexes finalized Polkadot Asset Hub
mainnet blocks on demand and analyzes arbitrary supported addresses.

- `src/main.ts`: composition, configuration, stdio transport, and shutdown.
- `src/server.ts`: MCP schemas, request deadlines, and serialized execution.
- `src/indexer.ts`: bounded indexing, address queries, and coverage reporting.
- `src/chain.ts`: Polkadot.js RPC, historical decoding, and EVM account mapping.
- `src/store.ts`: chain-bound SQLite persistence and indexed ranges.
- `src/activity.ts`: address normalization, discovery, and analysis.
- `test/`: offline regressions and the separate live-network check.

## Build, Test, and Development Commands

Use Node.js 24 or newer. Install with `npm ci --ignore-scripts`.

- `npm run check`: strict TypeScript validation.
- `npm run build`: compile source into `dist/`.
- `npm test`: offline behavioral and stdio transport tests.
- `npm run dev`: run TypeScript locally.
- `node dist/main.js`: start the compiled server for an MCP client.
- `npm run test:live`: after building, verify read-only mainnet queries.

## Coding Style and Naming

Use two-space indentation, single quotes, semicolons, and explicit TypeScript
contracts. Use camelCase values, PascalCase classes/types, and snake_case MCP
tool arguments. Keep behavior with its owner and avoid generic utility modules.
Preserve exact large integers. `linter.toml` enforces layout and concise filenames;
no automatic formatter is configured.

## Testing Guidelines

Use `node:test` and strict assertions. Name tests after observable behavior.
Cover address normalization, historical mapping, failed reads, cache persistence,
coverage gaps, cancellation, pagination, and analysis precision. Run checks,
build, and offline tests before submitting changes. Report live-network evidence
separately. No numerical coverage threshold is configured.

## Commit and Pull Request Guidelines

Git history is unavailable here. Prefer imperative commit messages such as
`Fix historical address mapping`. Explain behavior, rationale, checks performed,
and remaining limits. Link relevant issues when available.

## Security and Evidence

Never add signing secrets or transaction submission. Preserve mainnet genesis
verification and finalized-block bounds. Keep stdout exclusively for MCP.
Document local SQLite writes and historical RPC requirements. Return exact
coverage and source references; distinguish address references, runtime dispatch,
contract execution, and remote XCM outcomes. Never describe bounded queries as
complete address history.

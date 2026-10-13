# Polkadot Asset Hub MCP Indexer

A small read-only TypeScript MCP server using Polkadot.js and SQLite. Pass an
address to fetch indexed activity and get an evidence-backed summary. Supports
SS58 accounts, AccountId32 hex, and 20-byte EVM addresses on Polkadot Asset Hub
mainnet. There is no fixed treasury or contract ABI.

## Run

Requires Node.js **24 or newer** (uses built-in `node:sqlite`).

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
node dist/main.js
```

The server waits for an MCP client over stdin/stdout. `npm run dev` runs the
TypeScript entrypoint locally. For MCP client configuration, use `node` directly
so npm messages do not enter protocol stdout:

```json
{
  "mcpServers": {
    "asset-hub": {
      "command": "node",
      "args": ["/absolute/path/to/asset-hub-mcp/dist/main.js"]
    }
  }
}
```

Configuration is optional:

- `ASSET_HUB_RPC`: defaults to `wss://polkadot-asset-hub-rpc.polkadot.io`.
  An alternative must serve the same mainnet; genesis is verified.
- `ASSET_HUB_DB`: SQLite file path; defaults to `data/index.sqlite` relative to
  this package, regardless of the client's working directory. `:memory:` uses
  a temporary index. The database is bound to the chain genesis.

## MCP Tools

| Tool | Inputs | Output |
| --- | --- | --- |
| `get_address_activity` | `address`, optional `from_block`, `to_block`, `offset`, `limit` | Matching calls/events, evidence IDs, coverage, pagination, and summary. |
| `analyze_address` | Same inputs | Analysis over the whole requested range with paginated supporting records. |
| `get_index_status` | None | Finalized tip and exact locally indexed ranges, including gaps. |

Example tool arguments:

```json
{"address":"YOUR_SS58_OR_HEX_ADDRESS"}
```

```json
{"address":"YOUR_SS58_OR_HEX_ADDRESS","from_block":21733927,"to_block":21733928,"offset":0,"limit":50}
```

Address-only requests index the latest **20 finalized blocks**. Explicit ranges
are limited to **100 blocks** per request. Page size defaults to 50, maximum 100.
For subsequent pages, pin `from_block` and `to_block` to the coverage returned
by the first response and use `nextOffset`; otherwise the latest window moves.
Records are ordered by block ascending. Analysis covers the entire range,
regardless of page size. Native fees and supported transfer amounts are exact
raw integer strings; token decimals are not inferred.

## How It Works

`main.ts` composes the stdio server, RPC connection, and SQLite store.
`server.ts` validates tools and serializes requests. `indexer.ts` loads missing
finalized blocks and queries them by address. `chain.ts` reads RPC data and
resolves historical EVM account mappings. `store.ts` persists complete decoded
blocks. `activity.ts` discovers references and summarizes their evidence.

This is an **on-demand local block index**, not a background full-chain index.
Cached blocks survive restarts and are shared across address queries. Index
status reports disjoint ranges rather than suggesting gaps are covered.

## Evidence and Limits

- Discovery matches signed origins and exact encoded address/account values in
  decoded call arguments and events. Opaque calldata, storage-only changes, and
  remote XCM activity are not indexed. A 32-byte reference may be a hash;
  its presence alone does not prove account involvement.
- Matching transactions include all associated events for context. Transfer
  classification supports `balances`, `assets`, `foreignAssets`, and `poolAssets`
  `Transfer` events. Other events remain available as evidence.
- Runtime dispatch success does not establish contract, nested-call, or remote
  XCM success. EVM addresses are mapped at each queried historical block;
  runtimes without the mapping API produce an error.
- Historical blocks require archive state, including parent runtime metadata.
  Pruned/unavailable reads fail explicitly. Successfully indexed earlier blocks
  remain cached, but failed requests never claim complete results.
- Requests have a 120-second deadline; RPC requests and connection setup have
  separate bounded timeouts. Cancellation stops scanning after an in-flight
  read returns. Queries never sign or submit transactions; local indexing writes
  only to SQLite. Diagnostics use stderr.

## Verification

```sh
npm run check       # Strict TypeScript checks
npm run build       # Compile to dist/
npm test            # Offline regression and actual stdio transport tests
npm run test:live   # After building; read-only mainnet stdio regression
```

Live tests use an in-memory index and the configured RPC. They verify a recent
finalized block, AccountId32 and EVM mapping, cache reuse, and known historical
activity with transfer analysis at block `21733928`. They do not prove
complete history or remote execution. `linter.toml` configures structure and
filename rules through the Linter MCP plugin.

Implementation references: [official MCP SDK server documentation](https://ts.sdk.modelcontextprotocol.io/server)
and [Polkadot.js block/event queries](https://polkadot.js.org/docs/api/cookbook/blocks/).

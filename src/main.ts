import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Chain, GENESIS, RPC } from './chain.js';
import { Indexer } from './indexer.js';
import { createServer } from './server.js';
import { Store } from './store.js';

// Libraries may log; JSON-RPC alone owns stdout.
console.log = console.error;
const rpc = process.env.ASSET_HUB_RPC ?? RPC;
if (!['ws:', 'wss:'].includes(new URL(rpc).protocol)) throw new Error('ASSET_HUB_RPC must use ws:// or wss://.');
const path = process.env.ASSET_HUB_DB ?? fileURLToPath(new URL('../data/index.sqlite', import.meta.url));
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const chain = new Chain(rpc);
const store = new Store(path, GENESIS);
const server = createServer(new Indexer(chain, store));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await chain.close();
  store.close();
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.stdin.once('end', () => void close());
await server.connect(new StdioServerTransport());

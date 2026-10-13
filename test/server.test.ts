import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { Indexer } from '../src/indexer.js';
import { Store } from '../src/store.js';
import type { ChainSource } from '../src/chain.js';

const address = '0x' + '11'.repeat(32);

test('MCP validates schemas, returns structured results, and reports RPC failures as errors', async () => {
  const store = new Store(':memory:', 'genesis');
  const chain: ChainSource = {
    status: async () => ({ genesis: 'genesis', finalized: 10, finalizedHash: 'hash', rpc: 'fixture' }),
    resolve: async address => [address.key],
    block: async () => { throw new Error('Historical state unavailable'); },
  };
  const server = createServer(new Indexer(chain, store));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(left), client.connect(right)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['analyze_address', 'get_address_activity', 'get_index_status']);
    assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint));
    const status = await client.callTool({ name: 'get_index_status', arguments: {} });
    assert.equal((status.structuredContent as { indexedBlocks: number } | undefined)?.indexedBlocks, 0);
    const invalid = await client.callTool({ name: 'get_address_activity', arguments: { address, limit: 101 } });
    assert.equal(invalid.isError, true);
    const error = await client.callTool({ name: 'analyze_address', arguments: { address, from_block: 10, to_block: 10 } });
    assert.equal(error.isError, true);
    assert.match(JSON.stringify(error.content), /Historical state unavailable/);
  } finally { await client.close(); await server.close(); store.close(); }
});

test('Actual stdio process lists tools without connecting to RPC or emitting non-protocol stdout', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    env: { ...process.env, ASSET_HUB_DB: ':memory:', ASSET_HUB_RPC: 'ws://127.0.0.1:1' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);
  } finally { await client.close(); }
});

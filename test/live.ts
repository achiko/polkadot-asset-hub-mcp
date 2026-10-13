import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'live-regression', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
  env: { ...process.env, ASSET_HUB_DB: ':memory:' } as Record<string, string>, stderr: 'inherit' });
try {
  await client.connect(transport);
  const status = await client.callTool({ name: 'get_index_status', arguments: {} }, undefined, { timeout: 150_000 });
  assert.ok(!status.isError, JSON.stringify(status));
  const tip = Number((status.structuredContent as { finalized: number } | undefined)?.finalized);
  assert.ok(Number.isSafeInteger(tip) && tip > 0);
  for (const address of ['0x' + '11'.repeat(32), '0x' + '11'.repeat(20)]) {
    const result = await client.callTool({ name: 'get_address_activity', arguments: {
      address, from_block: tip, to_block: tip,
    } }, undefined, { timeout: 150_000 });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = result.structuredContent as { coverage: { indexedBlocks: number; completeRequestedRange: boolean }; address: { matchedKeys: string[] } };
    assert.equal(data.coverage.indexedBlocks, 1);
    assert.equal(data.coverage.completeRequestedRange, true);
    assert.equal(data.address.matchedKeys.length, address.length === 42 ? 2 : 1);
  }
  const indexed = await client.callTool({ name: 'get_index_status', arguments: {} }, undefined, { timeout: 150_000 });
  assert.equal((indexed.structuredContent as { indexedBlocks: number } | undefined)?.indexedBlocks, 1);
  const historical = await client.callTool({ name: 'analyze_address', arguments: {
    address: '0x50b0d5f7099a284ab2de476f3b3cda794a65b08c', from_block: 21733928, to_block: 21733928,
  } }, undefined, { timeout: 150_000 });
  assert.ok(!historical.isError, JSON.stringify(historical));
  const activity = historical.structuredContent as { records: { id: string }[]; analysis: { transfers: unknown[] } };
  assert.ok(activity.records.some(record => record.id === '21733928-2'));
  assert.ok(activity.analysis.transfers.length > 0);
  console.log(JSON.stringify({ verified: ['compiled stdio MCP', 'mainnet genesis', 'finalized block indexing', 'AccountId32', 'Revive H160 mapping', 'cache reuse', 'historical address activity and transfer analysis'], block: tip }, null, 2));
} finally { await client.close(); }

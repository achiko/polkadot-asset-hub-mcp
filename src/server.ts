import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Indexer } from './indexer.js';

export function createServer(indexer: Indexer): McpServer {
  const server = new McpServer({ name: 'asset-hub-indexer', version: '0.1.0' });
  const block = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const input = {
    address: z.string().min(1).max(128), from_block: block.optional(), to_block: block.optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  // Serialize access so requests cannot duplicate expensive scans on one connection.
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (operation: (signal: AbortSignal) => Promise<object>, cancelled: AbortSignal) => {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(120_000)]);
    const pending = queue.then(async () => {
      signal.throwIfAborted();
      return operation(signal);
    });
    queue = pending.catch(() => undefined);
    let abort: (() => void) | undefined;
    try {
      const output = await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Request cancelled or timed out; no complete result is available.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      const data = { ...output };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message : String(error) }] };
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  };
  server.registerTool('get_address_activity', {
    description: 'Index up to 100 finalized Polkadot Asset Hub blocks and return address references with associated calls/events. Defaults to the last 20 blocks. Local SQLite cache; not full address history. Pin from_block/to_block when paginating.',
    inputSchema: input, annotations,
  }, (query, extra) => run(signal => indexer.activity(query, signal), extra.signal));
  server.registerTool('analyze_address', {
    description: 'Analyze an address across up to 100 finalized blocks (last 20 by default). Reports transfer evidence, own paid fees, and dispatch outcomes. Analysis covers the entire requested range; records are paginated. Does not prove remote XCM or contract success.',
    inputSchema: input, annotations,
  }, (query, extra) => run(signal => indexer.activity(query, signal), extra.signal));
  server.registerTool('get_index_status', {
    description: 'Return finalized chain tip and exact locally indexed ranges. Indexing runs on demand, not continuously.',
    inputSchema: {}, annotations,
  }, (_, extra) => run(() => indexer.status(), extra.signal));
  return server;
}

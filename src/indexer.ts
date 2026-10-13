import { Address, analyze, records } from './activity.js';
import type { ActivityRecord } from './activity.js';
import type { ChainSource } from './chain.js';
import { Store } from './store.js';

export type Query = { address: string; from_block?: number; to_block?: number; offset?: number; limit?: number };
export class Indexer {
  constructor(private readonly chain: ChainSource, private readonly store: Store) {}

  async activity(query: Query, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const address = new Address(query.address);
    const status = await this.chain.status();
    const to = query.to_block ?? status.finalized;
    const from = query.from_block ?? Math.max(1, to - 19);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > status.finalized) {
      throw new Error('Expected an ordered, positive, finalized block range.');
    }
    if (to - from + 1 > 100) throw new Error('At most 100 blocks per request.');
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Expected a nonnegative offset and a limit from 1 to 100.');
    }
    const activity: ActivityRecord[] = [];
    const allKeys = new Set<string>([address.key]);
    const keysByBlock = new Map<number, string[]>();
    for (let number = from; number <= to; number++) {
      // Resolve H160 mappings at each historical block rather than assuming today's mapping.
      signal?.throwIfAborted();
      const keys = await this.chain.resolve(address, number);
      keys.forEach(key => allKeys.add(key));
      keysByBlock.set(number, keys);
      let block = this.store.get(number);
      if (!block) {
        block = await this.chain.block(number);
        signal?.throwIfAborted();
        this.store.save(block);
      }
      signal?.throwIfAborted();
      activity.push(...records(block, keys));
    }
    const page = activity.slice(offset, offset + limit);
    return { address: { input: query.address, normalized: address.key, ss58: address.ss58, matchedKeys: [...allKeys] },
      coverage: { fromBlock: from, toBlock: to, indexedBlocks: to - from + 1, finalizedTip: status.finalized,
        completeRequestedRange: true, completeAddressHistory: false, genesis: status.genesis,
        source: status.rpc, order: 'block_ascending',
        discovery: 'Signed origin and exact encoded address/account references in decoded calls and events.',
        limitations: ['Opaque calldata and storage-only changes are not indexed.',
          'A 32-byte value can be a hash rather than an account; references alone do not prove involvement.',
          'Historical reads require available archive state; remote XCM execution is not followed.'] },
      pagination: { offset, limit, total: activity.length,
        nextOffset: offset + page.length < activity.length ? offset + page.length : null },
      records: page,
      analysis: analyze(activity, [...allKeys], keysByBlock),
    };
  }
  async status() {
    const chain = await this.chain.status();
    const ranges = this.store.ranges();
    return { ...chain, indexedRanges: ranges, indexedBlocks: ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0),
      mode: 'on_demand', continuousSync: false, completeHistory: false,
      note: 'Only listed ranges are indexed; gaps between ranges are not covered.' };
  }
}

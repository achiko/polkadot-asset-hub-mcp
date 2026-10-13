import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

export type ChainEvent = {
  index: number;
  extrinsicIndex: number | null;
  section: string;
  method: string;
  data: unknown[];
};
export type Transaction = {
  index: number;
  hash: string;
  signer: string | null;
  section: string;
  method: string;
  args: unknown;
};
export type IndexedBlock = { number: number; hash: string; events: ChainEvent[]; transactions: Transaction[] };
export type ActivityRecord = {
  id: string;
  block: number;
  blockHash: string;
  transaction: Transaction | null;
  events: ChainEvent[];
  matchedBy: string[];
};

export class Address {
  readonly key: string;
  constructor(readonly input: string) {
    if (/^0x[\da-f]{40}$/i.test(input)) {
      this.key = input.toLowerCase();
      return;
    }
    try {
      const bytes = decodeAddress(input);
      if (bytes.length !== 32) throw new Error('Expected AccountId32');
      this.key = u8aToHex(bytes);
    } catch {
      throw new Error('Address must be a valid SS58 account, 32-byte account hex, or 20-byte EVM address.');
    }
  }
  get ss58(): string | null { return this.key.length === 66 ? encodeAddress(this.key, 0) : null; }

  static references(value: unknown): Set<string> {
    const keys = new Set<string>();
    const visit = (item: unknown): void => {
      if (typeof item === 'string') {
        // Only complete encoded values match; never substrings of calldata.
        if (/^0x[\da-f]{40}$|^0x[\da-f]{64}$/i.test(item) || /^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(item)) {
          try { keys.add(new Address(item).key); } catch { /* Non-address strings are not references. */ }
        }
      } else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') Object.values(item).forEach(visit);
    };
    visit(value);
    return keys;
  }
}

export function records(block: IndexedBlock, keys: string[]): ActivityRecord[] {
  const matches = (value: unknown) => [...Address.references(value)].some(key => keys.includes(key));
  const found: ActivityRecord[] = [];
  for (const tx of block.transactions) {
    const events = block.events.filter(event => event.extrinsicIndex === tx.index);
    const matchedBy = [
      ...(matches(tx.signer) ? ['signer'] : []),
      ...(matches(tx.args) ? ['call_argument_reference'] : []),
      ...(events.some(event => matches(event.data)) ? ['event_reference'] : []),
    ];
    if (matchedBy.length) found.push({ id: `${block.number}-${tx.index}`, block: block.number,
      blockHash: block.hash, transaction: tx, events, matchedBy });
  }
  for (const event of block.events.filter(event => event.extrinsicIndex === null && matches(event.data))) {
    found.push({ id: `${block.number}-event-${event.index}`, block: block.number,
      blockHash: block.hash, transaction: null, events: [event], matchedBy: ['event_reference'] });
  }
  return found;
}

export function analyze(activity: ActivityRecord[], keys: string[], keysByBlock?: Map<number, string[]>) {
  const calls: Record<string, number> = {};
  const transfers: { evidence: string; asset: string; direction: string; amount: string }[] = [];
  let dispatchSucceeded = 0;
  let dispatchFailed = 0;
  let ownFees = 0n;
  for (const record of activity) {
    const matchedKeys = keysByBlock?.get(record.block) ?? keys;
    if (record.transaction) {
      const name = `${record.transaction.section}.${record.transaction.method}`;
      calls[name] = (calls[name] ?? 0) + 1;
    }
    for (const event of record.events) {
      if (event.section === 'system' && event.method === 'ExtrinsicSuccess') dispatchSucceeded++;
      if (event.section === 'system' && event.method === 'ExtrinsicFailed') dispatchFailed++;
      const evidence = `${record.block}-event-${event.index}`;
      if (event.section === 'transactionPayment' && event.method === 'TransactionFeePaid') {
        const [payer, amount] = event.data;
        if ([...Address.references(payer)].some(key => matchedKeys.includes(key)) && /^\d+$/.test(String(amount))) {
          ownFees += BigInt(String(amount));
        }
      }
      if (event.method !== 'Transfer') continue;
      const native = event.section === 'balances';
      if (!native && !['assets', 'foreignAssets', 'poolAssets'].includes(event.section)) continue;
      const [asset, from, to, amount] = native ? ['native', ...event.data] : event.data;
      if (!/^\d+$/.test(String(amount))) continue;
      const outgoing = [...Address.references(from)].some(key => matchedKeys.includes(key));
      const incoming = [...Address.references(to)].some(key => matchedKeys.includes(key));
      if (!outgoing && !incoming) continue;
      transfers.push({ evidence, asset: native ? 'native' : `${event.section}:${JSON.stringify(asset)}`,
        direction: outgoing && incoming ? 'self' : outgoing ? 'outgoing' : 'incoming', amount: String(amount) });
    }
  }
  return { records: activity.length, calls, dispatchSucceeded, dispatchFailed,
    ownTransactionFeesRaw: ownFees.toString(), transfers,
    limitations: ['Amounts are raw integer units; token decimals are not inferred.',
      'Dispatch success is not proof of contract, nested call, or remote XCM success.',
      'Only balances/assets/foreignAssets/poolAssets Transfer events are classified as transfers.',
      'Associated events may include other accounts; address references do not prove ownership or execution.'] };
}

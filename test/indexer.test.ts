import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';
import { Address, analyze, records } from '../src/activity.js';
import type { IndexedBlock } from '../src/activity.js';
import { Store } from '../src/store.js';
import { Indexer } from '../src/indexer.js';
import type { ChainSource } from '../src/chain.js';

const alice = '0x' + '11'.repeat(32);
const bob = '0x' + '22'.repeat(32);
const sample = (number: number): IndexedBlock => ({ number, hash: `hash-${number}`,
  transactions: [{ index: 0, hash: 'tx', signer: encodeAddress(alice, 42), section: 'balances', method: 'transferKeepAlive', args: { dest: bob } },
    { index: 1, hash: 'tx-2', signer: bob, section: 'balances', method: 'transferKeepAlive', args: { dest: alice } }],
  events: [
    { index: 0, extrinsicIndex: 0, section: 'balances', method: 'Transfer', data: [alice, bob, '9007199254740993000'] },
    { index: 1, extrinsicIndex: 0, section: 'transactionPayment', method: 'TransactionFeePaid', data: [alice, '123', '0'] },
    { index: 2, extrinsicIndex: 0, section: 'system', method: 'ExtrinsicSuccess', data: [] },
    { index: 3, extrinsicIndex: 1, section: 'system', method: 'ExtrinsicFailed', data: [] },
    { index: 4, extrinsicIndex: null, section: 'assets', method: 'Transfer', data: ['7', bob, alice, '10'] },
  ],
});
function source(): ChainSource & { reads: number[] } {
  return { reads: [],
    status: async () => ({ genesis: 'genesis', finalized: 50, finalizedHash: 'head', rpc: 'fixture' }),
    resolve: async address => [address.key],
    async block(number) { this.reads.push(number); return sample(number); },
  };
}

test('Address normalizes SS58 prefixes, AccountId32 and H160; rejects invalid inputs', () => {
  assert.equal(new Address(encodeAddress(alice, 42)).key, alice);
  assert.equal(new Address(encodeAddress(alice, 0)).key, alice);
  assert.equal(new Address('0x' + 'AB'.repeat(20)).key, '0x' + 'ab'.repeat(20));
  assert.throws(() => new Address('not-an-address'));
  assert.throws(() => new Address('0x1234'));
  assert.equal(Address.references('0x1234' + alice.slice(2)).size, 0);
});

test('Discovery keeps associated errors and non-extrinsic events; analysis preserves exact amounts', () => {
  const found = records(sample(10), [alice]);
  assert.equal(found.length, 3);
  assert.deepEqual(found[0]?.matchedBy, ['signer', 'event_reference']);
  assert.deepEqual(found[1]?.matchedBy, ['call_argument_reference']);
  const result = analyze(found, [alice]);
  assert.equal(result.dispatchSucceeded, 1);
  assert.equal(result.dispatchFailed, 1);
  assert.equal(result.ownTransactionFeesRaw, '123');
  assert.equal(result.transfers[0]?.amount, '9007199254740993000');
  assert.equal(result.transfers[0]?.direction, 'outgoing');
  assert.equal(result.transfers[1]?.direction, 'incoming');
  assert.equal(result.transfers[1]?.evidence, '10-event-4');
});

test('SQLite survives restart, reports exact disjoint ranges and rejects another chain or hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'asset-hub-test-'));
  const path = join(directory, 'index.sqlite');
  try {
    const store = new Store(path, 'genesis');
    for (const number of [1, 2, 4]) store.save(sample(number));
    assert.deepEqual(store.ranges(), [{ from: 1, to: 2 }, { from: 4, to: 4 }]);
    assert.throws(() => store.save({ ...sample(1), hash: 'conflict' }));
    store.close();
    const reopened = new Store(path, 'genesis');
    assert.deepEqual(reopened.get(1), sample(1));
    reopened.close();
    assert.throws(() => new Store(path, 'another-chain'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Indexer reuses cached blocks; pagination does not truncate analysis; finalized ranges enforced', async () => {
  const chain = source();
  const store = new Store(':memory:', 'genesis');
  const indexer = new Indexer(chain, store);
  try {
    const first = await indexer.activity({ address: alice, from_block: 10, to_block: 11, limit: 1 });
    assert.equal(first.pagination.total, 6);
    assert.equal(first.pagination.nextOffset, 1);
    assert.equal(first.records.length, 1);
    assert.equal(first.analysis.ownTransactionFeesRaw, '246');
    const second = await indexer.activity({ address: alice, from_block: 10, to_block: 11, limit: 1, offset: 1 });
    assert.notEqual(first.records[0]?.id, second.records[0]?.id);
    assert.deepEqual(chain.reads, [10, 11]);
    await assert.rejects(indexer.activity({ address: alice, from_block: 1, to_block: 51 }), /finalized/);
    await assert.rejects(indexer.activity({ address: alice, from_block: 5, to_block: 4 }), /ordered/);
    const empty = await indexer.activity({ address: '0x' + '33'.repeat(32), from_block: 10, to_block: 10 });
    assert.equal(empty.records.length, 0);
    assert.equal(empty.coverage.completeRequestedRange, true);
    assert.equal(empty.coverage.completeAddressHistory, false);
  } finally { store.close(); }
});

test('A failed historical read does not mark its block or range complete; retry resumes from cache', async () => {
  const chain = source();
  const read = chain.block.bind(chain);
  let fails = true;
  chain.block = async number => {
    if (number === 11 && fails) throw new Error('Pruned state');
    return read(number);
  };
  const store = new Store(':memory:', 'genesis');
  const indexer = new Indexer(chain, store);
  try {
    await assert.rejects(indexer.activity({ address: alice, from_block: 10, to_block: 12 }), /Pruned/);
    assert.deepEqual(store.ranges(), [{ from: 10, to: 10 }]);
    fails = false;
    await indexer.activity({ address: alice, from_block: 10, to_block: 12 });
    assert.deepEqual(chain.reads, [10, 11, 12]);
  } finally { store.close(); }
});

test('Cancellation prevents saving a block that arrives after cancellation', async () => {
  const chain = source();
  const controller = new AbortController();
  chain.block = async number => { controller.abort(); return sample(number); };
  const store = new Store(':memory:', 'genesis');
  try {
    await assert.rejects(new Indexer(chain, store).activity({ address: alice, from_block: 10, to_block: 10 }, controller.signal));
    assert.deepEqual(store.ranges(), []);
  } finally { store.close(); }
});

test('Historical mapping changes are resolved per block and not mixed by analysis', async () => {
  const evm = '0x' + '44'.repeat(20);
  const chain = source();
  const resolutions: number[] = [];
  chain.resolve = async (address, number) => {
    resolutions.push(number);
    return [address.key, number === 10 ? alice : bob];
  };
  const store = new Store(':memory:', 'genesis');
  try {
    const result = await new Indexer(chain, store).activity({ address: evm, from_block: 10, to_block: 11 });
    assert.deepEqual(resolutions, [10, 11]);
    // The same Alice -> Bob transfer is outgoing before remapping, incoming afterward.
    const transfers = result.analysis.transfers.filter(item => item.asset === 'native');
    assert.equal(transfers[0]?.direction, 'outgoing');
    assert.equal(transfers[1]?.direction, 'incoming');
    assert.equal(result.analysis.ownTransactionFeesRaw, '123');
  } finally { store.close(); }
});

test('Default window and request block budget are enforced', async () => {
  const chain = source();
  chain.status = async () => ({ genesis: 'genesis', finalized: 200, finalizedHash: 'head', rpc: 'fixture' });
  const store = new Store(':memory:', 'genesis');
  try {
    const indexer = new Indexer(chain, store);
    const result = await indexer.activity({ address: alice });
    assert.equal(result.coverage.fromBlock, 181);
    assert.equal(result.coverage.toBlock, 200);
    await assert.rejects(indexer.activity({ address: alice, from_block: 1, to_block: 101 }), /100 blocks/);
  } finally { store.close(); }
});

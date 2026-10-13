import { ApiPromise, WsProvider } from '@polkadot/api';
import type { EventRecord } from '@polkadot/types/interfaces';
import type { Vec } from '@polkadot/types';
import type { IndexedBlock } from './activity.js';
import { Address } from './activity.js';

export const RPC = 'wss://polkadot-asset-hub-rpc.polkadot.io';
export const GENESIS = '0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f';
export type ChainStatus = { genesis: string; finalized: number; finalizedHash: string; rpc: string };
export interface ChainSource {
  status(): Promise<ChainStatus>;
  resolve(address: Address, block: number): Promise<string[]>;
  block(number: number): Promise<IndexedBlock>;
}

export class Chain implements ChainSource {
  private api?: Promise<ApiPromise>;
  private provider?: WsProvider;
  private connectedApi?: ApiPromise;
  constructor(readonly rpc: string) {}
  private connect(): Promise<ApiPromise> {
    if (this.connectedApi && !this.connectedApi.isConnected) this.api = undefined;
    if (!this.api) {
      const provider = new WsProvider(this.rpc, false, undefined, 20_000);
      this.provider = provider;
      this.api = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let api: ApiPromise | undefined;
        try {
          await provider.connect();
          api = new ApiPromise({ provider, noInitWarn: true });
          await Promise.race([api.isReadyOrError, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Asset Hub connection timed out.')), 30_000);
          })]);
          if (api.genesisHash.toHex() !== GENESIS) throw new Error('Expected Polkadot Asset Hub mainnet genesis.');
          this.connectedApi = api;
          return api;
        } catch (error) {
          if (api) await api.disconnect(); else await provider.disconnect();
          throw error;
        } finally { clearTimeout(timer); }
      })();
      this.api.catch(() => { this.api = undefined; });
    }
    return this.api;
  }
  async status(): Promise<ChainStatus> {
    const api = await this.connect();
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return { genesis: api.genesisHash.toHex(), finalized: header.number.toNumber(),
      finalizedHash: hash.toHex(), rpc: this.rpc };
  }
  async resolve(address: Address, block: number): Promise<string[]> {
    if (address.ss58) return [address.key];
    const api = await this.connect();
    const at = await api.at(await api.rpc.chain.getBlockHash(block));
    const accountId = at.call.reviveApi?.accountId;
    if (!accountId) throw new Error('This block does not support Revive EVM address mapping.');
    const mapped = await accountId(address.key);
    return [address.key, new Address(mapped.toString()).key];
  }
  async block(number: number): Promise<IndexedBlock> {
    const api = await this.connect();
    const hash = await api.rpc.chain.getBlockHash(number);
    const header = await api.rpc.chain.getHeader(hash);
    if (header.number.toNumber() !== number) throw new Error('RPC returned the wrong block.');
    // Decode calls using the runtime that executed the block, including upgrade boundaries.
    const parent = await api.at(header.parentHash);
    const raw = await this.provider!.send('chain_getBlock', [hash.toHex()]) as { block: { extrinsics: string[] } } | null;
    if (!raw) throw new Error(`Block ${number} unavailable.`);
    const encodedEvents = await this.provider!.send('state_getStorage', [parent.query.system!.events!.key(), hash.toHex()]) as string | null;
    if (encodedEvents === null) throw new Error(`Event state for block ${number} unavailable.`);
    const events = parent.registry.createType<Vec<EventRecord>>('Vec<EventRecord>', encodedEvents);
    return { number, hash: hash.toHex(),
      transactions: raw.block.extrinsics.map((encoded, index) => {
        const tx = parent.registry.createType('Extrinsic', encoded);
        return { index, hash: tx.hash.toHex(), signer: tx.isSigned ? tx.signer.toString() : null,
          section: tx.method.section, method: tx.method.method, args: tx.method.toPrimitive() };
      }),
      events: [...events].map(({ event, phase }, index) => ({ index,
        extrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : null,
        section: event.section, method: event.method, data: event.data.map(value => value.toPrimitive()) })),
    };
  }
  async close(): Promise<void> {
    if (this.connectedApi) await this.connectedApi.disconnect();
    else await this.provider?.disconnect();
  }
}

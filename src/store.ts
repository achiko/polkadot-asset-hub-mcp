import { DatabaseSync } from 'node:sqlite';
import type { IndexedBlock } from './activity.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, genesis: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL);`);
    const stored = this.db.prepare("SELECT value FROM metadata WHERE key = 'genesis'").get();
    if (stored && stored.value !== genesis) { this.db.close(); throw new Error('Index belongs to another chain.'); }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('genesis', ?)").run(genesis);
  }
  get(number: number): IndexedBlock | undefined {
    const row = this.db.prepare('SELECT payload FROM blocks WHERE number = ?').get(number);
    return row ? JSON.parse(String(row.payload)) as IndexedBlock : undefined;
  }
  save(block: IndexedBlock): void {
    const prior = this.get(block.number);
    if (prior && prior.hash !== block.hash) throw new Error('Finalized block hash conflicts with local index.');
    this.db.prepare('INSERT OR IGNORE INTO blocks VALUES (?, ?, ?)').run(block.number, block.hash, JSON.stringify(block));
  }
  ranges(): { from: number; to: number }[] {
    const ranges: { from: number; to: number }[] = [];
    for (const row of this.db.prepare('SELECT number FROM blocks ORDER BY number').all()) {
      const number = Number(row.number);
      const last = ranges.at(-1);
      if (last && number === last.to + 1) last.to = number;
      else ranges.push({ from: number, to: number });
    }
    return ranges;
  }
  close(): void { this.db.close(); }
}

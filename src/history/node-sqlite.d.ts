// Electron 44 ships Node 24 with node:sqlite; the project's @types/node (20) predates it.
declare module "node:sqlite" {
  type Value = null | number | bigint | string | Uint8Array;
  interface StatementSync {
    run(...values: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...values: Value[]): unknown;
    all(...values: Value[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

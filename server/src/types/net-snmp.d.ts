declare module 'net-snmp' {
  export interface VarBind {
    oid: string;
    type: number;
    value: number | bigint | Buffer | string | null;
  }

  export interface Session {
    get(oids: string[], cb: (error: Error | null, varbinds: VarBind[]) => void): void;
    subtree(
      oid: string,
      feedCb: (varbinds: VarBind[]) => void,
      doneCb: (error: Error | null) => void,
    ): void;
    close(): void;
  }

  export const Version1: number;
  export const Version2c: number;

  export function createSession(
    target: string,
    community: string,
    options?: { timeout?: number; retries?: number; version?: number; port?: number },
  ): Session;

  export function isVarbindError(vb: VarBind): boolean;

  const snmp: {
    createSession: typeof createSession;
    isVarbindError: typeof isVarbindError;
    Version1: number;
    Version2c: number;
  };
  export default snmp;
}

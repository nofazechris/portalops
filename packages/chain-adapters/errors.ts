/**
 * Thrown when a block exists but the node no longer serves it by number (pruned state).
 * Observed on Portaldot V3.0 testnet: eth_getBlockByNumber only works for roughly the latest 256 blocks,
 * while eth_getLogs still works back to genesis. Callers must treat this as "cannot verify", not "reorg".
 */
export class BlockUnavailableError extends Error {
  readonly blockNumber: number;
  constructor(blockNumber: number, detail: string) {
    super(`Block ${blockNumber} is not available from the node (${detail})`);
    this.blockNumber = blockNumber;
  }
}

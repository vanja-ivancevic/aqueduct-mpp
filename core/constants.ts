/**
 * Tempo Moderato testnet defaults — the single place these network literals live, so the CLI, the
 * runtime, and the demo/smoke scripts can't drift on the token address or endpoints. Pure data only.
 */

/** pathUSD settlement token (TIP-20) on Tempo Moderato — the default Tap currency. */
export const PATH_USD = "0x20c0000000000000000000000000000000000000";

/** Default JSON-RPC endpoint for Tempo Moderato. */
export const DEFAULT_RPC_URL = "https://rpc.moderato.tempo.xyz";

/** Block explorer base — settlement txs link to `${EXPLORER_URL}/tx/<ref>`. */
export const EXPLORER_URL = "https://explore.testnet.tempo.xyz";

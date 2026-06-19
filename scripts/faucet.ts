/**
 * Fund a wallet from the public Tempo Moderato faucet — testnet only, no real money.
 *
 *   npm run faucet -- 0xYourAddress              # fund an explicit address
 *   AQUEDUCT_PRIVATE_KEY=0x… npm run faucet       # derive the address from a key
 *   AQUEDUCT_AGENT_KEY=0x…   npm run faucet       # (either key works)
 *
 * Use it to top up a `serve` wallet (AQUEDUCT_PRIVATE_KEY, pays gas to settle) or an agent wallet
 * (AQUEDUCT_AGENT_KEY, pays per row) before running paid queries by hand. The demo funds its own
 * throwaway wallets automatically, so you only need this for the manual serve/query path.
 */
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DEFAULT_RPC_URL, PATH_USD } from "../core/constants";

const rpc = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const client = createClient({ chain: tempoModerato, transport: http(rpc) });

function resolveAddress(): `0x${string}` {
  const arg = process.argv[2];
  if (arg?.startsWith("0x") && arg.length === 42) return arg as `0x${string}`;
  const key = process.env.AQUEDUCT_PRIVATE_KEY ?? process.env.AQUEDUCT_AGENT_KEY;
  if (key?.startsWith("0x")) return privateKeyToAccount(key as `0x${string}`).address;
  console.error(
    "usage: npm run faucet -- 0xAddress   (or set AQUEDUCT_PRIVATE_KEY / AQUEDUCT_AGENT_KEY)",
  );
  process.exit(1);
}

const address = resolveAddress();
console.log(`funding ${address} on Tempo Moderato (${rpc}) …`);
await Actions.faucet.fund(client, { account: address });

// Poll until the grant lands (the faucet tx confirms a moment after the call returns).
const deadline = Date.now() + 30_000;
let balance = 0n;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  balance = await Actions.token.getBalance(client, { account: address, token: PATH_USD });
  if (balance > 0n) break;
}
console.log(
  balance > 0n
    ? `done — pathUSD balance: ${balance}`
    : "faucet call sent, but no balance yet — re-run in a moment (it's idempotent)",
);

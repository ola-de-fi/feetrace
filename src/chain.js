// Chain registry. Every trace runs inside runOnChain(), and `client` / `chain()`
// resolve to that trace's chain, so the engine modules stay chain-agnostic and
// concurrent traces on different chains don't interfere.
import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicClient, http, defineChain } from "viem";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEAD = new Set([
  ZERO,
  "0x000000000000000000000000000000000000dead",
]);

const env = (k, d) => process.env[k] || d;

export const CHAINS = {
  robinhood: {
    key: "robinhood",
    id: 4663,
    name: "Robinhood Chain",
    native: "ETH",
    rpc: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
    explorer: "https://robinhoodchain.blockscout.com/address/",
    poolManagers: [
      env("POOL_MANAGER", "0x8366a39cc670b4001a1121b8f6a443a643e40951"),
    ],
    logWindow: 9_999_999n,
  },
  elysium: {
    key: "elysium",
    id: 99901,
    name: "Elysium",
    native: "HYPE",
    rpc: env("ELYSIUM_RPC_URL", "https://rpc.elysium.kinetiq.xyz"),
    // The official explorer sits behind a bot checkpoint, so links may ask
    // visitors to pass it once.
    explorer: "https://elysium.kinetiq.xyz/address/",
    // The canonical Uniswap V4 PoolManager, then the Eleos launchpad's own.
    poolManagers: [
      "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1",
      "0x5c54a7293d96b11a29a0256ee8dfdbc3059637da",
    ],
    wrappedNative: "0xba876237b0f021a6c6d852d6c26e107997cc5e81",
    logWindow: 9_999_999n,
  },
};
export const DEFAULT_CHAIN = "robinhood";

for (const c of Object.values(CHAINS)) {
  c.poolManagers = c.poolManagers.map((a) => a.toLowerCase());
  c.client = createPublicClient({
    chain: defineChain({
      id: c.id,
      name: c.name,
      nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
    }),
    transport: http(c.rpc, { timeout: 30_000, retryCount: 6, retryDelay: 500 }),
    batch: { multicall: false },
  });
}

const store = new AsyncLocalStorage();

/** The chain config for the trace currently running. */
export const chain = () => store.getStore() || CHAINS[DEFAULT_CHAIN];

export function runOnChain(key, fn) {
  const c = CHAINS[key];
  if (!c) throw new Error(`Unknown chain "${key}".`);
  return store.run(c, fn);
}

/** Public shape of a chain, safe to send to the browser. */
export const chainInfo = (c = chain()) => ({
  key: c.key,
  id: c.id,
  name: c.name,
  native: c.native,
  explorer: c.explorer,
});

/** viem client for the current trace's chain. */
export const client = new Proxy(
  {},
  { get: (_, prop) => chain().client[prop] },
);

/** Which chains have contract code at this address. */
export async function chainsWithCode(address) {
  const hits = await Promise.all(
    Object.values(CHAINS).map(async (c) => {
      try {
        const code = await c.client.getCode({ address });
        return code && code !== "0x" ? c.key : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.filter(Boolean);
}

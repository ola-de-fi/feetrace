// Uniswap V4 launchpad mode.
//
// Most launches on Robinhood Chain trade in a V4 pool whose hook skims a swap
// fee and splits it between the creator, the protocol and buybacks. Here we find
// the token's pool, read the hook's fee policy and the per-pool launch record,
// and report who gets what.
import {
  keccak256,
  toHex,
  pad,
  toFunctionSelector,
  formatUnits,
  formatEther,
} from "viem";
import { client, chain, ZERO } from "./chain.js";
import { analyzeKnownHook, analyzeHookless } from "./hooks.js";
import { extractSelectors, detectProxy } from "./bytecode.js";
import { lookupSelectors, isFeeish } from "./signatures.js";

const INITIALIZE = keccak256(
  toHex(
    "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
  ),
);
const HOOK_FEE_COLLECTED = keccak256(
  toHex("HookFeeCollected(bytes32,address,uint256,uint256)"),
);
const DYNAMIC_FEE_FLAG = 0x800000;

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordAddr = (hex, i) => "0x" + word(hex, i).slice(24);
const wordUint = (hex, i) => BigInt("0x" + word(hex, i));
const sel = (s) => toFunctionSelector(s);

async function call(to, data) {
  try {
    const r = await client.call({ to, data });
    return r.data && r.data !== "0x" ? r.data : null;
  } catch {
    return null;
  }
}

/** Find V4 pools for a token by scanning PoolManager Initialize events, newest first. */
export async function findV4Pools(token) {
  const { poolManagers, logWindow: WINDOW } = chain();
  const latest = await client.getBlockNumber();
  const t = pad(token);
  for (let to = latest; to > 0n; to = to > WINDOW ? to - WINDOW - 1n : 0n) {
    const from = to > WINDOW ? to - WINDOW : 0n;
    const range = {
      address: poolManagers,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    };
    const [a, b] = await Promise.all([
      client.request({
        method: "eth_getLogs",
        params: [{ ...range, topics: [INITIALIZE, null, null, t] }],
      }),
      client.request({
        method: "eth_getLogs",
        params: [{ ...range, topics: [INITIALIZE, null, t] }],
      }),
    ]);
    const logs = [...a, ...b];
    if (logs.length) {
      return logs.map((l) => {
        const fee = Number(wordUint(l.data, 0));
        return {
          poolId: l.topics[1],
          poolManager: l.address.toLowerCase(),
          currency0: "0x" + l.topics[2].slice(26),
          currency1: "0x" + l.topics[3].slice(26),
          lpFee: fee,
          dynamicFee: (fee & DYNAMIC_FEE_FLAG) !== 0,
          tickSpacing: Number(BigInt.asIntN(24, wordUint(l.data, 1))),
          hooks: wordAddr(l.data, 2),
          initTx: l.transactionHash,
          initBlock: BigInt(l.blockNumber).toString(),
        };
      });
    }
    if (from === 0n) break;
  }
  return [];
}

/** Identify what kind of wallet an address is (EOA, Safe multisig, clone, contract). */
export async function describeAccount(address) {
  if (!address || address === ZERO) return { address, kind: "none" };
  const code = await client.getCode({ address }).catch(() => null);
  if (!code || code === "0x") return { address, kind: "EOA (personal wallet)" };
  const threshold = await call(address, "0xe75235b8"); // getThreshold()
  if (threshold) {
    const owners = await call(address, "0xa0e67e2b"); // getOwners()
    const n = owners ? Number(wordUint(owners, 1)) : null;
    return {
      address,
      kind: `Safe multisig (${Number(BigInt(threshold))}/${n ?? "?"})`,
    };
  }
  const proxy = await detectProxy(address, code);
  if (proxy)
    return { address, kind: proxy.kind, implementation: proxy.implementation };
  return { address, kind: "Contract" };
}

const HOOK_CONTROLS = {
  "setHookFeeBps(uint256)": ["high", "Swap fee can be raised"],
  "setProtocolFeeShareBps(uint256)": [
    "medium",
    "Protocol's cut can be changed",
  ],
  "setProtocolFeeRecipient(address)": [
    "medium",
    "Protocol fee wallet can be changed",
  ],
  "setCreatorFeeRecipient(bytes32,address)": [
    "medium",
    "Creator fee wallet can be changed",
  ],
  "rescuePoolFees(bytes32)": ["high", "Hook owner can rescue (take) pool fees"],
  "sweepPoolFees(bytes32,uint256,uint256)": [
    "low",
    "Operator sweeps accumulated fees",
  ],
  "setBuybackBurnBps(uint256)": ["low", "Buyback share can be changed"],
  "setBuybackVault(address)": ["medium", "Buyback vault can be changed"],
  "setFeeSweepOperator(address)": ["low", "Sweep operator can be changed"],
};

const KNOWN_GETTERS = [
  "hookFeeBps",
  "protocolFeeShareBps",
  "protocolFeeRecipient",
  "buybackBurnBps",
  "buybackVault",
  "feeEscrow",
  "feeSweepOperator",
  "owner",
];

export async function analyzeLaunchpad(token, decimals) {
  const pools = await findV4Pools(token);
  if (!pools.length) return null;
  const pool = pools.find((p) => p.hooks !== ZERO) || pools[0];
  const quote = pool.currency0 === token ? pool.currency1 : pool.currency0;
  const { native, wrappedNative } = chain();
  const quoteSymbol =
    quote === ZERO ? native : quote === wrappedNative ? `W${native}` : "quote";

  const init = await client
    .getTransactionReceipt({ hash: pool.initTx })
    .catch(() => null);
  const result = {
    pool: { ...pool, quote, quoteSymbol },
    launchedBy: init?.from?.toLowerCase() || null,
    factory: init?.to?.toLowerCase() || null,
    hook: null,
    split: null,
    pending: null,
    collections: null,
    controls: [],
    otherFeeFunctions: [],
    extraFlags: [],
  };
  if (pool.hooks === ZERO) {
    Object.assign(result, await analyzeHookless({ pool, init, describeAccount }));
    return result;
  }

  const hookCode = await client.getCode({ address: pool.hooks });
  const selectors = extractSelectors(hookCode || "0x");
  const has = (s) => selectors.has(sel(s));

  // Launchpad hooks with their own layout (Elysium).
  const known = await analyzeKnownHook({
    pool,
    token,
    decimals,
    quote,
    has,
    describeAccount,
  });
  if (known) {
    Object.assign(result, known);
    return result;
  }

  // Fee policy getters
  const cfg = {};
  await Promise.all(
    KNOWN_GETTERS.filter((g) => has(`${g}()`)).map(async (g) => {
      const d = await call(pool.hooks, sel(`${g}()`));
      if (!d) return;
      cfg[g] = /Recipient|Vault|Escrow|Operator|owner/.test(g)
        ? wordAddr(d, 0)
        : Number(wordUint(d, 0));
    }),
  );

  // Per-pool launch record: launches(bytes32). Layout observed on chain:
  // [registered, ?, token, quote, creator, creatorFeeRecipient, protocolRecipient, ?, protoShare, buyback, hookFee, maxImpact, buybackEnabled]
  let launch = null;
  if (has("launches(bytes32)")) {
    const d = await call(
      pool.hooks,
      sel("launches(bytes32)") + pool.poolId.slice(2),
    );
    if (d && d.length >= 2 + 64 * 13 && wordAddr(d, 2) === token) {
      launch = {
        creator: wordAddr(d, 4),
        creatorFeeRecipient: wordAddr(d, 5),
        protocolFeeRecipient: wordAddr(d, 6),
        protocolFeeShareBps: Number(wordUint(d, 8)),
        buybackBurnBps: Number(wordUint(d, 9)),
        hookFeeBps: Number(wordUint(d, 10)),
        buybackEnabled: wordUint(d, 12) !== 0n,
      };
    }
  }

  const feeBps = launch?.hookFeeBps ?? cfg.hookFeeBps ?? null;
  const protoBps =
    launch?.protocolFeeShareBps ?? cfg.protocolFeeShareBps ?? null;

  const [owner, creatorWallet, protocolWallet, escrow] = await Promise.all([
    describeAccount(cfg.owner),
    describeAccount(launch?.creatorFeeRecipient),
    describeAccount(launch?.protocolFeeRecipient ?? cfg.protocolFeeRecipient),
    describeAccount(cfg.feeEscrow),
  ]);
  if (escrow.address && escrow.kind !== "none") {
    escrow.balanceEth = Number(
      formatEther(await client.getBalance({ address: escrow.address })),
    );
  }

  result.hook = {
    address: pool.hooks,
    owner,
    escrow,
    sweepOperator: cfg.feeSweepOperator || null,
    config: cfg,
  };

  if (feeBps != null) {
    const parts = [];
    if (protoBps != null) {
      parts.push({
        role: "Protocol",
        sharePct: protoBps / 100,
        ofTradePct: (feeBps * protoBps) / 1e6,
        wallet: protocolWallet,
      });
      parts.push({
        role: "Creator",
        sharePct: (10000 - protoBps) / 100,
        ofTradePct: (feeBps * (10000 - protoBps)) / 1e6,
        wallet: creatorWallet,
        creator: launch?.creator || null,
      });
    }
    result.split = {
      feeBps,
      feePct: feeBps / 100,
      parts,
      buyback: launch
        ? {
            configuredPct: launch.buybackBurnBps / 100,
            enabled: launch.buybackEnabled,
            vault: cfg.buybackVault || null,
          }
        : null,
    };
  }

  // Unclaimed fees sitting in the hook for this pool
  if (has("pendingFees(bytes32,address)")) {
    const read = async (fn, cur) => {
      const d = await call(
        pool.hooks,
        sel(fn) + pool.poolId.slice(2) + pad(cur).slice(2),
      );
      return d ? wordUint(d, 0) : null;
    };
    const fmtCur = (v, cur) =>
      v == null
        ? null
        : Number(cur === token ? formatUnits(v, decimals) : formatEther(v));
    const [fq, ft, cq, ct] = await Promise.all([
      read("pendingFees(bytes32,address)", quote),
      read("pendingFees(bytes32,address)", token),
      has("pendingCreatorTax(bytes32,address)")
        ? read("pendingCreatorTax(bytes32,address)", quote)
        : null,
      has("pendingCreatorTax(bytes32,address)")
        ? read("pendingCreatorTax(bytes32,address)", token)
        : null,
    ]);
    result.pending = {
      poolFees: { quote: fmtCur(fq, quote), token: fmtCur(ft, token) },
      creatorTax:
        cq == null && ct == null
          ? null
          : { quote: fmtCur(cq, quote), token: fmtCur(ct, token) },
    };
  }

  // How often the hook has collected fees on this pool recently
  try {
    const latest = await client.getBlockNumber();
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: pool.hooks,
          topics: [HOOK_FEE_COLLECTED, pool.poolId],
          fromBlock:
            "0x" +
            (latest > chain().logWindow
              ? latest - chain().logWindow
              : 0n
            ).toString(16),
          toBlock: "latest",
        },
      ],
    });
    result.collections = {
      count: logs.length,
      lastBlock: logs.length
        ? BigInt(logs[logs.length - 1].blockNumber).toString()
        : null,
    };
  } catch {
    result.collections = null;
  }

  for (const [signature, [level, title]] of Object.entries(HOOK_CONTROLS)) {
    if (has(signature)) result.controls.push({ signature, level, title });
  }
  const knownSels = new Set(
    [...Object.keys(HOOK_CONTROLS), ...KNOWN_GETTERS.map((g) => `${g}()`)].map(
      sel,
    ),
  );
  const looked = await lookupSelectors(
    [...selectors].filter((s) => !knownSels.has(s)).slice(0, 120),
  );
  result.otherFeeFunctions = Object.values(looked)
    .filter(isFeeish)
    .filter((n) => !/^pending|Fee(Bps|Recipient|Policy)\(\)$/.test(n));

  return result;
}

export function launchpadFlags(lp) {
  const flags = [...(lp?.extraFlags || [])];
  if (!lp?.hook) return flags;
  const add = (level, title, detail, evidence = []) =>
    flags.push({ level, title, detail, evidence });
  const ownerKind = lp.hook.owner?.kind || "unknown";
  const ownerNote = /Safe/.test(ownerKind)
    ? ` Hook owner is a ${ownerKind}, so changes need several signers.`
    : ` Hook owner: ${ownerKind}.`;

  const safe = /Safe/.test(ownerKind);
  const rescue = lp.controls.find((c) =>
    c.signature.startsWith("rescuePoolFees"),
  );
  if (rescue) {
    add(
      safe ? "medium" : "high",
      rescue.title,
      `The hook can pull fees out of a pool.${ownerNote}`,
      [rescue.signature, `hook: ${lp.hook.address}`],
    );
  }
  const admin = lp.controls.filter((c) => c !== rescue);
  if (admin.length) {
    add(
      admin.some((c) => c.level === "high") && !safe ? "high" : "medium",
      "Launchpad admin can change the fee setup",
      `The hook owner can change: ${admin.map((c) => c.title.toLowerCase()).join("; ")}.${ownerNote}`,
      admin.map((c) => c.signature),
    );
  }
  if (lp.split?.feePct >= 3)
    add(
      "high",
      `High swap fee (${lp.split.feePct}%)`,
      "Every buy and sell pays this to the hook.",
    );
  const creator = lp.split?.parts.find((p) => p.role === "Creator");
  if (creator?.wallet?.kind?.startsWith("EOA")) {
    add(
      "low",
      "Creator fees go to a personal wallet",
      "Normal for launchpads, but it means one person controls the payout.",
      [creator.wallet.address],
    );
  }
  if (lp.hook.escrow?.balanceEth > 0) {
    add(
      "low",
      "Fees held in a shared escrow",
      `The launchpad escrow currently holds ${lp.hook.escrow.balanceEth.toFixed(2)} ${chain().native} across all pools.`,
      [lp.hook.escrow.address],
    );
  }
  if (
    lp.split?.buyback &&
    !lp.split.buyback.enabled &&
    lp.split.buyback.configuredPct > 0
  ) {
    add(
      "low",
      "Buyback configured but off",
      `The hook has a ${lp.split.buyback.configuredPct}% buyback setting, but it is disabled for this pool.`,
    );
  }
  return flags;
}

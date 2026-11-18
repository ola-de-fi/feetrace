// Launchpad-specific decoders for Uniswap V4 pools on Elysium.
//
// Each decoder is picked by the functions present in the hook's bytecode, not
// by address, so a redeployed hook with the same interface still decodes.
// Layouts were read from live pools; anything not confirmed on chain is left
// out of the report instead of guessed.
import {
  toFunctionSelector,
  pad,
  formatEther,
  keccak256,
  encodeAbiParameters,
} from "viem";
import { client, chain, ZERO, DEAD } from "./chain.js";

const sel = (s) => toFunctionSelector(s);
const words = (d) =>
  d && d !== "0x" ? d.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w)) : null;
const asAddr = (w) =>
  w == null ? null : "0x" + w.toString(16).padStart(40, "0").slice(-40);
const round2 = (x) => Math.round(x * 100) / 100;

async function read(to, signature, args = "") {
  try {
    const r = await client.call({ to, data: sel(signature) + args });
    return words(r.data);
  } catch {
    return null;
  }
}
const arg = (v) => (v.length === 66 ? v.slice(2) : pad(v).slice(2));

/**
 * In-range liquidity of a V4 pool, read straight from PoolManager storage
 * (Pool.State lives at keccak256(poolId, 6); liquidity is 3 slots in).
 */
export async function poolLiquidity(pool) {
  const base = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        [pool.poolId, 6n],
      ),
    ),
  );
  const hex = (n) => n.toString(16).padStart(64, "0");
  const [slot0, liq] = await Promise.all([
    read(pool.poolManager, "extsload(bytes32)", hex(base)),
    read(pool.poolManager, "extsload(bytes32)", hex(base + 3n)),
  ]);
  if (!slot0 || !liq) return null;
  return {
    liquidity: liq[0] & ((1n << 128n) - 1n),
    tick: Number(BigInt.asIntN(24, (slot0[0] >> 160n) & 0xffffffn)),
  };
}

const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/* ------------------------------------------------------------------ */
/* Fee-rate hook: one hook for all pools, dynamic swap fee, a fixed    */
/* protocol cut and the rest to a per-pool creator recipient.          */
/* ------------------------------------------------------------------ */

const isFeeRateHook = (has) =>
  has("currentFeeRate(bytes32,address)") &&
  has("recipientOf(bytes32)") &&
  has("poolConfig(bytes32)");

async function analyzeFeeRateHook({ pool, quote, has, describeAccount }) {
  const hook = pool.hooks;
  const id = arg(pool.poolId);
  const [rate, cfg, recipient, pendCreator, pendProtocol, vault, owner, cap] =
    await Promise.all([
      read(hook, "currentFeeRate(bytes32,address)", id + arg(ZERO)),
      read(hook, "poolConfig(bytes32)", id),
      read(hook, "recipientOf(bytes32)", id),
      read(hook, "pendingCreator(bytes32)", id),
      read(hook, "pendingProtocol(bytes32)", id),
      read(hook, "protocolVault()"),
      read(hook, "owner()"),
      read(hook, "MAX_TOTAL_FEE_PIPS()"),
    ]);

  // Fees are in pips (1e-6). poolConfig word 2 is the protocol's cut of each
  // trade: on sampled pools pendingProtocol / (pendingProtocol + pendingCreator)
  // equals word2 / totalFee for 1%, 2% and 5% pools.
  const feePips = rate ? Number(rate[0]) : null;
  const protoPips = cfg && cfg.length > 2 ? Number(cfg[2]) : null;
  const capPips = cap ? Number(cap[0]) : null;

  const [ownerAcct, creatorWallet, protocolWallet] = await Promise.all([
    describeAccount(asAddr(owner?.[0])),
    describeAccount(asAddr(recipient?.[0])),
    describeAccount(asAddr(vault?.[0])),
  ]);

  const out = {
    launchpad: "fee-rate hook",
    hook: { address: hook, owner: ownerAcct, escrow: null, config: {} },
    controls: [],
    extraFlags: [],
  };

  if (feePips != null) {
    const parts = [];
    if (protoPips != null && protoPips <= feePips && feePips > 0) {
      parts.push({
        role: "Protocol",
        sharePct: round2((protoPips / feePips) * 100),
        ofTradePct: protoPips / 1e4,
        wallet: protocolWallet,
      });
      parts.push({
        role: "Creator",
        sharePct: round2(((feePips - protoPips) / feePips) * 100),
        ofTradePct: (feePips - protoPips) / 1e4,
        wallet: creatorWallet,
        creator: creatorWallet.address,
      });
    }
    out.split = {
      feeBps: feePips / 100,
      feePct: feePips / 1e4,
      parts,
      buyback: null,
    };
  }

  // Cross-check the configured split against what has actually accrued.
  const pc = pendCreator?.[0] ?? 0n;
  const pp = pendProtocol?.[0] ?? 0n;
  const fmtQuote = (v) => Number(formatEther(v));
  out.pending = {
    quoteIsNative: quote === ZERO,
    poolFees: { quote: fmtQuote(pp), token: 0 },
    creatorTax: { quote: fmtQuote(pc), token: 0 },
    observedProtocolSharePct:
      pc + pp > 0n ? Number((pp * 10000n) / (pc + pp)) / 100 : null,
  };

  if (has("setProtocolVault(address)"))
    out.controls.push({
      signature: "setProtocolVault(address)",
      level: "medium",
      title: "Protocol fee wallet can be changed",
    });
  if (capPips != null)
    out.extraFlags.push({
      level: feePips != null && feePips >= 30000 ? "medium" : "low",
      title: `Swap fee is set by the hook (cap ${capPips / 1e4}%)`,
      detail: `The pool uses a dynamic fee that the hook sets on every swap. It is ${feePips == null ? "unreadable" : feePips / 1e4 + "%"} right now and the hook's hard cap is ${capPips / 1e4}%.`,
      evidence: [`hook: ${hook}`, "currentFeeRate(bytes32,address)", "MAX_TOTAL_FEE_PIPS()"],
    });
  if (has("updateRecipient(bytes32,address)"))
    out.extraFlags.push({
      level: "low",
      title: "Creator fee wallet can be redirected",
      detail:
        "The current fee recipient can hand the creator's share of fees to another address.",
      evidence: ["updateRecipient(bytes32,address)"],
    });
  return out;
}

/* ------------------------------------------------------------------ */
/* Hookless pool: no fee hook, so the only fee is the pool's LP fee    */
/* and it goes to whoever owns the liquidity position.                 */
/* ------------------------------------------------------------------ */

export async function analyzeHookless({ pool, init, describeAccount }) {
  const out = { launchpad: "hookless", extraFlags: [], position: null };
  const feePct = pool.dynamicFee ? null : pool.lpFee / 1e4;

  // The pool is seeded through a position manager that mints an LP NFT.
  // That mint is the one ERC-721 Transfer (4 topics, from zero) in the launch tx.
  const mint = (init?.logs || []).find(
    (l) =>
      l.topics[0] === TRANSFER &&
      l.topics.length === 4 &&
      BigInt(l.topics[1]) === 0n,
  );
  let owner = null;
  if (mint) {
    const manager = mint.address.toLowerCase();
    const tokenId = BigInt(mint.topics[3]);
    const now = await read(manager, "ownerOf(uint256)", arg(mint.topics[3]));
    // ownerOf reverts once the NFT is burned, which also destroys the position's claim.
    owner = await describeAccount(now ? asAddr(now[0]) : ZERO);
    out.position = {
      manager,
      tokenId: tokenId.toString(),
      mintedTo: "0x" + mint.topics[2].slice(26),
      owner,
      burned: !now,
    };
  }

  const state = await poolLiquidity(pool);
  const liquidity = state ? state.liquidity : null;
  out.liquidity = liquidity == null ? null : liquidity.toString();
  out.tick = state ? state.tick : null;
  // Price pinned at the end of the range means one side of the pool is gone.
  const drained = state != null && Math.abs(state.tick) >= 887000;

  if (feePct != null)
    out.split = {
      feeBps: pool.lpFee / 100,
      feePct,
      parts: [
        {
          role: "LP owner",
          sharePct: 100,
          ofTradePct: feePct,
          wallet: owner || { address: null, kind: "unknown" },
        },
      ],
      buyback: null,
    };

  const add = (level, title, detail, evidence = []) =>
    out.extraFlags.push({ level, title, detail, evidence });
  add(
    "low",
    "No fee hook",
    `This is a plain Uniswap V4 pool. The only trading fee is the ${feePct == null ? "dynamic" : feePct + "%"} pool fee, and it is earned by the liquidity position, not by a launchpad.`,
    [`pool: ${pool.poolId}`],
  );
  if (out.position && !out.position.burned && owner) {
    const ev = [
      `position #${out.position.tokenId} on ${out.position.manager}`,
      `owner: ${owner.address}`,
    ];
    if (DEAD.has(owner.address))
      add(
        "good",
        "Launch liquidity sent to a burn address",
        "The launch liquidity position is owned by a dead address, so it cannot be withdrawn.",
        ev,
      );
    else if (owner.kind.startsWith("EOA"))
      add(
        "high",
        "Launch liquidity is held by a personal wallet",
        "The wallet that owns the launch liquidity position can withdraw it at any time, along with all trading fees. Nothing on chain locks it.",
        ev,
      );
    else
      add(
        "medium",
        "Launch liquidity is held by a contract",
        "A contract owns the launch liquidity position. Whether it can be withdrawn depends on that contract, which FeeTrace has not decoded.",
        ev,
      );
  } else if (out.position?.burned) {
    const ev = [
      `position #${out.position.tokenId} on ${out.position.manager}`,
      `minted to: ${out.position.mintedTo}`,
    ];
    if (liquidity === 0n)
      add(
        "high",
        "Launch liquidity has been withdrawn",
        `The LP position minted at launch has been closed and the pool has no liquidity at the current price${drained ? ", which is pinned at the end of its range" : ""}. Selling into this pool may not be possible.`,
        [...ev, "pool liquidity: 0", `current tick: ${state.tick}`],
      );
    else
      add(
        "medium",
        "Launch liquidity position was closed",
        "The LP position minted at launch no longer exists. The pool still has some liquidity, held in other positions FeeTrace has not traced.",
        ev,
      );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Eleos-style tax hook: per-token buy and sell tax, a platform cut of */
/* the tax, the rest to the token's creator.                           */
/* ------------------------------------------------------------------ */

const isTaxHook = (has) =>
  has("platformBps()") && has("config(address)") && has("payCreator(address)");

async function analyzeTaxHook({ pool, token, has, describeAccount }) {
  const hook = pool.hooks;
  const t = arg(token);
  const [cfg, totals, book, platformBps, platform, maxTax, snipeStart, snipeSecs] =
    await Promise.all([
      read(hook, "config(address)", t),
      read(hook, "totals(address)", t),
      read(hook, "book(address)", t),
      read(hook, "platformBps()"),
      read(hook, "platform()"),
      read(hook, "MAX_TAX_BPS()"),
      read(hook, "SNIPE_START_BPS()"),
      read(hook, "MAX_SNIPE_SECS()"),
    ]);

  // config(token): [creator, buyTaxBps, sellTaxBps, ...]. totals(token):
  // [tax collected, paid to platform, paid to creator], in the quote currency.
  // Confirmed on live tokens: platform / (platform + creator) == platformBps.
  const creator = cfg ? asAddr(cfg[0]) : null;
  const buyBps = cfg ? Number(cfg[1]) : null;
  const sellBps = cfg ? Number(cfg[2]) : null;
  const platBps = platformBps ? Number(platformBps[0]) : null;
  const maxBps = maxTax ? Number(maxTax[0]) : null;

  const [creatorWallet, platformWallet] = await Promise.all([
    describeAccount(creator),
    describeAccount(asAddr(platform?.[0])),
  ]);

  const out = {
    launchpad: "tax hook",
    hook: {
      address: hook,
      owner: { address: null, kind: "none" },
      escrow: null,
      config: {},
    },
    controls: [],
    extraFlags: [],
  };
  const add = (level, title, detail, evidence = []) =>
    out.extraFlags.push({ level, title, detail, evidence });

  if (buyBps != null && sellBps != null && buyBps <= 10000 && sellBps <= 10000) {
    const worst = Math.max(buyBps, sellBps);
    const parts = [];
    if (platBps != null && worst > 0) {
      parts.push({
        role: "Protocol",
        sharePct: platBps / 100,
        ofTradePct: (worst * platBps) / 1e6,
        wallet: platformWallet,
      });
      parts.push({
        role: "Creator",
        sharePct: (10000 - platBps) / 100,
        ofTradePct: (worst * (10000 - platBps)) / 1e6,
        wallet: creatorWallet,
        creator,
      });
    }
    out.split = {
      feeBps: worst,
      feePct: worst / 100,
      buyPct: buyBps / 100,
      sellPct: sellBps / 100,
      parts,
      buyback: null,
    };
    if (worst === 0)
      add(
        "good",
        "No trading tax set",
        "The launchpad hook charges 0% on buys and sells for this token.",
        ["config(address)"],
      );
    else if (sellBps - buyBps >= 500)
      add(
        "medium",
        `Sell tax (${sellBps / 100}%) much higher than buy tax (${buyBps / 100}%)`,
        "Buying is cheap but selling is expensive.",
        ["config(address)"],
      );
  }

  if (totals) {
    out.taxTotals = {
      collected: Number(formatEther(totals[0])),
      toPlatform: Number(formatEther(totals[1])),
      toCreator: Number(formatEther(totals[2])),
    };
  }
  if (book && book[0] > 0n)
    out.launchedAt = new Date(Number(book[0]) * 1000).toISOString();

  if (has("lowerTax(address,uint16,uint16)") && maxBps != null)
    add(
      "low",
      `Tax is capped at ${maxBps / 100}%`,
      "The hook's only tax-changing function is lowerTax, and its hard cap is " +
        `${maxBps / 100}%. FeeTrace has not verified that lowerTax rejects increases.`,
      ["lowerTax(address,uint16,uint16)", "MAX_TAX_BPS()"],
    );
  if (snipeStart && snipeSecs && snipeStart[0] > 0n)
    add(
      "low",
      `Anti-snipe tax: up to ${Number(snipeStart[0]) / 100}% at launch`,
      `Trades right after launch can pay an extra tax starting at ${Number(snipeStart[0]) / 100}%, lasting at most ${Number(snipeSecs[0])} seconds.`,
      ["SNIPE_START_BPS()", "MAX_SNIPE_SECS()"],
    );
  if (has("transferCreator(address,address)"))
    add(
      "low",
      "Creator payout can be handed to another address",
      "The creator role, and the tax that comes with it, can be transferred.",
      ["transferCreator(address,address)"],
    );
  return out;
}

/* ------------------------------------------------------------------ */

const DECODERS = [
  [isFeeRateHook, analyzeFeeRateHook],
  [isTaxHook, analyzeTaxHook],
];

/** Decode a hook we recognise; null when it is not one of ours. */
export async function analyzeKnownHook(ctx) {
  for (const [matches, analyze] of DECODERS)
    if (matches(ctx.has)) return analyze(ctx);
  return null;
}



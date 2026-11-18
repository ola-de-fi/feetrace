// FeeTrace engine: where do a token's fees actually go?
//
// Three evidence sources, from weakest to strongest:
//   1. Bytecode   - which fee/tax/wallet control functions exist.
//   2. State      - current values of fee getters and fee-wallet getters.
//   3. Behaviour  - real Transfer logs: in each trade, which third addresses
//                   receive a cut, how big that cut is, and where swapped-back
//                   ETH ends up (via call traces when the RPC supports it).
import {
  getAddress,
  formatUnits,
  decodeAbiParameters,
  formatEther,
} from "viem";
import {
  client,
  chain,
  chainInfo,
  chainsWithCode,
  runOnChain,
  CHAINS,
  DEAD,
  ZERO,
} from "./chain.js";
import { analyzeLaunchpad, launchpadFlags } from "./v4.js";
import { analyzeCurve, curveFlags } from "./curve.js";
import { extractSelectors, detectProxy } from "./bytecode.js";
import {
  GETTERS,
  CONTROL_FUNCTIONS,
  TRANSFER_TOPIC,
  lookupSelectors,
  isFeeish,
} from "./signatures.js";

const MAX_LOGS = Number(process.env.MAX_LOGS || 4000);
const MAX_WINDOWS = 24;
const INITIAL_WINDOW = 1_000_000n;

const lc = (a) => a.toLowerCase();
const topicToAddress = (t) => "0x" + t.slice(-40).toLowerCase();
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function call(to, data) {
  try {
    const r = await client.call({ to, data });
    return r.data && r.data !== "0x" ? r.data : null;
  } catch {
    return null;
  }
}

async function readMetadata(address) {
  const strOf = async (sel) => {
    const d = await call(address, sel);
    if (!d) return null;
    try {
      return decodeAbiParameters([{ type: "string" }], d)[0];
    } catch {
      // bytes32-style names
      return (
        Buffer.from(d.slice(2, 66), "hex")
          .toString("utf8")
          .replace(/\0+$/, "") || null
      );
    }
  };
  const uintOf = async (sel) => {
    const d = await call(address, sel);
    return d ? BigInt(d.slice(0, 66)) : null;
  };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    strOf("0x06fdde03"),
    strOf("0x95d89b41"),
    uintOf("0x313ce567"),
    uintOf("0x18160ddd"),
  ]);
  return {
    name,
    symbol,
    decimals: decimals == null ? 18 : Number(decimals),
    totalSupply,
  };
}

async function readGetters(address, selectors) {
  const present = GETTERS.filter((g) => selectors.has(g.selector));
  const results = await Promise.all(
    present.map((g) => call(address, g.selector)),
  );
  const out = {};
  present.forEach((g, i) => {
    const d = results[i];
    if (!d || d.length < 66) return;
    const word = BigInt(d.slice(0, 66));
    if (g.type === "address")
      out[g.name] = {
        type: "address",
        value: "0x" + d.slice(26, 66).toLowerCase(),
      };
    else if (g.type === "bool")
      out[g.name] = { type: "bool", value: word !== 0n };
    else out[g.name] = { type: "uint", value: word.toString() };
  });
  return out;
}

/** Fetch Transfer logs for the token, walking backwards in windows until we have enough. */
async function fetchTransferLogs(address) {
  const latest = await client.getBlockNumber();
  const logs = [];
  let to = latest;
  let windowSize = INITIAL_WINDOW;
  let windows = 0;
  let earliest = latest;

  while (to > 0n && windows < MAX_WINDOWS && logs.length < MAX_LOGS) {
    const from = to > windowSize ? to - windowSize + 1n : 0n;
    try {
      const batch = await client.request({
        method: "eth_getLogs",
        params: [
          {
            address,
            topics: [TRANSFER_TOPIC],
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
          },
        ],
      });
      logs.push(...batch);
      earliest = from;
      to = from - 1n;
      windows++;
      if (batch.length === 0 && windowSize < 8_000_000n) windowSize *= 2n;
    } catch (e) {
      const msg = `${e.details || ""} ${e.message || ""}`;
      if (!/exceed|span|limit|range|too many results/i.test(msg) || /Too Many Requests/i.test(msg)) throw e;
      if (windowSize <= 100n) throw e;
      windowSize /= 4n; // range or result-size limit: shrink and retry
    }
  }

  // Keep the most recent MAX_LOGS so the sample is "how it behaves now".
  logs.sort(
    (a, b) =>
      Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) ||
      Number(BigInt(b.logIndex) - BigInt(a.logIndex)),
  );
  const kept = logs.slice(0, MAX_LOGS);
  const blocks = kept.map((l) => BigInt(l.blockNumber));
  return {
    logs: kept,
    fromBlock: blocks.length
      ? blocks.reduce((a, b) => (a < b ? a : b))
      : earliest,
    toBlock: latest,
  };
}

const parseTransfer = (l) => ({
  tx: l.transactionHash,
  block: BigInt(l.blockNumber),
  index: BigInt(l.logIndex),
  from: topicToAddress(l.topics[1]),
  to: topicToAddress(l.topics[2]),
  amount: l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n,
});

/** Identify AMM pools among the busiest counterparties. */
async function findPools(transfers, token) {
  const counts = new Map();
  for (const t of transfers)
    for (const a of [t.from, t.to]) counts.set(a, (counts.get(a) || 0) + 1);
  const top = [...counts.entries()]
    .filter(([a]) => a !== token && !DEAD.has(a))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([a]) => a);
  const pools = new Set();
  await Promise.all(
    top.map(async (a) => {
      // token0() works for Uniswap V2 & V3 style pools
      const t0 = await call(a, "0x0dfe1681");
      if (t0) pools.add(a);
    }),
  );
  return pools;
}

/** Core heuristic: in a trade, the sender pays the counterparty plus smaller cuts to fee sinks. */
function findFeeLegs(transfers, pools, token) {
  const byTx = new Map();
  for (const t of transfers) {
    if (t.from === ZERO) continue; // mints are not fees
    if (!byTx.has(t.tx)) byTx.set(t.tx, []);
    byTx.get(t.tx).push(t);
  }

  const legs = [];
  const trades = { buy: [], sell: [], transfer: [] };

  for (const [tx, ts] of byTx) {
    const bySender = new Map();
    for (const t of ts) {
      if (!bySender.has(t.from)) bySender.set(t.from, []);
      bySender.get(t.from).push(t);
    }
    for (const [from, outs] of bySender) {
      // A contract swapping its own accumulated fees is a swapback, not a taxed trade.
      if (from === token) continue;
      const sorted = [...outs].sort((a, b) =>
        b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
      );
      const main = sorted[0];
      const total = sorted.reduce((s, t) => s + t.amount, 0n);
      if (total === 0n) continue;
      const direction = pools.has(from)
        ? "buy"
        : pools.has(main.to)
          ? "sell"
          : "transfer";
      let feeTotal = 0n;
      for (const t of sorted.slice(1)) {
        if (t.to === main.to || t.to === from) continue;
        const rate = Number((t.amount * 1_000_000n) / total) / 1_000_000;
        if (rate <= 0 || rate > 0.5) continue;
        feeTotal += t.amount;
        legs.push({
          tx,
          from,
          recipient: t.to,
          amount: t.amount,
          rate,
          direction,
        });
      }
      trades[direction].push(
        Number((feeTotal * 1_000_000n) / total) / 1_000_000,
      );
    }
  }
  return { legs, trades, txCount: byTx.size };
}

/** Try to follow swapped-back ETH using call traces (if the RPC exposes debug_*). */
async function traceSwapbackEth(txs, token) {
  const dest = new Map();
  let traced = 0;
  let supported = true;
  for (const tx of txs.slice(0, 4)) {
    let trace;
    try {
      trace = await client.request({
        method: "debug_traceTransaction",
        params: [tx, { tracer: "callTracer" }],
      });
    } catch {
      supported = false;
      break;
    }
    traced++;
    // Collect ETH value sent by the token contract (or by calls nested under it).
    const walk = (node, underToken) => {
      const from = lc(node.from || "");
      const to = lc(node.to || "");
      const value = node.value ? BigInt(node.value) : 0n;
      const inToken = underToken || from === token;
      if (from === token && value > 0n && to !== token) {
        dest.set(to, (dest.get(to) || 0n) + value);
      }
      for (const c of node.calls || []) walk(c, inToken);
    };
    walk(trace, false);
  }
  return {
    supported,
    traced,
    destinations: [...dest.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([address, wei]) => ({ address, eth: Number(formatEther(wei)) })),
  };
}

async function isContract(address) {
  try {
    const code = await client.getCode({ address });
    return !!code && code !== "0x";
  } catch {
    return false;
  }
}

function labelFor(address, { token, getters, pools, owner }) {
  if (address === token) return "Token contract (fees accumulate here)";
  if (DEAD.has(address)) return "Burn address";
  if (pools.has(address)) return "Liquidity pool (auto-LP)";
  const named = Object.entries(getters)
    .filter(([, g]) => g.type === "address" && g.value === address)
    .map(([n]) => n);
  if (named.length) return named.join(" / ");
  if (owner && address === owner) return "Owner wallet";
  return null;
}

const pct = (x) => (x == null ? null : Math.round(x * 10000) / 100);

/**
 * Trace a token's fees. `chainKey` picks the chain; when omitted, the chain is
 * detected by looking for contract code at the address on every known chain.
 */
export async function traceFees(input, chainKey) {
  const address = lc(getAddress(input.trim()));
  let alsoOn = [];
  if (!chainKey) {
    const hits = await chainsWithCode(address);
    if (!hits.length)
      throw new Error(
        `No contract at this address on ${Object.values(CHAINS)
          .map((c) => c.name)
          .join(" or ")}.`,
      );
    [chainKey, ...alsoOn] = hits;
  }
  if (!CHAINS[chainKey]) throw new Error(`Unknown chain "${chainKey}".`);
  return runOnChain(chainKey, async () => ({
    ...(await traceOnChain(address)),
    alsoOn,
  }));
}

async function traceOnChain(address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x")
    throw new Error(`No contract at this address on ${chain().name}.`);

  const proxy = await detectProxy(address, code);
  let logicCode = code;
  if (proxy?.implementation) {
    const implCode = await client
      .getCode({ address: proxy.implementation })
      .catch(() => null);
    if (implCode && implCode !== "0x") logicCode = implCode;
  }
  const selectors = extractSelectors(logicCode);

  const [meta, getters, transferData] = await Promise.all([
    readMetadata(address),
    readGetters(address, selectors),
    fetchTransferLogs(address),
  ]);
  const fmt = (v) => Number(formatUnits(v, meta.decimals));
  const launchpad = await analyzeLaunchpad(address, meta.decimals).catch(
    (e) => ({ error: e.shortMessage || e.message }),
  );

  // Control surface
  const known = new Set();
  const controls = CONTROL_FUNCTIONS.filter((f) =>
    selectors.has(f.selector),
  ).map((f) => {
    known.add(f.selector);
    return { category: f.category, signature: f.signature };
  });
  GETTERS.forEach((g) => known.add(g.selector));
  const unknown = [...selectors].filter((s) => !known.has(s));
  const looked = await lookupSelectors(unknown.slice(0, 120));
  const otherFeeFunctions = Object.entries(looked)
    .filter(([, name]) => isFeeish(name))
    .map(([selector, signature]) => ({ selector, signature }));

  const ownerAddr = getters.owner?.value || getters.getOwner?.value || null;
  const renounced = ownerAddr ? DEAD.has(ownerAddr) : null;

  // Behaviour
  const transfers = transferData.logs.map(parseTransfer);
  const pools = await findPools(transfers, address);
  // A Uniswap V4 singleton holds every V4 pool's tokens.
  for (const pm of chain().poolManagers)
    if (transfers.some((t) => t.from === pm || t.to === pm)) pools.add(pm);

  // Launchpad tokens trade on a per-token bonding curve until they graduate.
  const counterparties = new Map();
  for (const t of transfers)
    for (const a of [t.from, t.to])
      if (a !== address && !DEAD.has(a)) counterparties.set(a, (counterparties.get(a) || 0) + 1);
  const curve = await analyzeCurve(
    address,
    [...counterparties.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a),
  ).catch(() => null);
  if (curve) pools.add(curve.curve);
  const { legs, trades, txCount } = findFeeLegs(transfers, pools, address);

  const byRecipient = new Map();
  for (const leg of legs) {
    const r = byRecipient.get(leg.recipient) || {
      amount: 0n,
      txs: new Set(),
      senders: new Set(),
      rates: [],
      directions: {},
    };
    r.amount += leg.amount;
    r.txs.add(leg.tx);
    r.senders.add(leg.from);
    r.rates.push(leg.rate);
    r.directions[leg.direction] = (r.directions[leg.direction] || 0) + 1;
    byRecipient.set(leg.recipient, r);
  }
  // Require repetition so one-off multi-sends don't look like fees.
  const sinks = [...byRecipient.entries()].filter(
    ([, r]) => r.txs.size >= 3 && r.senders.size >= 2,
  );
  const totalFees = sinks.reduce((s, [, r]) => s + r.amount, 0n);

  const recipients = await Promise.all(
    sinks
      .sort((a, b) => (b[1].amount > a[1].amount ? 1 : -1))
      .slice(0, 12)
      .map(async ([addr, r]) => ({
        address: addr,
        label: labelFor(addr, {
          token: address,
          getters,
          pools,
          owner: ownerAddr,
        }),
        isContract:
          addr === address
            ? true
            : DEAD.has(addr)
              ? false
              : await isContract(addr),
        amount: fmt(r.amount),
        share:
          totalFees > 0n ? Number((r.amount * 10000n) / totalFees) / 100 : 0,
        txCount: r.txs.size,
        medianRatePct: pct(median(r.rates)),
        directions: r.directions,
      })),
  );

  // Swapback: token contract selling its accumulated fee tokens into a pool.
  const swapbackTxs = [
    ...new Set(
      transfers
        .filter((t) => t.from === address && pools.has(t.to))
        .map((t) => t.tx),
    ),
  ];
  const swapback = {
    detected: swapbackTxs.length > 0,
    count: swapbackTxs.length,
    sampleTxs: swapbackTxs.slice(0, 5),
    eth: null,
  };
  if (swapback.detected) {
    swapback.eth = await traceSwapbackEth(swapbackTxs, address);
    for (const d of swapback.eth.destinations) {
      d.label = labelFor(d.address, {
        token: address,
        getters,
        pools,
        owner: ownerAddr,
      });
      d.isContract = await isContract(d.address);
    }
  }

  const observed = {
    fromBlock: transferData.fromBlock.toString(),
    toBlock: transferData.toBlock.toString(),
    transfers: transfers.length,
    txs: txCount,
    pools: [...pools],
    buy: { count: trades.buy.length, medianFeePct: pct(median(trades.buy)) },
    sell: { count: trades.sell.length, medianFeePct: pct(median(trades.sell)) },
    transfer: {
      count: trades.transfer.length,
      medianFeePct: pct(median(trades.transfer)),
    },
  };

  const flags = buildFlags({
    controls,
    otherFeeFunctions,
    renounced,
    ownerAddr,
    proxy,
    observed,
    recipients,
    swapback,
  });
  const onCurve = curve && !curve.graduated;
  if (onCurve || launchpad?.hook || launchpad?.extraFlags?.length) {
    flags.push(...(onCurve ? curveFlags(curve) : launchpadFlags(launchpad)));
    const order = { high: 0, medium: 1, low: 2, good: 3 };
    const filtered = flags.filter((f) => f.title !== "No fee flows observed");
    flags.length = 0;
    flags.push(...filtered.sort((a, b) => order[a.level] - order[b.level]));
  }

  return {
    address,
    chain: chainInfo(),
    token: {
      ...meta,
      totalSupply: meta.totalSupply == null ? null : fmt(meta.totalSupply),
    },
    proxy,
    owner: { address: ownerAddr, renounced },
    getters,
    controls,
    otherFeeFunctions,
    observed,
    recipients,
    swapback,
    launchpad,
    curve,
    flags,
    generatedAt: new Date().toISOString(),
  };
}

function buildFlags({
  controls,
  otherFeeFunctions,
  renounced,
  ownerAddr,
  proxy,
  observed,
  recipients,
  swapback,
}) {
  const flags = [];
  const has = (c) => controls.filter((f) => f.category === c);
  const live = renounced !== true; // owner (if any) can still call admin functions
  const add = (level, title, detail, evidence = []) =>
    flags.push({ level, title, detail, evidence });

  // EIP-1167 clones point at a fixed implementation and cannot be upgraded.
  if (proxy && !/1167/.test(proxy.kind)) {
    add(
      "high",
      "Upgradeable contract",
      `This token is a ${proxy.kind}. Whoever controls the upgrade can replace all fee logic at any time.`,
      [
        `implementation: ${proxy.implementation}`,
        ...(proxy.admin ? [`admin: ${proxy.admin}`] : []),
      ],
    );
  }

  const rate = has("rate");
  if (rate.length && live)
    add(
      "high",
      "Fees can be changed",
      "The contract has functions to change fee rates, and ownership is not renounced.",
      rate.map((f) => f.signature),
    );
  const wallet = has("wallet");
  if (wallet.length && live)
    add(
      "high",
      "Fee wallet can be redirected",
      "The fee destination can be changed to any address.",
      wallet.map((f) => f.signature),
    );
  const withdraw = has("withdraw");
  if (withdraw.length && live)
    add(
      "medium",
      "Accumulated fees can be pulled manually",
      "Functions exist to swap or withdraw fees held by the contract on demand.",
      withdraw.map((f) => f.signature),
    );
  const exempt = has("exempt");
  if (exempt.length)
    add(
      "medium",
      "Some wallets can trade tax-free",
      "Addresses can be excluded from fees. Insiders often exempt themselves.",
      exempt.map((f) => f.signature),
    );
  const bl = has("blacklist");
  if (bl.length)
    add(
      "high",
      "Blacklist / bot-blocking functions",
      "Wallets can be blocked from trading, which can trap holders.",
      bl.map((f) => f.signature),
    );
  if (otherFeeFunctions.length)
    add(
      "low",
      "Other fee-related functions",
      "Matched in a public signature database; behaviour not verified.",
      otherFeeFunctions.map((f) => f.signature),
    );

  if (renounced === true)
    add(
      "good",
      "Ownership renounced",
      "Owner is the zero/dead address, so owner-only fee settings are frozen.",
      [`owner: ${ownerAddr}`],
    );
  else if (ownerAddr)
    add(
      "low",
      "Active owner",
      "An owner wallet still controls this contract.",
      [`owner: ${ownerAddr}`],
    );

  const worst = Math.max(
    observed.buy.medianFeePct || 0,
    observed.sell.medianFeePct || 0,
  );
  if (worst >= 10)
    add(
      "high",
      `High observed tax (${worst}%)`,
      "Real trades are losing a large cut to fees.",
      [
        `buy median ${observed.buy.medianFeePct ?? "–"}%`,
        `sell median ${observed.sell.medianFeePct ?? "–"}%`,
      ],
    );
  if (
    (observed.sell.medianFeePct || 0) - (observed.buy.medianFeePct || 0) >=
    5
  ) {
    add(
      "medium",
      "Sell tax much higher than buy tax",
      "Buying is cheap but selling is expensive, a common honeypot-lite pattern.",
    );
  }

  const eoaSinks = recipients.filter(
    (r) => !r.isContract && !DEAD.has(r.address),
  );
  if (eoaSinks.length)
    add(
      "medium",
      "Fees go straight to personal wallets",
      "At least one fee recipient is a regular wallet, not a contract.",
      eoaSinks.map((r) => `${r.address} (${r.share}% of fees)`),
    );

  const ethEoa = (swapback.eth?.destinations || []).filter(
    (d) => !d.isContract,
  );
  if (ethEoa.length)
    add(
      "medium",
      "Swapped-back ETH goes to personal wallets",
      "Fees are sold for ETH and sent to regular wallets.",
      ethEoa.map((d) => `${d.address} (${d.eth.toFixed(4)} ETH sampled)`),
    );

  if (!recipients.length && !swapback.detected && observed.transfers > 50) {
    add(
      "good",
      "No fee flows observed",
      "Recent transfers show no repeated third-party cuts.",
    );
  }
  const order = { high: 0, medium: 1, low: 2, good: 3 };
  return flags.sort((a, b) => order[a.level] - order[b.level]);
}

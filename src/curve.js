// Bonding-curve mode.
//
// Robinhood Chain launchpad tokens start on a per-token bonding-curve market
// before graduating to a Uniswap V4 hook pool. The curve charges a swap fee
// (split with the protocol), a creator tax on top, and a decaying snipe tax for
// the first seconds after launch.
import { toFunctionSelector, formatEther } from 'viem';
import { client } from './chain.js';
import { extractSelectors } from './bytecode.js';
import { describeAccount } from './v4.js';

const sel = (s) => toFunctionSelector(s);
const IS_CURVE = ['feeBps()', 'creatorTaxBps()', 'graduated()', 'token()'].map(sel);

async function read(address, fn) {
  try {
    const r = await client.call({ to: address, data: sel(`${fn}()`) });
    return r.data && r.data.length >= 66 ? r.data.slice(0, 66) : null;
  } catch {
    return null;
  }
}
const asUint = (w) => (w == null ? null : BigInt(w));
const asAddr = (w) => (w == null ? null : '0x' + w.slice(-40).toLowerCase());
const asEth = (w) => (w == null ? null : Number(formatEther(BigInt(w))));

/** Find the token's curve market among its busiest counterparties. */
export async function findCurve(token, candidates) {
  for (const address of candidates.slice(0, 8)) {
    const code = await client.getCode({ address }).catch(() => null);
    if (!code || code === '0x') continue;
    const sels = extractSelectors(code);
    if (!IS_CURVE.every((s) => sels.has(s))) continue;
    if (asAddr(await read(address, 'token')) === token) return { address, selectors: sels };
  }
  return null;
}

export async function analyzeCurve(token, candidates) {
  const found = await findCurve(token, candidates);
  if (!found) return null;
  const { address, selectors } = found;

  const names = [
    'feeBps', 'creatorTaxBps', 'protocolFeeShareBps', 'protocolFeeRecipient', 'buybackBurnBps',
    'buybackEnabled', 'buybackCreatorRecipient', 'buybackVault', 'deployer', 'snipeTaxStartBps',
    'snipeTaxSeconds', 'launchedAt', 'graduated', 'graduationThreshold', 'realQuoteReserve',
    'quoteFeeBalance', 'creatorTaxBalance', 'feeEscrow', 'feePolicy', 'isNativeQuote',
  ];
  const vals = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(address, n)])));

  const feeBps = Number(asUint(vals.feeBps) ?? 0n);
  const creatorTaxBps = Number(asUint(vals.creatorTaxBps) ?? 0n);
  const protoShareBps = Number(asUint(vals.protocolFeeShareBps) ?? 0n);
  const totalBps = feeBps + creatorTaxBps;
  const protocolBps = (feeBps * protoShareBps) / 10000;
  const creatorBps = totalBps - protocolBps;

  const creatorAddr = asAddr(vals.buybackCreatorRecipient) || asAddr(vals.deployer);
  const [creatorWallet, protocolWallet, escrow] = await Promise.all([
    describeAccount(creatorAddr),
    describeAccount(asAddr(vals.protocolFeeRecipient)),
    describeAccount(asAddr(vals.feeEscrow)),
  ]);

  const threshold = asEth(vals.graduationThreshold);
  const raised = asEth(vals.realQuoteReserve);
  const has = (s) => selectors.has(sel(s));

  return {
    stage: 'curve',
    curve: address,
    graduated: asUint(vals.graduated) === 1n,
    quoteSymbol: asUint(vals.isNativeQuote) === 0n ? 'quote' : 'ETH',
    deployer: asAddr(vals.deployer),
    feePolicy: asAddr(vals.feePolicy),
    escrow,
    progress: threshold ? { raised, threshold, pct: Math.min(100, Math.round((raised / threshold) * 1000) / 10) } : null,
    snipeTax: vals.snipeTaxStartBps ? { startPct: Number(asUint(vals.snipeTaxStartBps)) / 100, seconds: Number(asUint(vals.snipeTaxSeconds)) } : null,
    launchedAt: vals.launchedAt ? new Date(Number(asUint(vals.launchedAt)) * 1000).toISOString() : null,
    split: {
      feeBps: totalBps,
      feePct: totalBps / 100,
      swapFeePct: feeBps / 100,
      creatorTaxPct: creatorTaxBps / 100,
      parts: totalBps
        ? [
            { role: 'Protocol', sharePct: Math.round((protocolBps / totalBps) * 1000) / 10, ofTradePct: protocolBps / 100, wallet: protocolWallet },
            { role: 'Creator', sharePct: Math.round((creatorBps / totalBps) * 1000) / 10, ofTradePct: creatorBps / 100, wallet: creatorWallet, creator: asAddr(vals.deployer) },
          ]
        : [],
      buyback: { configuredPct: Number(asUint(vals.buybackBurnBps) ?? 0n) / 100, enabled: asUint(vals.buybackEnabled) === 1n, vault: asAddr(vals.buybackVault) },
    },
    pending: {
      protocolFees: asEth(vals.quoteFeeBalance),
      creatorTax: asEth(vals.creatorTaxBalance),
    },
    controls: {
      rescueFees: has('rescueFees()'),
      setCreatorFeeRecipient: has('setCreatorFeeRecipient(address)'),
      setBuybackEnabled: has('setBuybackEnabled(bool)'),
      sweepFees: has('sweepFees(uint256)'),
    },
  };
}

export function curveFlags(c) {
  const flags = [];
  const add = (level, title, detail, evidence = []) => flags.push({ level, title, detail, evidence });
  const s = c.split;

  if (s.feePct >= 5) add('high', `High total trading cut (${s.feePct}%)`, 'Every buy and sell on the curve loses this much to fees and creator tax.');
  if (s.creatorTaxPct > 0) {
    add(s.creatorTaxPct >= 3 ? 'medium' : 'low', `Creator tax: ${s.creatorTaxPct}% on top of the ${s.swapFeePct}% fee`,
      `The creator takes ${s.creatorTaxPct}% of every curve trade, on top of their share of the swap fee.`, [`curve: ${c.curve}`]);
  }
  if (c.snipeTax?.startPct) {
    add('low', `Anti-snipe tax: ${c.snipeTax.startPct}% at launch`, `Buys in the first ${c.snipeTax.seconds}s after launch pay a tax starting at ${c.snipeTax.startPct}%, decaying to zero.`);
  }
  const creator = s.parts.find((p) => p.role === 'Creator');
  if (creator?.wallet?.kind?.startsWith('EOA')) {
    add('low', 'Creator fees go to a personal wallet', 'Normal for launchpads, but one person controls the payout.', [creator.wallet.address]);
  }
  if (c.controls.rescueFees) add('medium', 'Fees can be rescued by an admin', 'The curve contract has rescueFees(), so accumulated fees can be pulled out by a privileged account.', ['rescueFees()', `curve: ${c.curve}`]);
  if (c.controls.setCreatorFeeRecipient) add('low', 'Creator fee wallet can be changed', 'The creator payout address can be updated.', ['setCreatorFeeRecipient(address)']);
  if (!c.graduated && c.progress) {
    add('low', `Still on the bonding curve (${c.progress.pct}% to graduation)`, `${c.progress.raised.toFixed(3)} / ${c.progress.threshold} ETH raised. After graduation it moves to a Uniswap V4 pool with different fees.`);
  }
  return flags;
}

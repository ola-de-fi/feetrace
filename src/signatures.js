// Known fee-related function signatures. Selectors are computed at load time.
import { toFunctionSelector } from "viem";

// Zero-arg getters we read when present in bytecode.
const UINT_GETTERS = [
  "buyTax",
  "sellTax",
  "buyFee",
  "sellFee",
  "transferTax",
  "transferFee",
  "totalFees",
  "totalFee",
  "buyTotalFees",
  "sellTotalFees",
  "totalBuyFee",
  "totalSellFee",
  "taxFee",
  "liquidityFee",
  "marketingFee",
  "devFee",
  "teamFee",
  "burnFee",
  "reflectionFee",
  "buyMarketingFee",
  "sellMarketingFee",
  "buyLiquidityFee",
  "sellLiquidityFee",
  "buyDevFee",
  "sellDevFee",
  "buyBurnFee",
  "sellBurnFee",
  "_taxFee",
  "_liquidityFee",
  "_buyTax",
  "_sellTax",
  "_finalBuyTax",
  "_finalSellTax",
  "_initialBuyTax",
  "_initialSellTax",
  "_buyCount",
  "_reduceBuyTaxAt",
  "_reduceSellTaxAt",
  "feeDenominator",
  "FEE_DENOMINATOR",
  "swapTokensAtAmount",
  "swapThreshold",
  "_taxSwapThreshold",
  "maxTransactionAmount",
  "maxWallet",
  "_maxTxAmount",
  "_maxWalletSize",
];

const ADDRESS_GETTERS = [
  "owner",
  "getOwner",
  "marketingWallet",
  "marketingAddress",
  "marketingFeeReceiver",
  "_marketingWallet",
  "devWallet",
  "developmentWallet",
  "devAddress",
  "teamWallet",
  "operationsWallet",
  "taxWallet",
  "_taxWallet",
  "feeWallet",
  "feeReceiver",
  "feeRecipient",
  "feeCollector",
  "treasury",
  "treasuryWallet",
  "liquidityWallet",
  "buybackWallet",
  "charityWallet",
  "autoLiquidityReceiver",
  "creator",
  "deployer",
  "uniswapV2Pair",
  "pair",
  "lpPair",
  "uniswapV2Router",
  "router",
];

const BOOL_GETTERS = [
  "tradingOpen",
  "tradingActive",
  "tradingEnabled",
  "limitsInEffect",
  "swapEnabled",
];

const sig = (name) => ({
  name,
  signature: `${name}()`,
  selector: toFunctionSelector(`${name}()`),
});

export const GETTERS = [
  ...UINT_GETTERS.map((n) => ({ ...sig(n), type: "uint" })),
  ...ADDRESS_GETTERS.map((n) => ({ ...sig(n), type: "address" })),
  ...BOOL_GETTERS.map((n) => ({ ...sig(n), type: "bool" })),
];

// Owner-callable functions that change where fees go or how big they are.
// category drives the risk flags.
const CONTROL = {
  rate: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setFees(uint256,uint256,uint256)",
    "setFees(uint256,uint256,uint256,uint256)",
    "setTaxes(uint256,uint256)",
    "setTaxes(uint256,uint256,uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setBuyFees(uint256,uint256)",
    "setSellFees(uint256,uint256)",
    "setBuyFees(uint256,uint256,uint256)",
    "setSellFees(uint256,uint256,uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
    "updateBuyFees(uint256,uint256)",
    "updateSellFees(uint256,uint256)",
    "setTaxFeePercent(uint256)",
    "setLiquidityFeePercent(uint256)",
    "setTransferTax(uint256)",
    "reduceFee(uint256)",
    "setTax(uint256,uint256)",
    "setFeePercent(uint256)",
  ],
  wallet: [
    "setMarketingWallet(address)",
    "updateMarketingWallet(address)",
    "setTaxWallet(address)",
    "setFeeReceiver(address)",
    "setFeeWallet(address)",
    "setFeeRecipient(address)",
    "setTreasury(address)",
    "setTreasuryWallet(address)",
    "setDevWallet(address)",
    "updateDevWallet(address)",
    "setFeeReceivers(address,address)",
    "setFeeReceivers(address,address,address)",
    "setMarketingAddress(address)",
    "setWallets(address,address)",
    "updateTaxWallet(address)",
  ],
  exempt: [
    "excludeFromFees(address,bool)",
    "excludeFromFee(address)",
    "includeInFee(address)",
    "setFeeExempt(address,bool)",
    "setIsFeeExempt(address,bool)",
    "setExcludeFromFee(address,bool)",
    "excludeMultipleAccountsFromFees(address[],bool)",
  ],
  withdraw: [
    "manualSwap()",
    "manualsend()",
    "manualSend()",
    "withdrawStuckETH()",
    "withdrawStuckEth()",
    "clearStuckBalance(uint256)",
    "clearStuckEthBalance()",
    "rescueTokens(address,uint256)",
    "rescueETH()",
    "withdrawFees()",
    "claimFees()",
    "withdraw()",
    "emergencyWithdraw()",
    "recoverERC20(address,uint256)",
    "withdrawTokens(address)",
  ],
  blacklist: [
    "blacklist(address)",
    "blacklistAddress(address,bool)",
    "setBlacklist(address,bool)",
    "addBot(address)",
    "addBots(address[])",
    "setBots(address[],bool)",
    "blockBots(address[])",
    "isBot(address)",
    "isBlacklisted(address)",
  ],
  ownership: ["renounceOwnership()", "transferOwnership(address)"],
  limits: [
    "removeLimits()",
    "setMaxWallet(uint256)",
    "setMaxTxAmount(uint256)",
    "updateMaxTxnAmount(uint256)",
  ],
};

export const CONTROL_FUNCTIONS = Object.entries(CONTROL).flatMap(
  ([category, sigs]) =>
    sigs.map((s) => ({
      category,
      signature: s,
      selector: toFunctionSelector(s),
    })),
);

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const FEEISH =
  /fee|tax|wallet|treasury|marketing|swapback|stuck|rescue|bot|blacklist/i;

/** Look up unknown selectors in the public openchain signature database (best effort). */
export async function lookupSelectors(selectors) {
  if (!selectors.length) return {};
  const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selectors.join(",")}&filter=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    const out = {};
    for (const [sel, hits] of Object.entries(json?.result?.function || {})) {
      if (hits?.length) out[sel] = hits[0].name;
    }
    return out;
  } catch {
    return {};
  }
}

export const isFeeish = (name) => FEEISH.test(name);

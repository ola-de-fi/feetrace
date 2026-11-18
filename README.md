# FeeTrace

Live: https://feetrace.xyz

Where do a token's fees actually go? Paste a Robinhood Chain or Elysium token (the chain is detected from the address) and FeeTrace reverse engineers:

- **Launchpad mode (Uniswap V4):** finds the token's pool, reads the hook's on-chain fee policy and the per-pool launch record, and shows the swap fee, the creator/protocol split, the fee wallets (EOA / multisig / clone), unclaimed creator fees and the admin's powers.
- **Tax-token mode:** extracts selectors from bytecode (following proxies), reads fee getters, and replays recent Transfer logs to find addresses that repeatedly take a cut of trades, plus swapbacks.
- **Findings:** evidence-backed risk flags (upgradeable, fee can be raised, wallet can be redirected, blacklist, fees to personal wallets...).

## Run

```bash
npm install
npm start          # http://localhost:3000
npm run trace -- 0xTOKEN   # JSON report in the terminal
```

Env: `RPC_URL` (Robinhood Chain RPC), `ELYSIUM_RPC_URL`, `PORT`, `POOL_MANAGER`, `MAX_LOGS`.

API: `GET /api/trace?address=0x...` (cached 5 min). Add `&chain=robinhood` or `&chain=elysium` to skip detection.

## Elysium

Chains live in `src/chain.js`; Elysium's launch types are decoded in `src/hooks.js`, picked by the functions in the hook's bytecode:

- **Fee-rate hook** (most launches): dynamic swap fee, a fixed protocol cut, the rest to a per-pool creator wallet.
- **Tax hook** (Eleos): per-token buy and sell tax, split between the platform and the creator, with totals paid so far.
- **No hook**: plain V4 pool. Reports the pool fee, who owns the launch liquidity position, and whether that liquidity has been withdrawn.

Other hooks fall back to the generic bytecode and transfer analysis.

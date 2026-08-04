# Memecoin Sniper Bot (Solana)

Watches for newly launched Solana memecoins (via pump.fun), runs them through
safety filters, buys the ones that pass, and exits automatically on take-profit,
stop-loss, a trailing stop, or a max hold time. Includes a "watchlist" mode for
tokens named after notable people/events (e.g. a coin literally named "TRUMP"),
which get larger sizing and more room to run.

## Read this before doing anything else

Memecoin sniping is high-risk by nature: most new tokens rug, many are outright
honeypots (you can buy, you can't sell), and you're competing against bots with
far lower latency than this one. This bot has real safety filters, but **no
filter set catches everything.** Treat any capital you put into this — even
$5 — as capital you're fully prepared to lose. Start in paper mode and stay
there until you've watched it make decisions for a while and understand why.

**On the "big news" feature**: there is no free, reliable way to watch the live
Twitter/X firehose for "a notable person just launched a coin" in real time —
that requires a paid API tier. What this bot actually does is match new token
names/symbols against a keyword watchlist (`WATCHLIST_KEYWORDS` in `.env`).
That's a real, useful heuristic (it would have caught a token named "TRUMP" or
"MELANIA" at launch) but it is not surveillance of social media — don't rely on
it for anything beyond what it is.

## How it decides

1. **Discovery** - subscribes to pump.fun's public new-token feed (via
   PumpPortal) for every newly created token.
2. **Wait window** - ignores a token until it's at least `MIN_TOKEN_AGE_SEC`
   old (lets instant rugs reveal themselves) and gives up after
   `MAX_TOKEN_AGE_SEC` (momentum's likely gone by then).
3. **Safety filters** (`src/safety/filters.ts`) - all must pass:
   - Minimum liquidity in SOL
   - Mint authority renounced (dev can't mint unlimited new supply)
   - Freeze authority renounced (dev can't freeze your tokens)
   - Top holder concentration under a max %
4. **Honeypot check** (`src/safety/honeypot.ts`) - simulates a sell via
   Jupiter's quote API; rejects tokens with no sell route or extreme price
   impact.
5. **Watchlist check** - name/symbol matched against `WATCHLIST_KEYWORDS`.
   Matches get `WATCHLIST_POSITION_MULTIPLIER`x position size and a longer
   max hold time.
6. **Buy** - sized from `POSITION_SIZE_SOL`, capped by available balance and
   `MAX_CONCURRENT_POSITIONS`.
7. **Exit** (`src/trading/position.ts`) - closes on whichever hits first:
   take-profit %, stop-loss %, trailing stop % (drop from peak), or max hold
   time.

## Setup

```bash
npm install
npm run generate-wallet   # prints a new address + private key, once
cp .env.example .env
```

Edit `.env`:
- Leave `TRADING_MODE=paper` for now.
- Set `WATCHLIST_KEYWORDS` to whatever names/events you want to catch.
- Adjust `POSITION_SIZE_SOL`, `TAKE_PROFIT_PCT`, `STOP_LOSS_PCT` etc. to taste.
- `SOLANA_PRIVATE_KEY` can stay empty in paper mode.

Run it locally:

```bash
npm run dev
```

Watch the logs. Everything is simulated — no real funds move, but prices,
liquidity, and safety checks are all real market data.

## Going live (only once you're comfortable with paper results)

1. Run `npm run generate-wallet` again for a real wallet (don't reuse a key
   that's ever been printed somewhere you don't fully control — e.g. don't
   reuse the one from any shared/AI chat log).
2. Send $5-10 worth of SOL to the printed address.
3. On Railway, set environment variables (never commit these):
   - `TRADING_MODE=live`
   - `I_UNDERSTAND_THE_RISK=true`
   - `SOLANA_PRIVATE_KEY=<your key>`
   - `SOLANA_RPC_URL=<a real RPC endpoint>` — the public
     `api.mainnet-beta.solana.com` endpoint is heavily rate-limited; a free
     tier from Helius or QuickNode will be far more reliable for a bot that's
     polling every few seconds.
4. Deploy. Railway's Nixpacks auto-detects this as a Node app — `npm run build`
   then `npm start`. No Dockerfile needed.
5. Watch it closely for the first few hours. Kill it (`I_UNDERSTAND_THE_RISK=false`
   or stop the service) if anything looks off.

## Tuning notes

- `MIN_LIQUIDITY_SOL` / `MAX_TOP_HOLDER_PCT` are your main rug filters —
  tightening them means fewer trades but fewer disasters.
- `MAX_SELL_PRICE_IMPACT_PCT` is your honeypot filter — lower is stricter.
- With a $5-10 bankroll, keep `POSITION_SIZE_SOL` small enough to support
  `MAX_CONCURRENT_POSITIONS` trades at once, or you'll skip signals while
  waiting on capital.
- All trades (paper and live) are logged to `data/store.json` for review.

## What this is not

- Not a guaranteed-profit system. Most memecoins lose money for most buyers,
  including ones that pass every filter here.
- Not audited for MEV/front-running resistance — a well-resourced bot can
  still beat this one to a trade.
- Not investment advice.

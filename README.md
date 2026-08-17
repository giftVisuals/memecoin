# G4 Scraper (Solana memecoin bot)

Watches for newly launched Solana memecoins (via pump.fun), runs them through
safety filters, and by default sends a Telegram alert for the ones that pass
instead of trading anything — you decide manually whether to buy. It can
still auto-trade (paper or live) if you want that instead; see "Modes" below.

## Modes

- **`signal` (default, recommended)** - no wallet, no funds at risk. Watches
  pump.fun, scores every new token, and sends a Telegram message for the ones
  that clear the bar - contract address in a tap-to-copy code block, plus
  liquidity, market cap, holder count/concentration, mint/freeze authority
  status, a sellability check, a risk score, and a match confidence %. You
  (or whoever's fastest) decide manually whether to actually buy.
- **`paper`** - simulates buying/selling with fake money, for testing the
  strategy end to end without risking anything.
- **`live`** - the same auto-trading logic, but with a real wallet and real
  funds. Requires `TRADING_MODE=live` and `I_UNDERSTAND_THE_RISK=true`.

### Setting up signal mode

1. Get a Telegram bot token from [@BotFather](https://t.me/BotFather), or
   reuse an existing bot's token.
2. Open a chat with your bot and send it any message - a bot can't message
   you until you've messaged it first.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   and find `"chat":{"id": ...}` in the response - that's your chat ID.
4. In Railway, set `TRADING_MODE=signal`, `TELEGRAM_BOT_TOKEN`, and
   `TELEGRAM_CHAT_ID`.

That's it - no wallet, no `WALLET_ENCRYPTION_KEY`, no funds needed. The
dashboard's Wallets/Trading tabs don't apply in this mode (nothing trades),
though the Settings tab still controls the safety thresholds used to decide
what's worth alerting on.

### Buy Now / Sell Now buttons (optional - this one does move real funds)

Every Telegram alert has a 🟢 **Buy Now** button. Tapping it executes a real
swap using the `SOLANA_PRIVATE_KEY` wallet (the same one paper/live mode
uses) sized by the Settings tab's Position Size - so set that to something
small and confirm the wallet is funded before tapping anything. Once bought,
the message turns into a live position card that updates its % PnL every
~20 seconds and grows a 🔴 **Sell Now** button, which closes the position with
a real swap back to SOL when tapped. Nothing sells automatically here - you
decide the exit, same as you decided the entry.

This is the one part of signal mode that isn't free of risk by design - the
alerts themselves cost nothing and risk nothing, but the buttons do exactly
what a manual trade in Phantom would do. If `SOLANA_PRIVATE_KEY` isn't set,
tapping Buy Now just shows an error instead of doing anything.

### Smart wallet watching (optional, free)

Watches specific wallets and alerts when they buy something. No separate
wallet, no API key, no setup cost - it runs on the same Helius RPC
connection (`SOLANA_RPC_URL`) as everything else in the bot, using
standard Solana log subscriptions rather than a paid indexing service.

In the dashboard's Settings tab, add wallet addresses to the "Smart
Wallets" field as `label:address` pairs (one per line). The bot doesn't
discover these on its own - you add ones you already trust, e.g. copied
from a "top traders" leaderboard on a site like Birdeye or GMGN. Watching
starts automatically as soon as the list has at least one address in it.

One trade-off worth knowing: because this reads raw transactions instead of
a pre-built "buy" feed, it catches a tracked wallet's buys on any exchange
(Jupiter, Raydium, pump.fun, etc.), not just pump.fun specifically - broader
coverage, but very occasionally it can miss or misread an unusual
transaction shape. Nothing to configure differently either way.

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
names/symbols against a keyword watchlist (editable from the dashboard).
That's a real, useful heuristic (it would have caught a token named "TRUMP" or
"MELANIA" at launch) but it is not surveillance of social media, and it can be
gamed — copycat/troll tokens riding on a name show up too (we've seen this live:
multiple unrelated "Epstein" tokens deployed by randoms). That's exactly why
watchlist status only changes position size and hold time — it never skips the
safety filters below.

## How it decides (paper/live trading modes)

In signal mode, steps 1-5 below are the same (discovery, wait window, safety
filters, honeypot check, watchlist check feed into the risk score/confidence
in the Telegram alert) - steps 6-7 (buy/exit) just don't happen.

1. **Discovery** - subscribes to pump.fun's public new-token feed (via
   PumpPortal) for every newly created token.
2. **Wait window** - ignores a token until it's at least `MIN_TOKEN_AGE_SEC`
   old (lets instant rugs reveal themselves) and gives up after
   `MAX_TOKEN_AGE_SEC` (momentum's likely gone by then).
3. **Safety filters** (`safety/filters.js`) - all must pass:
   - Minimum liquidity in SOL
   - Mint authority renounced (dev can't mint unlimited new supply)
   - Freeze authority renounced (dev can't freeze your tokens)
   - Top holder concentration under a max %
4. **Honeypot check** (`safety/honeypot.js`) - simulates a sell via
   Jupiter's quote API; rejects tokens with no sell route or extreme price
   impact.
5. **Watchlist check** - name/symbol matched against the watchlist keywords.
   Matches get a bigger position size and a longer max hold time.
6. **Buy** - sized from the position size setting, capped by available
   balance and the max concurrent positions limit.
7. **Exit** (`trading/position.js`) - closes on whichever hits first:
   take-profit %, stop-loss %, trailing stop % (drop from peak), or max hold
   time.

## Dashboard

Every deploy serves a small web dashboard ("G4 Scraper") at the service's
Railway URL, password-protected with HTTP basic auth:

- **Overview** - combined totals across every wallet: net PnL, total earned,
  total lost, memecoins traded, win rate, combined balance, and every
  currently open position (tagged with which wallet holds it) with live PnL %.
- **Wallets** - the primary wallet (from `SOLANA_PRIVATE_KEY`) plus any
  additional wallets added from the dashboard. See "Multiple wallets" below.
- **Settings** - watchlist keywords, position sizing, every safety filter,
  and every exit rule — shared across all wallets. Changes save to
  `data/settings.json` and apply to the bot's very next decision — no
  redeploy needed.
- **History** - every trade any wallet has made, paper or live.

Login username is fixed as `g4`; the password comes from `DASHBOARD_PASSWORD`.
If you don't set it, the bot generates a random one at boot and prints it once
to the logs — set it explicitly in Railway so it's stable across restarts.

## Multiple wallets

The bot supports more than one wallet trading at once - e.g. one per family
member. All wallets share the same strategy (one watchlist, one set of
filters, one set of exit rules), but each has its own funds, its own PnL,
and its own pause switch. When a token passes every filter, the bot buys it
independently in every wallet that isn't paused - each wallet risks only its
own balance, and one wallet's trade never affects another's.

**Setup (one-time):** set `WALLET_ENCRYPTION_KEY` in Railway to any long
random string. This encrypts every added wallet's private key before it's
written to disk or backed up to the cloud - without it, "Add Wallet" just
shows an error telling you to set it.

**Adding a wallet:** Wallets tab → Family Wallets → **+ Add Wallet** → give
it a name. The private key is shown exactly once - copy it somewhere safe as
your own personal backup, same as the primary wallet's flow - but unlike the
primary wallet, this one doesn't need to go anywhere else. It's already
saved (encrypted) so the bot can trade with it. New wallets start **paused**
on purpose - switch them on from the same list once you're ready.

**Funding:** send SOL to the address shown on that wallet's card, same as
funding the primary wallet.

**Removing a wallet:** Remove button on its card. Blocked while it has an
open position, so funds/positions are never orphaned mid-trade.

Keep `WALLET_ENCRYPTION_KEY` stable once you've added wallets with it -
changing it makes previously-added wallets undecryptable by the bot (you'd
still have each one's own key from its one-time reveal to import elsewhere
if that ever happens).

## Project layout

Plain Node.js, ESM `import`/`export`, no build step — run any file directly
with `node`.

```
server.js          entry point, boots the engine + dashboard
generateWallet.js   run once to create a wallet: node generateWallet.js
config.js           reads .env - restart-required settings only (mode, wallet, port)
settings.js         dashboard-editable settings, persisted to data/settings.json
constants.js        shared constants (SOL mint address, lamports/SOL)
wallet.js           loads the primary signing keypair from SOLANA_PRIVATE_KEY
solanaConnection.js shared RPC connection + mint-account reader
sources/            pump.fun feed, DexScreener client, watchlist matcher
safety/             liquidity/holder/authority filters, honeypot check
trading/            position (TP/SL/trailing), paper/live brokers, multi-account engine
persistence/        JSON trade + PnL stats log (store.json), encrypted wallet
                     store (wallets.json), optional cloud backup
notify/             console logger
web/                dashboard API server + basic auth
public/             dashboard frontend (plain HTML/CSS/JS, no framework)
```

## Setup

```bash
npm install
npm run generate-wallet   # prints a new address + private key, once
cp .env.example .env
```

Edit `.env`:
- Leave `TRADING_MODE=paper` for now.
- Set `DASHBOARD_PASSWORD` to something only you/your family know.
- `SOLANA_PRIVATE_KEY` can stay empty in paper mode.
- Everything else (watchlist, position size, TP/SL, filters) can stay on
  defaults — you'll tune those from the dashboard, not `.env`.

Run it locally:

```bash
npm run dev
```

Then open `http://localhost:3000` and log in with username `g4` and your
`DASHBOARD_PASSWORD`. Everything is simulated in paper mode — no real funds
move, but prices, liquidity, and safety checks are all real market data.

## Persistent storage on Railway

Railway's filesystem resets on every redeploy by default. Without something
in place, that means your trade history, dashboard settings, and any added
family wallets get wiped every time new code ships. Two ways to fix it —
pick one:

**Option A: Cloud backup (recommended if you don't have a laptop handy)**

No Railway UI fiddling, works entirely from a phone browser:

1. Sign up free at [upstash.com](https://upstash.com), create a Redis
   database (any region).
2. On the database's page, copy the **REST URL** and **REST TOKEN**.
3. In Railway → Variables, set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` to those two values.
4. Redeploy. Logs should show `Cloud backup enabled` on boot. From then on,
   every trade and every settings change is backed up automatically, and
   restored automatically the next time the app boots fresh.

**Option B: Railway Volume**

1. In your Railway project's canvas view, add a **Volume** (via "+ New" →
   Volume) and attach it to this service.
2. Set its mount path to `/data`.
3. In Variables, set `DATA_DIR=/data`.
4. Redeploy. This is Railway's own disk, so it's persistent with no external
   account needed — but attaching a Volume involves dragging connections on
   the project canvas, which is awkward on mobile and easiest from a
   desktop browser.

Either one is enough — you don't need both. Do this before you care about
the numbers on the Overview tab being permanent, especially once real funds
are involved.

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
   - `DASHBOARD_PASSWORD=<something real>` if you haven't already.
4. Deploy. Railway's Nixpacks auto-detects this as a plain Node app and runs
   `npm start` (`node server.js`) — no build step, no Dockerfile needed.
5. Watch it closely for the first few hours. Kill it (`I_UNDERSTAND_THE_RISK=false`
   or stop the service) if anything looks off.

## Tuning notes

All of these are in the dashboard's Settings tab:

- **Min liquidity / max top holder %** are your main rug filters — tightening
  them means fewer trades but fewer disasters.
- **Max sell price impact %** is your honeypot filter — lower is stricter.
- With a $5-10 bankroll, keep **position size** small enough to support **max
  concurrent positions** trades at once, or you'll skip signals while waiting
  on capital.
- All trades (paper and live) are logged to `data/store.json`, and rolled up
  into the dashboard's PnL stats.

## What this is not

- Not a guaranteed-profit system. Most memecoins lose money for most buyers,
  including ones that pass every filter here.
- Not audited for MEV/front-running resistance — a well-resourced bot can
  still beat this one to a trade.
- Not investment advice.

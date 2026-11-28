# Kalshi Feed: shared playbook for every sports project

This is the one shared source for every sports project (NFL, NCAA basketball, NCAA football, NBA, MLB later). It covers what they all have in common: how to read the Kalshi feed, what the data means, and how to log, grade and learn from it. Sport-specific rules (picks, flags, strategy logs) stay in each project. If a project's instructions conflict with this file about the feed or the data, this file wins.

## 1. Getting the data
- Public repo: https://github.com/jdeezy555/kalshi-feed. First time: `git clone --depth 1`. Already cloned: `git fetch && git reset --hard origin/main`. The repo is force-pushed as a single snapshot, so `git pull` fails and `git log` has no past states.
- Read `data/status.json` first:
  - `updated_at` under 30 min old: use it.
  - Older: say the feed looks stale (the NucBox may be off or PM2 stopped), then ask for screenshots.
  - A series showing `ERROR`: wrong ticker, say so.
  - A series showing 0: no open markets right now, which is normal. A series showing 0 markets is not a reason to remove it. Player props only open on game days, so off days, holidays and the All-Star break show 0. Only remove a series if it shows ERROR, or if the user asks.
- Live prices: `data/latest.csv`, or `data/latest/<SERIES>.json` for one series. Updated every 5 min, pushed every 15 min.
- Price history: `data/history/YYYY-MM-DD.csv` (today) and `.csv.gz` (past days), kept 21 days. Columns: time, ticker, yes_bid, yes_ask, no_ask, last, volume. A row is written whenever a price changes, plus a full baseline of every market every 30 min.
- Permanent archive: `data/archive/<sport>-markets-<season>.csv`, never pruned. One row per market, written once it closes and Kalshi reports an outcome (or after 7 days of no outcome). sport = nfl / ncaamb / ncaaf / nba / mlb. season = the fall start year for nfl and ncaaf ("2026"), "2026-27" for nba and ncaamb, the calendar year for mlb. `first_seen_is_tracking_start` = Y means the market was already open when tracking began (2026-11-27 03:29Z), so its first price isn't its opening price. **Grade from `result` (Kalshi's official settlement: `yes`, `no`, or `unsettled` if it never got one within 7 days of closing) and `settled_at` (when Kalshi settled it) — not from `last_last`**, which is just the last traded price before close and can lag or never reflect the true outcome.

## 2. Reading prices and markets
- Prices are cents (0–100) and work as rough probabilities: 52 ≈ 52%.
- To buy a side, use the ask (`yes_ask` / `no_ask`), never `last`. The bid is what you'd get selling.
- `yes_mult` / `no_mult` ≈ the app's payout multiplier (100 ÷ price, before fees).
- Titles name only one side. Group rows by `event_ticker` to see a whole game. `yes_label` says what Yes means.
- Spreads and totals are ladders ("X wins by over 6.5", "Over 41.5"). The main line is the rung whose price is closest to 50¢. Player props are ladders too ("Player: 70+"). "No · 70+" means under 70.
- Combo/parlay prices aren't in the feed. Estimate by multiplying the legs' multipliers, then confirm in the app.
- Prices can be up to ~15 min old, so always say to re-check the live price before entering.

## 3. Shared data method (every sport)
- Shadow log: log every game on the slate, not just the ones played. For each leg record: entry price (the ask when logged), the pick and its reason, rule tags (which rule would include or exclude it), whether it was played, the closing price (last history row before start), CLV (close minus entry; positive = the market moved our way), the result, and P&L at 1 unit flat at the entry price.
- Grade within 21 days of the game, before its history is pruned. Durable results live in the project's own log, not in this repo.
- Judge rules by sample size. Treat any bucket under ~30 legs as noise. Positive CLV over many legs is the earliest real sign of edge.
- Cash-out research: on Kalshi, cashing out = selling your position at the current bid. A ticket's fair value at any moment ≈ the product of its legs' live probabilities × payout. To study cash-outs, log fair value through the game, any sell price the user saw, and the final result. Don't tell the user to hold or cash out on a live ticket unless that project's own rules say otherwise.

## 4. Rules
- The feed is read-only market data. Never place trades, suggest automating them, or simulate trading through it.
- Never commit or push to this repo from a chat session. The NucBox overwrites the repo on every push, so all changes go through Claude Code on the NucBox.
- If markets you need aren't in the feed, give the user the `node kalshi-feed.js --discover <keyword>` command and the tickers to add to `config.json` (`series`, and `historySeries` if history is wanted).
- Keep storage bounded: history is pruned at 21 days, the repo is one commit, and only the per-sport archive grows (small, permanent).

## 5. Series currently tracked
(update this list when config.json changes)
- `KXNCAAMBGAME`, `KXNCAAMBSPREAD`, `KXNCAAMBTOTAL`: men's college basketball winner / spread / total
- `KXNFLGAME`, `KXNFLSPREAD`, `KXNFLTOTAL`: NFL winner / spread / total
- `KXNFLPASSYDS`, `KXNFLRSHYDS`, `KXNFLRECYDS`, `KXNFLREC`: NFL passing yards / rushing yards / receiving yards / receptions (player props)
- `KXNBAGAME`, `KXNBASPREAD`, `KXNBATOTAL`: NBA winner / spread / total
- `KXNBAPTS`, `KXNBAREB`, `KXNBAAST`, `KXNBA3PT`: NBA player points / rebounds / assists / threes (player props)
- `KXNCAAFGAME`, `KXNCAAFSPREAD`, `KXNCAAFTOTAL`: college football winner / spread / total
- MLB: none yet. In spring run `--discover mlb` and add the game, run line and total series.

**Dropped 2026-11-26** (0 markets for 24h+, removed from `config.json`): `KXNFLANYTD`. `KXNFLANYTD` is the correct ticker for NFL anytime-TD props — it just has no open markets right now; re-add it to `series` (and `historySeries` if you want it in history) once it starts returning markets again.

History and archive are written for every series in `historySeries` — currently all the series above.

## 6. Changelog
- 2026-11-26: Feed live. Force-pushed single-commit repo, 21-day gzipped history, change-only rows, permanent per-sport archive with season labels. This file became the shared playbook for all sports projects.

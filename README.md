# kalshi-feed

Claude/AI projects: read CLAUDE-INSTRUCTIONS.md, the shared playbook for every sports project.

Pulls **public Kalshi prices** every few minutes on the NucBox, saves them to `data/`, and pushes them to the **public GitHub repo [jdeezy555/kalshi-feed](https://github.com/jdeezy555/kalshi-feed)** so Claude can read live prices from any chat (phone included). No Kalshi login or API key; it only reads public market data and can't trade.

**The repo is a single force-pushed snapshot, not a history.** Every push replaces the one existing commit instead of stacking a new one on top (orphan branch + `git push --force` + `git gc`), so `.git` stays small forever instead of growing without bound. If you need the repo's commit history for anything, it isn't there on purpose — use `data/history/` for that.

## What it writes

| File | What's in it |
|---|---|
| `data/latest.csv` | Every open market in your series: who/what, Yes and No buy prices (cents), payout multipliers, volume, close time. This is the file Claude reads first. |
| `data/latest.json` | The same data as JSON |
| `data/latest/<SERIES>.json` | One file per series |
| `data/status.json` | When it last updated, plus a market count (or error) per series |
| `data/history/YYYY-MM-DD.csv` | Change-only price history for every series in `config.json` → `historySeries` (NFL, NCAA basketball, NCAA football, NBA): a row is written for a market only when `yes_bid`, `yes_ask`, or `last` changes since its last written row, plus one full baseline row for every tracked market every `historyEveryMinutes`. Kept 21 days; every day except today is gzipped to `data/history/YYYY-MM-DD.csv.gz`. |
| `data/archive/<sport>-markets-<season>.csv` | Permanent, never-pruned one-row-per-market summary (`ticker`, `event_ticker`, `yes_label`, first/last seen times and prices, min/max `yes_bid`, rows recorded), written once a market in `historySeries` drops off the open-markets list. `sport` is the series prefix (`nfl`, `ncaamb`, `ncaaf`, `nba`, `mlb`); `season` is the calendar year the market was first seen. |
| `data/archive/state.json` | In-progress tracking state for the archive (per open market) — survives restarts, not meant to be read directly. |

Prices are in cents (0–100). `yes_ask` is what it costs to buy Yes. `yes_mult` ≈ the multiplier the Kalshi app shows (100 ÷ price, before fees).

## Setup (about 15 minutes)

You need Node 18+ (`node -v`), git, and PM2. You already have PM2 for KasPay.

**1. Create the GitHub repo.** On github.com: New repository, name it `kalshi-feed`, set it to **Public**, and check "Add a README".

**2. Clone it on the NucBox and copy these files in.**
```bash
git clone https://github.com/jdeezy555/kalshi-feed.git
cd kalshi-feed
# copy kalshi-feed.js, config.json, ecosystem.config.js, .gitignore, README.md into this folder
```

**3. Find the right series tickers.** Kalshi names each group of markets with a "series ticker". Run:
```bash
node kalshi-feed.js --discover basketball
```
Look for the men's college basketball game-winner, spread and total series. Put those tickers in `config.json` → `"series"`. The tickers in there now are my best guess, so confirm them.

**4. Test one snapshot.**
```bash
node kalshi-feed.js --once
cat data/status.json      # each series should show a number, not ERROR
head data/latest.csv
```

**5. Make sure git can push without asking for a password.**
```bash
git add -A && git commit -m "kalshi-feed setup" && git push
```
If it asks for credentials, the easiest fix is the GitHub CLI: `gh auth login`, then push again.

**6. Run it 24/7 with PM2.**
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs kalshi-feed      # should print "snapshot: N markets" every 5 min
```

**7. Tell Claude the repo name** (`jdeezy555/kalshi-feed`). From then on, any chat can pull it.

## Settings (`config.json`)

| Setting | Default | Meaning |
|---|---|---|
| `series` | CBB game/spread/total | Which Kalshi series to track. Add more for other projects. |
| `historySeries` | NFL, NCAA basketball, NCAA football, NBA (game/spread/total/props) | Which of the tracked series get written to `data/history/` and `data/archive/`. |
| `intervalMinutes` | 5 | How often to fetch prices, and how often a changed price can get a history row |
| `historyEveryMinutes` | 30 | How often every tracked market gets a full baseline row in history, regardless of whether it changed |
| `historyKeepDays` | 21 | Delete history older than this (days beyond today are gzipped, not deleted, until they pass this) |
| `git.pushEveryMinutes` | 15 | How often to push to GitHub, so Claude's view is at most about 15 min old |
| `git.enabled` | true | Set to false to keep everything local only |

After changing config: `pm2 restart kalshi-feed`.

## Adding markets for another project

1. `node kalshi-feed.js --discover <keyword>` (e.g. `nba`, `nfl`, `bitcoin`, `fed`)
2. Add the tickers to `"series"` in `config.json`
3. `pm2 restart kalshi-feed`
4. Paste `CLAUDE-INSTRUCTIONS.md` into that project's instructions (the series list at the bottom tells Claude what's tracked)

## Troubleshooting

- **`status.json` shows ERROR for a series**: wrong ticker. Re-run `--discover`.
- **0 markets**: no open markets in that series right now (e.g. no games today). That's normal.
- **"git push failed" in the logs**: credentials. Run `gh auth login` on the NucBox.
- **Repo getting big**: shouldn't happen now (single squashed commit each push) — if `.git` is large, something's stuck mid-push; check `git log --oneline | wc -l` is 1 and `git count-objects -vH`.
- **History getting big**: lower `historyKeepDays`, shrink `historySeries`, or raise `historyEveryMinutes` (history is change-only already, so this mainly affects the baseline rows).
- **Archive getting big**: it's never pruned by design — that's the point. If a sport's archive file is too big, drop it from `historySeries` (new markets stop being tracked/archived; past archive rows stay).

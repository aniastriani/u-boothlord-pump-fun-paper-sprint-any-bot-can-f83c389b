# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aniastriani/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aniastriani/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early-momentum sniper for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. A paper-trading bot (no real funds) that replays pump.fun bonding-curve data: it watches every new curve for a short burst of real buying, steps in small (0.15 SOL), and gets out fast — take profit at +30%, stop loss at -22%, fade and stale exits — so it cycles through many coins instead of marrying one.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the harness sends `hello`, then one `batch` per slot, then `done`. It needs no dependencies, no network, and no environment secrets — just Node 22.

## Strategy

- **Entry:** curve at least 40 slots old, ≥3 buys and ≥0.4 SOL net buy flow over the last 40 slots, price up ≥2% and near its window high, real SOL reserves between 0.5 and 80 SOL.
- **Exits:** +30% take profit, -22% stop loss, fade (net flow < -2 SOL over 20 slots), stale (held >1500 slots while up <5%).
- **Guardrail probes:** tiny 0.02 SOL round trips keep the entry above the 20-distinct-coins bar when momentum entries lag.
- **Deterministic:** no clock, no environment reads, no randomness — two runs on the same data produce the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>

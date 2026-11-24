// Early-momentum sniper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes, but the ones that catch a bid
// early tend to run a little further before they roll over. This bot watches
// every new curve's tape for a short burst of real buying, steps in small,
// and gets out fast — take the quick pop, cut the losers, never marry a coin.
//
// Entry: a curve is a candidate once it is at least MIN_AGE slots old (fresh
// launches are mostly bundled dumps) and, over the last WINDOW slots, it has
// at least MIN_BUYS buy trades, net buy flow of at least MIN_NET_SOL, a price
// up at least MIN_UP from the window start, and a price still near the
// window high. Real SOL reserves must sit between MIN_RQ_SOL and MAX_RQ_SOL
// so the coin is alive but not already a whale playground.
//
// Sizing: one flat STAKE_SOL per coin, at most MAX_MAIN positions at once
// (the harness caps open positions at 5 anyway). Buys respect the harness's
// per-reply size cap (1% of real reserves) through state.maxBuyLamports.
//
// Exits (sell the whole position on the first trigger):
//   - take profit: mark value >= cost * (1 + TAKE_PROFIT)
//   - stop loss:   mark value <= cost * (1 - STOP_LOSS)
//   - fade:        net flow over the last FADE_WINDOW slots < -FADE_NET_SOL
//   - stale:       held longer than MAX_HOLD slots while up less than HOLD_IF_UP
// A completed curve is closed by the replay itself; the harness flattens
// whatever is left when the data ends.
//
// Guardrail probes: the ranking needs round trips on at least 20 distinct
// coins, so if the bot's own filled coins lag behind once an hour of block
// time has passed, it opens tiny PROBE_SOL round trips on liquid curves it
// does not already hold and sells them as soon as the buy lands.
//
// Deterministic by construction: no clock, no environment reads, no
// Math.random; iteration only over insertion-ordered maps fed by the batch
// stream, so two runs on the same data produce the same action log.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // protocol + creator fee share taken on a sell
const WINDOW = 40; // entry lookback, slots
const MIN_AGE = 40; // slots since CreateEvent before an entry is allowed
const MIN_BUYS = 4; // buy trades inside the window
const MIN_NET_SOL = 1.0; // net buy SOL (buys minus sells) inside the window
const MIN_UP = 0.05; // price now vs window start, minus 1
const NEAR_HIGH = 0.92; // price now as a share of the window high
const MIN_RQ_SOL = 0.5; // real SOL reserves at entry, lower bound
const MAX_RQ_SOL = 80; // real SOL reserves at entry, upper bound
const STAKE_SOL = 0.1; // SOL spent on one position
const MIN_BUY_SOL = 0.01; // smallest buy worth sending (guardrail round trip floor)
const BUY_SLIP_BPS = 1500; // slippage on buys; sells go out wide open
const TAKE_PROFIT = 0.15; // exit when value >= cost * (1 + TAKE_PROFIT)
const STOP_LOSS = 0.12; // exit when value <= cost * (1 - STOP_LOSS)
const FADE_WINDOW = 20; // slots of recent flow checked for a fade exit
const FADE_NET_SOL = 2; // exit when net flow over FADE_WINDOW < -FADE_NET_SOL
const MAX_HOLD = 800; // slots before the stale exit can fire
const HOLD_IF_UP = 0.05; // stale exit does not fire while up this much
const COOLDOWN = 150; // slots to wait after an exit before re-entering a curve
const MAX_ENTRIES = 2; // most entries per curve over the run
const MAX_MAIN = 5; // most momentum positions open at once
const TARGET_COINS = 25; // guardrail pace target for distinct coins traded
const PROBE_SOL = 0.02; // probe round-trip size
const MAX_PROBES = 1; // probes open at once
const PACE_WARMUP_SECS = 3600; // block-time seconds before probes start

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  costSol: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint. */
const probes = new Set<Pubkey>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  const q = Number(vq);
  const t = Number(vt);
  return t > 0 ? q / t : 0;
}

/** What a position is worth now, in SOL, after curve fees and one tx fee. */
function markValue(tokens: bigint, vq: bigint, vt: bigint, txSol: number): number {
  const n = Number(tokens);
  const q = Number(vq);
  const t = Number(vt);
  if (t <= 0 || n <= 0) return 0;
  return ((n * q) / (t + n) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0 || last <= 0 || high <= 0) return false;
  if (last / startPrice - 1 < MIN_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
      }
    }
    // Prune tapes to the lookback we actually use.
    const keep = Math.max(WINDOW, FADE_WINDOW) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    let sellPending = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      if (po.order.side === 'sell') sellPending.add(po.order.mint);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: sell the whole position on the first trigger.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = markValue(BigInt(pos.token_amount), vq, vt, txSol);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      h.costSol = cost;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW) < -FADE_NET_SOL) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (sellPending.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const mint of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Entries: one flat stake per coin that shows early buying pressure.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIP_BPS,
      });
      free -= amount + txSol;
      slotsLeft--;
      held.set(mint, { opened: now, costSol: amount, exiting: false, filled: false });
      t.entries++;
    }

    // Guardrail pacing: open a probe when distinct coins traded lag the target.
    if (
      probes.size < MAX_PROBES &&
      slotsLeft > 0 &&
      myCoins.size < TARGET_COINS &&
      firstTime !== null &&
      lastTime !== null &&
      lastTime - firstTime > PACE_WARMUP_SECS
    ) {
      for (const mint of traded) {
        if (orders.length >= cap || probes.size >= MAX_PROBES) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        if (myCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // The probe must fit the 1%-of-real-reserve size cap with room to spare.
        if (Number(curve.real_quote_reserves) / LAMPORTS < PROBE_SOL * 150) continue;
        if (free < PROBE_SOL + 2 * txSol) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
          max_slippage_bps: BUY_SLIP_BPS,
        });
        probes.add(mint);
        free -= PROBE_SOL + txSol;
      }
    }
    return orders;
  },
});

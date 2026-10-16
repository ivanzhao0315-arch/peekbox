# 瞄一箱 · PeekBox

TapeOut ecosystem, X Layer, **native OKB** (user's call, 2026-10-16; was USDT): **swipe up to open the box, watch an ad, maybe win.** Advertisers put money in; 95% goes straight into a public on-chain prize pool and 5% is the platform fee. Ads stay forever and get views in proportion to the money put into them. **No server**: the page sits on DeWEB; the counting, the draw and the payouts all happen in one contract. The folder and the contract are still called meow-box / MeowBox. Design canvas: https://claude.ai/artifact/H5ZPwTgfBskMCvzaBW9gva (`Noir.dc.html` is the direction in use; the other boards are earlier rounds).

Built for the **X Layer TapeOut Accelerate** program (OKX × TapeOut, 100K USDT; submit before **2026-12-07 23:59 UTC**). Form: https://forms.gle/EoDNbxQ65dev1wFd9 (needs a GitHub repo and a demo video ≤3 min). Draft answers: `hackathon/submission.md` (written for the earlier CPS model; update before submitting).

## Rules (user decisions of 2026-10-16, all enforced by the contract)

- **Advertisers** `publish(title, body, link, video)` sending at least `minDeposit` (0.001 OKB) as the call's value, no approve step: **5% to `fees`, 95% straight into `pool`**. No CPS, no number of openings, **no refunds**. An ad is **permanent**: nobody can take it down or hide it, the owner included (user's call). Anyone can `deposit(id)` more OKB into any ad. `video` is an optional https file (mp4); without it the page shows a text card. No images.
- **Views follow the money**: each opening shows one ad picked with weight = its `spent`, via a Fenwick tree (O(log n), so opening stays cheap as ads pile up). A wallet is never shown the same ad twice in a UTC day: up to `TRIES` = 8 weighted picks skip seen ones, then `SeenAll` (can give up while one unseen ad is left; the page says try again).
- **No daily cap**; at least `gap` = 8 s between a wallet's openings (the time an ad plays).
- **Prize tiers**, one draw per box from the next block's hash, `keccak256(hash, contract, wallet, target) % 1e6`, rarest first: jackpot = `jackpotBps` 20% of the pool at 1/1,000,000; 0.1 OKB at 1/200,000; 0.01 OKB at 1/20,000; 0.001 OKB at 1/1,000. A tier the pool cannot pay counts as empty (money stays in the pool).
- **Why these odds (the anti-farming design; no identity check, user's call)**: a box costs the opener about 174k gas ≈ 0.0000035 OKB at X Layer's 0.02 gwei; its average prize is 0.000002 OKB plus 20% of the pool / 1e6. Prizes and gas are both OKB, so the coin's price does not move the balance, only the gas price does (`test_averagePrizeUnderTheGasOfABox`). Scripting boxes loses money on average; people play for the chance of a big prize. Implied: 1 OKB of ad money ≈ 475,000 views.
- **Session keys** (no wallet pop-up per swipe, user-paid gas, no relayer): the wallet calls `authorize(key, until, v, r, s)` once, sending 0.001 OKB that the contract forwards to the key; the key must sign `keyMessage(wallet)` (so nobody can register someone else's wallet as their key); a key belongs to its first wallet for good; it opens and claims for the wallet (`_user()`): boxes, seen-days and prizes all stay under the wallet. The page keeps the key in localStorage (`peekbox-key:<contract>:<wallet>`), 24 h, tops it up when under 0.00003 OKB.
- **Settling**: a box is paid by the wallet's next `open` or `claim` (blockhash 256 blocks, then EIP-2935 8191 ≈ 2.3 h on X Layer); after that it is empty. `pending(user)` gives the page the tier and amount before claiming.
- **Counts**: `views` at opening; `clicks` with the opener's next transaction (`open(clicked)` / `claim(clicked)`), once, latest box only.
- **Owner** only receives the 5% (`collect()`, callable by anyone) and can `fund()` the pool like anyone. No other power. Payouts are plain value calls behind a reentrancy lock (`locked`); the fork test pays the fee to the real owner wallet (an EIP-7702 account) to prove it accepts OKB.
- **Randomness limit** (`ponytail:` in the source and in the page rules): the X Layer sequencer could grind the draw block; switch to a VRF when prizes are worth it.

## Layout

```
contracts/   Foundry (cancun)
  src/MeowBox.sol           the contract (native coin; no token)
  test/MeowBox.t.sol        21 tests: 95/5, min deposit, tier edges, average prize, every tier pays (generous test tiers), unpayable tier
                            = empty, next open settles + counts click, gap, seen-all then tomorrow, pick follows the money, fuzzed
                            Fenwick tree vs a linear walk (with top-ups), session key opens/claims for the wallet, expiry/extend/end,
                            key and wallet hijack attempts, a re-entering winner, EIP-2935, lost hash, bad ads, bad config, fuzzed conservation
  test/XLayerFork.t.sol     the whole flow on an X Layer fork in OKB, fee paid to the owner wallet (forge test --match-contract XLayerFork --fork-url https://rpc.xlayer.tech)
  script/Deploy.s.sol       mainnet: env OWNER MIN_DEPOSIT GAP JACKPOT_BPS PRIZES(3, comma, wei) PPM(4, comma)
  script/DeployLocal.s.sol  local: native coin, mainnet tiers with 100× the chances (to see wins), 3 sample ads (one with a CC0 sample video)
web/         static; upload the whole folder to DeWEB; no inline scripts; system fonts only
  index.html / app.js       three tabs (#box / #advertise / #rules; bottom bar on phones, top nav ≥960 px).
                            Open: full-screen swipe feed (touch, wheel, arrow keys, button): glass box + pool → "sign once" (session key)
                            → swipe: opening (blinking eye) → the ad (video full-bleed or text card) with an 8 s ring → result over it
                            (tier, thin big amount, claim, the ad's link again, the draw folded). Desktop: phone-wide feed + pool panel
                            (stats, tiers, recent wins). Advertise: title/description/link/video + amount with a share-of-views bar,
                            my ads, all ads with add-money, owner fee panel. Rules.
  style.css                 "Noir": near-black, ivory, one champagne accent, hairlines, frosted glass, thin numerals; mobile first
  chain.js / wallet.js / i18n.js / config.js   X Layer constants / wallet / zh+en / TAPE_BOX (empty: not deployed)
server/      local dev only: server.mjs (static + CSP), dev.mjs (anvil 8547 + deploy + site 8820)
```

## Running locally

```bash
npm test          # 21 tests (+1 fork test that skips off X Layer)
npm run slither   # 0 findings
npm run dev       # http://127.0.0.1:8820/ ; #1 owner, #2 advertiser, #3–#6 players (anvil's 10000 coins each, shown as OKB)
```

Desktop preview: `meow-box-dev` in the workspace launch.json. Without a wallet, inject a `window.ethereum` stub (ethers.Wallet + an anvil key). Tested 2026-10-16 at 375 and 1280 px: signing once was the only wallet pop-up; swipes opened boxes through the session key with none; 4 swipes inside 0.3 s sent one transaction and the next swipe after the result worked (fixes: receipts polled every 1 s, no NonceManager, whose count drifts when a send fails before broadcasting); video ads play muted with a sound toggle; text ads render as cards; results overlay with the draw folded; advertise shows the share of views; no sideways scroll; no console errors. A real win was not caught on screen in that run (about 11% a box locally); the win screen was checked by restyling a result in the page, and payouts are covered by the contract tests.

## Live (2026-10-16)

- **Site**: https://1-2-339.tapekit.org/ (X Layer DeWEB, circuit #1 of processor 339, container `0x3F79e17c3D0E4622F94595B50fC0D5f41DA1919B`, uploaded with TapeCode; the 10 files' on-chain SHA-256 match web/).
- **Contract**: MeowBox `0x082F57A5f738D502fbA8811c37640A94d86d1E52` on X Layer (tx `0xae04adce322bb20fcf50b5240d034784fa0f9e843af1c66aa7ee98980edd8e33`, block 73378633). Its runtime code matches a rebuild of `contracts/src/MeowBox.sol` from the block before; **do not edit that file** (a change means a new contract). Parameters: owner `0xAAB5fDD295F6d5fF8C874c7ad74889F5Ae9ea9b1`, minDeposit 0.001 OKB, gap 8 s, jackpot 20% of the pool, prizes 0.1 / 0.01 / 0.001 OKB at 1 / 5 / 50 / 1000 per million.
- Re-uploading the site after a change: TapeCode, "Upload", same container (only changed files are sent). Set the wallet's gas price by hand (~0.02–0.05 gwei): a wallet's default "fast" fee on X Layer was 75× the base fee.
- X Layer's public RPC refuses JSON-RPC batches over 10 requests (`-32014`); chain.js caps them.

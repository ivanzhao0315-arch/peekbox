// 瞄一箱 PeekBox: the whole site is this page over one MeowBox contract (config.js TAPE_BOX). Everything comes from the contract,
// no event scan, no server. The Open tab is a swipe feed: each swipe up opens a box with a session key (authorized once by the
// wallet, holding a little gas, kept in this browser), so no wallet pop-up per box. The box shows an ad (its video, or a text
// card) for `gap` seconds, picked with weight = the money put into it; its result (one draw over four prize tiers) comes from the
// next block's hash and lands on top of the ad. A win is paid with the next box or 现在领取 (claim).
// Ads are untrusted text from strangers: everything goes through esc(), links and videos must be https.
import { CHAIN, MAINNET, rpcUrl, readProvider, switchChain } from './chain.js';
import { walletProvider, restoreWallet, noWalletHint } from './wallet.js';

const ABI = [
  'function owner() view returns (address)', 'function minDeposit() view returns (uint96)', 'function gap() view returns (uint32)', 'function jackpotBps() view returns (uint16)',
  'function prize1() view returns (uint96)', 'function prize2() view returns (uint96)', 'function prize3() view returns (uint96)',
  'function ppm0() view returns (uint32)', 'function ppm1() view returns (uint32)', 'function ppm2() view returns (uint32)', 'function ppm3() view returns (uint32)',
  'function pool() view returns (uint256)', 'function fees() view returns (uint256)', 'function raised() view returns (uint256)', 'function opens() view returns (uint256)', 'function paid() view returns (uint256)', 'function wins() view returns (uint256)',
  'function adCount() view returns (uint256)',
  'function ads(uint256 from, uint256 to) view returns ((address owner, uint96 spent, uint32 views, uint32 clicks, uint40 created, string title, string body, string link, string video)[])',
  'function recent() view returns ((address user, uint32 ad, uint8 tier, uint40 time, uint256 amount)[])',
  'function boxOf(address) view returns (uint32 ad, uint64 target)', 'function seenDay(uint256, address) view returns (uint256)', 'function lastOpen(address) view returns (uint256)', 'function pending(address) view returns (uint256 tier, uint256 amount)',
  'function sessionOf(address) view returns (address user, uint64 until)', 'function keyMessage(address) view returns (bytes32)', 'function authorize(address key, uint64 until, uint8 v, bytes32 r, bytes32 s) payable',
  'function publish(string title, string body, string link, string video) payable returns (uint256)', 'function deposit(uint256 id) payable',
  'function open(bool clicked)', 'function claim(bool clicked)', 'function fund() payable', 'function collect()',
  'error BadConfig()', 'error BadAd()', 'error NotAllowed()', 'error Closed()', 'error Expired()', 'error SeenAll()', 'error TooSoon()', 'error NothingToDo()', 'error TransferFailed()', 'error Busy()',
];
const FEE_BPS = 500n, HASH_BLOCKS = 8191, PAGE = 50, NONE = 4;
const SESSION_HOURS = 24, KEY_GAS = '0.001', KEY_LOW = 30000000000000n; // hand the key 0.001 OKB; top it up under 0.00003 (~10 boxes)
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const reader = readProvider(rpcUrl(q));
reader.pollingInterval = 1000; // receipts every second, not every 4 s: the session key waits on this provider between swipes
const ADDRESS = !MAINNET && ethers.isAddress(q.get('box')) ? q.get('box') : window.TAPE_BOX; // ?box= only off mainnet: a link must not swap the contract people pay
const box = ADDRESS ? new ethers.Contract(ADDRESS, ABI, reader) : null;
const lower = (a) => (a || '').toLowerCase();
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
const bytes = (s) => new TextEncoder().encode(s).length;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const say = (s) => ($('msg').textContent = s);
const addrLink = (a) => (CHAIN.explorer ? `<a href="${CHAIN.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : short(a));
let cfg = null; // owner, minDeposit, gap, tiers; amounts in the native coin (OKB)
let st = null; // the contract's numbers and every ad
let my = null; // the connected wallet's box, the ads it saw today
let me = '', signer = null, busy = false, seq = 0, skew = 0;
let key = null; // this browser's session key for `me`: { wallet, nm, ok (authorized, not expired), until, gas }
let feed = { state: 'intro', lock: false }; // what the feed shows; lock = an opening or its ad is still running
const amt = (units, dp = 4) => String(Number(Number(ethers.formatUnits(units, cfg.dec)).toFixed(dp)));
const fmt = (units) => `${amt(units)} ${cfg.sym}`;
const pct = (x) => `${x < 0.1 ? x.toFixed(2) : x.toFixed(1)}`.replace(/\.?0+$/, '') + '%';
const oneIn = (ppm) => (ppm ? `1/${Math.round(1e6 / ppm).toLocaleString()}` : '—');
const hours = () => (HASH_BLOCKS * CHAIN.blockSec / 3600).toFixed(1);
const ad = (x, id) => ({ id, owner: lower(x.owner), spent: x.spent, views: Number(x.views), clicks: Number(x.clicks), title: x.title, body: x.body, link: x.link, video: x.video });
const rate = (a) => (a.views ? pct((100 * a.clicks) / a.views) : '—');
const share = (a) => (st.total ? pct(Number((a.spent * 10000n) / st.total) / 100) : '—'); // its slice of the views
const TIER = () => [t('头奖', 'Jackpot'), t('大奖', 'Big'), t('中奖', 'Mid'), t('小奖', 'Small')];
const KICK = (i) => t(`${TIER()[i]} · ${['JACKPOT', 'GRAND PRIZE', 'PRIZE', 'SMALL PRIZE'][i]}`, ['Jackpot', 'Grand prize', 'Prize', 'Small prize'][i]);
const tierPrize = (i) => (i === 0 ? (st ? (st.pool * BigInt(cfg.jackpotBps)) / 10000n : 0n) : cfg.prizes[i - 1]); // what tier i pays now

/** what kind of thing a link opens, from its host: App Store, Google Play, Telegram… or a web page */
function kindOf(link) {
  let h = ''; try { h = new URL(link).hostname.toLowerCase(); } catch {}
  const k = { 'apps.apple.com': 'App Store', 'itunes.apple.com': 'App Store', 'play.google.com': 'Google Play', 't.me': 'Telegram', 'telegram.me': 'Telegram', 'x.com': 'X', 'twitter.com': 'X', 'www.youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'discord.gg': 'Discord' }[h];
  return { kind: k || (/(^|\.)tapekit\.org$/.test(h) ? 'DeWEB' : t('网页', 'Web')), host: h };
}
const goLabel = (kind) => (kind === 'App Store' || kind === 'Google Play' ? t(`去 ${kind} 看看`, `Open in ${kind}`) : t('去看看', 'Open'));
const ARROW = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

/** an ad's mark: its title's first character on a color picked from the title */
const TILES = ['#FF6B7A', '#7B5CFF', '#2FB8A4', '#3D8BFF', '#F28C38', '#D94FB0'];
function tile(title) {
  let h = 0; for (const ch of title || '') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `<span class="tile" style="background:${TILES[h % TILES.length]}">${esc(([...(title || '?')][0] || '?').toUpperCase())}</span>`;
}

/** an ad as a text card: mark, title, description, the link button; everything the advertiser wrote is escaped */
function adCard(a) {
  const { kind, host } = kindOf(a.link);
  const go = https(a.link) ? `<a class="btn light go" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ad="${a.id}">${goLabel(kind)} ${ARROW}</a>` : '';
  return `<div class="ad">${tile(a.title)}<h3>${esc(a.title)}</h3>${a.body ? `<p>${esc(a.body)}</p>` : ''}<div class="host">${esc(kind)} · ${esc(host)}</div>${go}</div>`;
}

/** an ad in the feed: its video full-bleed with the title and button over it, or the text card when it has no video */
function adScreen(a) {
  if (!a.video || !https(a.video)) return `<div class="adtext">${adCard(a)}</div>`;
  const { kind, host } = kindOf(a.link);
  const go = https(a.link) ? `<a class="btn light go" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ad="${a.id}">${goLabel(kind)} ${ARROW}</a>` : '';
  return `<video class="advideo" src="${esc(a.video)}" autoplay muted loop playsinline preload="auto"></video><button class="sound" type="button" aria-label="sound">${t('声音', 'Sound')}</button>
    <div class="adover"><div class="spons">${t('赞助', 'Sponsored')} · ${esc(kind)}</div><h3>${esc(a.title)}</h3>${a.body ? `<p>${esc(a.body)}</p>` : ''}${go}</div>`;
}

/** the glass box: wait = blinking while a transaction runs, open = the eye wide, won = rays too, dull = an empty box */
const glyph = (cls = '') => `<div class="glyph ${cls}"><svg viewBox="0 0 200 200" aria-hidden="true">
  <g class="rays" stroke="#E8D6A8" stroke-width="1" stroke-linecap="round" opacity=".6"><path d="M100 0 V26M100 174 V200M0 100 H26M174 100 H200M28 28 L46 46M172 28 L154 46M28 172 L46 154M172 172 L154 154"/></g>
  <rect x="22" y="22" width="156" height="156" rx="38" fill="url(#nGlass)"/><rect x="22.5" y="22.5" width="155" height="155" rx="37.5" fill="none" stroke="url(#nEdge)"/>
  <path d="M42 30 Q100 22 158 30" stroke="#fff" stroke-opacity=".12" stroke-width="2" fill="none" stroke-linecap="round"/>
  <ellipse class="aura" cx="100" cy="100" rx="64" ry="30" fill="url(#nAura)"/>
  <g class="eye"><path d="M60 100 Q100 86 140 100 Q100 114 60 100 Z" fill="url(#nSlit)"/><circle cx="100" cy="100" r="3.4" fill="#09090B"/></g></svg></div>`;

async function loadConfig() {
  const [owner, minDeposit, gap, jackpotBps, p1, p2, p3, c0, c1, c2, c3] = await Promise.all(['owner', 'minDeposit', 'gap', 'jackpotBps', 'prize1', 'prize2', 'prize3', 'ppm0', 'ppm1', 'ppm2', 'ppm3'].map((f) => box[f]()));
  cfg = { owner: lower(owner), minDeposit, gap: Number(gap), jackpotBps: Number(jackpotBps), prizes: [p1, p2, p3], ppm: [c0, c1, c2, c3].map(Number), dec: 18, sym: CHAIN.currency }; // everything is in the chain's own coin
}

async function refresh() {
  const n = ++seq;
  const [blk, pool, fees, raised, opens, paid, wins, count, recent] = await Promise.all([reader.getBlock('latest'), box.pool(), box.fees(), box.raised(), box.opens(), box.paid(), box.wins(), box.adCount(), box.recent()]);
  const pages = [];
  for (let from = 1; from <= Number(count); from += PAGE) pages.push(box.ads(from, Math.min(Number(count), from + PAGE - 1)).then((l) => l.map((x, i) => ad(x, from + i))));
  const ads = (await Promise.all(pages)).flat();
  let user = null;
  if (me) {
    const [b, last, ...seen] = await Promise.all([box.boxOf(me), box.lastOpen(me), ...ads.map((a) => box.seenDay(a.id, me))]); // ponytail: one seenDay call per ad; fine for dozens
    const day = Math.floor(blk.timestamp / 86400) + 1;
    user = { box: { ad: Number(b.ad), target: Number(b.target) }, last: Number(last), seen: new Set(ads.filter((a, i) => Number(seen[i]) === day).map((a) => a.id)), win: null };
    if (user.box.ad && blk.number > user.box.target) { const [tier, amount] = await box.pending(me); if (amount > 0n) user.win = { tier: Number(tier), amount }; }
    if (key) { const [s, gas] = await Promise.all([box.sessionOf(key.wallet.address), reader.getBalance(key.wallet.address)]); Object.assign(key, { ok: lower(s.user) === me && Number(s.until) > blk.timestamp, until: Number(s.until), gas }); }
  }
  if (n !== seq) return; // a newer refresh started meanwhile: only the newest lands
  skew = blk.timestamp - Date.now() / 1000;
  st = { head: blk.number, pool, fees, raised, opens: Number(opens), paid, wins: Number(wins), ads, total: ads.reduce((s, a) => s + a.spent, 0n), recent: recent.map((w) => ({ user: lower(w.user), ad: Number(w.ad), tier: Number(w.tier), time: Number(w.time), amount: w.amount })) };
  my = user;
  render();
}

const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000 + skew - ts)); return s < 60 ? t('刚刚', 'just now') : s < 3600 ? t(`${Math.floor(s / 60)} 分钟前`, `${Math.floor(s / 60)} min ago`) : s < 86400 ? t(`${Math.floor(s / 3600)} 小时前`, `${Math.floor(s / 3600)} h ago`) : t(`${Math.floor(s / 86400)} 天前`, `${Math.floor(s / 86400)} d ago`); };
const allSeen = () => !!my && st.ads.length > 0 && st.ads.every((a) => my.seen.has(a.id));

function render() {
  $('pool').textContent = amt(st.pool, 4);
  $('sym').textContent = cfg.sym;
  $('paid').textContent = amt(st.paid, 4);
  $('wins').textContent = st.wins.toLocaleString();
  $('opens').textContent = st.opens.toLocaleString();
  $('poolPill').textContent = t(`奖金池 ${amt(st.pool, 4)} ${cfg.sym}`, `Pool ${amt(st.pool, 4)} ${cfg.sym}`);
  $('tiers').innerHTML = [0, 1, 2, 3].map((i) => `<div class="${i === 0 ? 'jk' : ''}"><span>${TIER()[i]}</span><b class="num">${amt(tierPrize(i), 4)}</b><em class="num">${oneIn(cfg.ppm[i])}</em></div>`).join('');
  $('gasPill').classList.toggle('hidden', !(key && key.ok));
  if (key && key.ok) $('gasPill').textContent = `gas ${Number(ethers.formatEther(key.gas)).toFixed(5)} OKB`;
  const adTitle = (id) => (st.ads[id - 1] ? st.ads[id - 1].title : '#' + id);
  $('recent').innerHTML = st.recent.slice(0, 6).map((w) => `<div class="w ${w.user === me ? 'me' : ''}"><span class="av">${TIER()[w.tier][0]}</span><span class="who">${short(w.user)}</span><span class="what">${t('看了', 'watched')}「${esc(adTitle(w.ad))}」</span><span class="amt num">+${amt(w.amount)}</span><span class="ago">${ago(w.time)}</span></div>`).join('')
    || `<div class="empty">${t('还没人中奖，第一个可能是你', 'No wins yet: the first could be yours')}</div>`;
  renderPending(); renderAds(); renderMine(); renderAdmin();
  if (!feed.lock) renderIdle();
}

function renderPending() {
  const show = !!(my && my.win) && !feed.lock && feed.state !== 'result';
  $('pending').classList.toggle('hidden', !show);
  if (!show) return;
  const left = Math.max(0, (my.box.target + HASH_BLOCKS - st.head) * CHAIN.blockSec / 60);
  $('pendingText').textContent = t(`你上一箱开中${TIER()[my.win.tier]} ${fmt(my.win.amount)}，下一箱自动到账，或现在领取（约 ${Math.floor(left)} 分钟内有效）`, `Your last box won the ${TIER()[my.win.tier]} prize, ${fmt(my.win.amount)}: it comes with the next box, or claim it now (about ${Math.floor(left)} more minutes)`);
}

// ---- the feed ----
/** the feed when nothing is running: what the next swipe does, or what has to happen first */
function renderIdle() {
  if (feed.state === 'result') return; // a result stays until the next swipe
  const c = $('card');
  let body, btn = '';
  if (!st.ads.length) body = `<b>${t('宝箱暂时关着', 'The box is closed')}</b><span>${t('还没有广告，投第一条吧', 'No ads yet: publish the first')}</span>`;
  else if (!me) { body = `<b>${t('上滑，开一箱', 'Swipe up to open')}</b><span>${t('连上钱包就能开，看完广告揭晓', 'Connect a wallet to start; the result comes after the ad')}</span>`; btn = `<button class="btn big" type="button" data-act="connect">${t('连接钱包', 'Connect wallet')}</button>`; }
  else if (!key || !key.ok) { body = `<b>${t('开启滑动开箱', 'Turn on swipe opening')}</b><span>${t(`签一次，之后上滑就开，不再弹钱包。会顺手转 ${KEY_GAS} OKB 给这个浏览器的临时钥匙当 gas（约够开 250 箱），奖金照样进你的钱包，${SESSION_HOURS} 小时后自动失效。`, `Sign once, then every swipe opens a box with no wallet pop-up. ${KEY_GAS} OKB goes to this browser's session key as gas (about 250 boxes); prizes still go to your wallet; it expires in ${SESSION_HOURS} h.`)}</span>`; btn = `<button class="btn big" type="button" data-act="session">${t('签一次，开始滑', 'Sign once and start')}</button>`; }
  else if (key.gas < KEY_LOW) { body = `<b>${t('临时钥匙的 gas 快用完了', 'The session key is low on gas')}</b><span>${t(`再转 ${KEY_GAS} OKB 进去就能继续滑`, `Send it another ${KEY_GAS} OKB to keep swiping`)}</span>`; btn = `<button class="btn big" type="button" data-act="session">${t('补充 gas', 'Top up gas')}</button>`; }
  else if (allSeen()) body = `<b>${t('今天的广告都看完了', 'You have seen every ad today')}</b><span>${t('明天北京时间 8 点刷新，或等新广告上线', 'Back tomorrow (00:00 UTC), or when a new ad goes live')}</span>`;
  else body = `<b>${t('上滑，开一箱', 'Swipe up to open')}</b><span>${t('看完广告揭晓 · 不弹钱包', 'The result comes after the ad · no wallet pop-ups')}</span>`;
  c.className = 'fcard idle';
  const pot = `<div class="potline"><div class="eyebrow">${t('奖金池 · PRIZE POOL', 'Prize pool')}</div><div class="v"><b class="thin">${amt(st.pool, 4)}</b><span>${esc(cfg.sym)}</span></div><div class="s">${t(`头奖 ${amt(tierPrize(0), 4)} · 每一箱都是一次抽奖`, `Jackpot ${amt(tierPrize(0), 4)} · every box is a draw`)}</div></div>`;
  c.innerHTML = pot + glyph() + `<div class="idletext">${body}</div>${btn || (canSwipe() ? '<div class="scrollhint"><i></i></div>' : '')}`;
  $('nextBtn').disabled = !canSwipe();
}
const canSwipe = () => !!(cfg && st && st.ads.length && me && key && key.ok && key.gas >= KEY_LOW && !allSeen());

/** the session key for `me` from this browser (made on first use); the private key never leaves the browser and only ever holds gas */
function loadKey() {
  const k = `peekbox-key:${ADDRESS}:${me}`;
  let pk = null; try { pk = localStorage.getItem(k); } catch {}
  if (!pk) { pk = ethers.Wallet.createRandom().privateKey; try { localStorage.setItem(k, pk); } catch {} }
  // no NonceManager: it advances its count even when a send fails before broadcasting (say, a swipe inside the 8 s), which stalls
  // every later box; one transaction at a time, so the chain's own pending count is always right
  key = { wallet: new ethers.Wallet(pk, reader), ok: false, until: 0, gas: 0n };
}

async function startSession() {
  if (!signer) await connect();
  if (!key) loadKey();
  say(t('请在钱包里确认：授权临时钥匙并转入 gas…', 'Confirm in your wallet: authorize the session key and send it gas…'));
  const sig = key.wallet.signingKey.sign(await box.keyMessage(me));
  const until = Math.floor(Date.now() / 1000 + skew) + SESSION_HOURS * 3600;
  await (await box.connect(signer).authorize(key.wallet.address, until, sig.v, sig.r, sig.s, { value: ethers.parseEther(KEY_GAS) })).wait();
  say(t('好了，上滑开一箱', 'Done: swipe up to open'));
  await refresh();
}

async function next() {
  if (busy || feed.lock) { nudge(); return; }
  if (!canSwipe()) { renderIdle(); nudge(); return; }
  const wait = my.last + cfg.gap - (Date.now() / 1000 + skew);
  if (wait > 0) { say(t(`再等 ${Math.ceil(wait)} 秒`, `${Math.ceil(wait)} more seconds`)); nudge(); return; }
  busy = true; feed.lock = true; say('');
  const c = $('card');
  try {
    c.className = 'fcard idle enter';
    c.innerHTML = glyph('wait') + `<div class="idletext"><b>${t('开箱中', 'Opening')}</b><span>${t('等区块确认', 'Waiting for the block')}</span></div>`;
    const lastWin = my.win;
    const rc = await (await box.connect(key.wallet).open(clickedFlag())).wait();
    clearClick();
    const b = await box.boxOf(me, { blockTag: rc.blockNumber });
    const id = Number(b.ad), target = Number(b.target);
    my.box = { ad: id, target }; my.win = null; my.last = Math.floor(Date.now() / 1000 + skew);
    refresh().catch(() => {});
    const a = st.ads[id - 1] || ad((await box.ads(id, id))[0], id);
    // the ad, with a ring for the gap
    feed.state = 'ad';
    c.className = 'fcard playing enter';
    c.innerHTML = adScreen(a) + `<div class="ring"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" class="track"/><circle cx="32" cy="32" r="28" class="arc" transform="rotate(-90 32 32)"/></svg><span class="left num">${cfg.gap}</span></div>`
      + (lastWin ? `<div class="chip note num">${t(`上一箱 +${amt(lastWin.amount)} 已到账`, `Last box +${amt(lastWin.amount)} paid`)}</div>` : '');
    wireVideo(c, a);
    const arc = c.querySelector('.arc'), left = c.querySelector('.left');
    arc.style.transition = 'none'; arc.style.strokeDashoffset = '0'; void arc.getBoundingClientRect();
    arc.style.transition = `stroke-dashoffset ${cfg.gap}s linear`; arc.style.strokeDashoffset = '176';
    for (let s = cfg.gap; s > 0; s--) { left.textContent = s; await sleep(1000); }
    while ((await reader.getBlockNumber()) <= target) await sleep(500);
    const [[tierB, amount], blk] = await Promise.all([box.pending(me), reader.getBlock(target)]);
    const tier = Number(tierB);
    my.win = amount > 0n ? { tier, amount } : null;
    c.querySelector('.ring').remove();
    const roll = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'address', 'uint256'], [blk.hash, ADDRESS, me, target]))) % 1000000n;
    const proof = `<details class="proof"><summary>${t('查看开奖算式', 'See the draw')}</summary><div>${t('开奖区块', 'block')} #${target} · ${blk.hash.slice(0, 10)}…${blk.hash.slice(-6)}<br>keccak(hash, ${t('合约', 'contract')}, ${t('钱包', 'wallet')}, ${t('区块', 'block')}) mod 1,000,000 = ${roll} → ${tier < NONE ? TIER()[tier] : t('未中', 'no prize')}${tier < NONE && !amount ? t('（奖金池不够付这一档，这次算空箱）', ' (the pool cannot pay this tier: empty this time)') : ''}<br>${t('头奖', 'jackpot')} &lt; ${cfg.ppm[0]} · ${t('大奖', 'big')} &lt; ${cfg.ppm[0] + cfg.ppm[1]} · ${t('中奖', 'mid')} &lt; ${cfg.ppm[0] + cfg.ppm[1] + cfg.ppm[2]} · ${t('小奖', 'small')} &lt; ${cfg.ppm.reduce((x, y) => x + y)}</div></details>`;
    const { kind } = kindOf(a.link);
    const again = https(a.link) ? `<a class="linkish" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ad="${a.id}">${esc(a.title)} · ${goLabel(kind)} ↗</a>` : '';
    const res = document.createElement('div');
    res.className = amount > 0n ? `result win${tier <= 1 ? ' big' : ''}` : 'result';
    res.innerHTML = amount > 0n ? glyph('open won') + `<div class="kick">${KICK(tier)}</div><div class="amount"><b class="thin">+${amt(amount)}</b><span>${esc(cfg.sym)}</span></div><div class="sub">${t('下一箱自动到账', 'It comes with your next box')}</div><button class="btn gold" type="button" data-act="claim">${t('现在领取', 'Claim now')}</button>${again}${proof}`
      : glyph('dull') + `<div class="none">${t('这箱空了', 'Empty')}</div><div class="sub">${t('上滑，下一箱', 'Swipe up for the next box')}</div>${again}${proof}`;
    c.append(res);
    if (amount > 0n) sparks(c);
    feed.state = 'result';
  } catch (e) { feed.state = 'intro'; throw e; } finally { busy = false; feed.lock = false; $('nextBtn').disabled = !canSwipe(); }
}

function wireVideo(c, a) {
  const v = c.querySelector('video'), s = c.querySelector('.sound');
  if (!v) return;
  v.addEventListener('error', () => { v.remove(); s.remove(); const o = c.querySelector('.adover'); if (o) o.outerHTML = `<div class="adtext">${adCard(a)}</div>`; }, { once: true }); // a broken video falls back to the text card
  s.onclick = () => { v.muted = !v.muted; s.textContent = v.muted ? t('声音', 'Sound') : t('静音', 'Mute'); };
}
function nudge() { const c = $('card'); c.classList.remove('nudge'); void c.offsetWidth; c.classList.add('nudge'); }
function sparks(c) { for (let i = 0; i < 18; i++) { const s = document.createElement('span'); const a = (i / 18) * Math.PI * 2; s.className = 'spark'; s.style.setProperty('--dx', `${Math.cos(a) * 150}px`); s.style.setProperty('--dy', `${Math.sin(a) * 150}px`); s.style.animationDelay = `${(i % 3) * 60}ms`; c.append(s); setTimeout(() => s.remove(), 1800); } }

async function claim() {
  if (!signer) await connect();
  say(t('领取中…', 'Claiming…'));
  const by = key && key.ok && key.gas >= KEY_LOW ? key.wallet : signer; // the session key claims without a pop-up
  await (await box.connect(by).claim(clickedFlag())).wait();
  clearClick();
  say(t('奖金已到账', 'Paid'));
  if (feed.state === 'result') { const b = $('card').querySelector('[data-act="claim"]'); if (b) b.replaceWith(Object.assign(document.createElement('div'), { className: 'sub', textContent: t('✓ 已到账', '✓ Paid') })); }
  await refresh();
}

// swipe up / wheel / arrow keys / the button: the next box
(() => {
  const f = $('feed');
  let y0 = null;
  f.addEventListener('touchstart', (e) => { y0 = e.target.closest('a,button,video,details') ? null : e.touches[0].clientY; }, { passive: true });
  f.addEventListener('touchmove', (e) => { if (y0 !== null) e.preventDefault(); }, { passive: false }); // the feed does not scroll the page
  f.addEventListener('touchend', (e) => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; if (dy < -50) run(next); });
  let wheelAt = 0;
  f.addEventListener('wheel', (e) => { e.preventDefault(); if (e.deltaY > 30 && Date.now() - wheelAt > 900) { wheelAt = Date.now(); run(next); } }, { passive: false });
  f.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ') { e.preventDefault(); run(next); } });
  $('nextBtn').onclick = () => run(next);
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'connect') run(connect);
    if (b.dataset.act === 'session') run(startSession);
    if (b.dataset.act === 'claim') run(claim);
  });
})();

// ---- following an ad's link: counted on chain with my next transaction, once, and only for the box I opened last ----
const clickKey = () => `meowbox-click:${ADDRESS}:${me}`;
const clickedFlag = () => { try { return !!(my && my.box.ad && localStorage.getItem(clickKey()) === `${my.box.ad}:${my.box.target}`); } catch { return false; } };
const clearClick = () => { try { localStorage.removeItem(clickKey()); } catch {} };
document.addEventListener('click', (e) => {
  const l = e.target.closest('a[data-ad]');
  if (!l || !my || Number(l.dataset.ad) !== my.box.ad) return;
  try { localStorage.setItem(clickKey(), `${my.box.ad}:${my.box.target}`); } catch {}
});

// ---- the Advertise tab ----
const topup = (a) => `<div class="topup"><input class="in sm" inputmode="decimal" value="${amt(cfg.minDeposit * 10n)}" data-amt="${a.id}" aria-label="amount"><button class="btn ghost sm" type="button" data-dep="${a.id}">${t('追加投入', 'Add money')}</button></div>`;
function renderAds() {
  const list = st.ads.slice().sort((x, y) => (y.spent > x.spent ? 1 : y.spent < x.spent ? -1 : x.id - y.id));
  const keep = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.amt; // do not wipe an amount being typed
  if (keep) return;
  $('adgrid').innerHTML = list.length ? list.map((a) => {
    const { kind, host } = kindOf(a.link), title = https(a.link) ? `<a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer nofollow" data-ad="${a.id}">${esc(a.title)}</a>` : esc(a.title);
    return `<article class="adc"><div class="hd">${tile(a.title)}<span class="kind">${esc(kind)}</span>${a.video ? `<span class="kind">${t('视频', 'video')}</span>` : ''}<span class="host">${esc(host)}</span></div><div class="tt">${title}</div>
      <div class="cps"><span>${t('累计投入', 'Put in')}</span><b class="num">${amt(a.spent, 4)}</b><span>${cfg.sym} · ${t('曝光占比', 'share of views')} ${share(a)}</span></div>
      <div class="nums3"><div>${t('开箱', 'Opened')}<b class="num">${a.views.toLocaleString()}</b></div><div class="c">${t('跳转', 'Clicked')}<b class="num">${a.clicks.toLocaleString()}</b></div><div>${t('跳转率', 'Click rate')}<b class="num">${rate(a)}</b></div></div>
      <div class="prog"><i style="width:${st.total ? Number((a.spent * 100n) / st.total) : 0}%"></i></div>${me ? topup(a) : ''}</article>`;
  }).join('') : `<div class="emptybox">${t('还没有广告。投第一条，所有开箱的人都会看到你。', 'No ads yet. Publish the first and everyone who opens the box sees it.')}</div>`;
}

function renderMine() {
  const list = me ? st.ads.filter((a) => a.owner === me).reverse() : [];
  $('mineCard').classList.toggle('hidden', !list.length);
  $('mine').innerHTML = list.map((a) => `<tr><td class="t">${esc(a.title)}<div class="muted">${esc(kindOf(a.link).host)}</div></td><td class="r">${fmt(a.spent)}</td><td class="r">${share(a)}</td>
    <td class="r">${a.views}</td><td class="r">${a.clicks}</td><td class="r">${rate(a)}</td><td><a class="linkish" href="#advertise" data-jump="${a.id}">${t('追加', 'Add')}</a></td></tr>`).join('');
}

function renderAdmin() {
  const owner = me && me === cfg.owner;
  $('adminCard').classList.toggle('hidden', !owner);
  if (!owner) return;
  $('feesLine').textContent = t(`待提取手续费 ${fmt(st.fees)}（每笔投入的 5%）· 累计投入 ${fmt(st.raised)}`, `Fee to collect: ${fmt(st.fees)} (5% of every deposit) · raised ${fmt(st.raised)}`);
  $('collectBtn').disabled = busy || st.fees === 0n;
}

function draft() {
  const f = { title: $('fTitle').value.trim(), body: $('fBody').value.trim(), link: $('fLink').value.trim(), video: $('fVideo').value.trim() };
  let amount = 0n;
  try { amount = ethers.parseUnits(($('fAmount').value || '0').trim(), cfg.dec); } catch {}
  const errs = [];
  if (!f.title) errs.push(t('写个标题', 'Add a title'));
  if (bytes(f.title) > 80) errs.push(t('标题太长（最多 80 字节，约 26 个汉字）', 'Title too long (80 bytes at most)'));
  if (bytes(f.body) > 280) errs.push(t('简介太长（最多 280 字节，约 93 个汉字）', 'Description too long (280 bytes at most)'));
  if (!https(f.link) || bytes(f.link) > 300) errs.push(t('链接要以 https:// 开头', 'The link must start with https://'));
  if (f.video && (!https(f.video) || bytes(f.video) > 300)) errs.push(t('视频链接要以 https:// 开头', 'The video link must start with https://'));
  if (amount < cfg.minDeposit) errs.push(t(`最少投入 ${fmt(cfg.minDeposit)}`, `At least ${fmt(cfg.minDeposit)}`));
  return { ...f, amount, errs };
}

function renderDraft() {
  if (!cfg || !st) return;
  const d = draft(), fee = (d.amount * FEE_BPS) / 10000n, total = st.total + d.amount;
  $('cTitle').textContent = `${bytes(d.title)}/80`; $('cTitle').classList.toggle('bad', bytes(d.title) > 80);
  $('cBody').textContent = `${bytes(d.body)}/280`; $('cBody').classList.toggle('bad', bytes(d.body) > 280);
  $('lAmount').textContent = t(`投入金额（${cfg.sym}）`, `Amount (${cfg.sym})`);
  const sh = total ? Number((d.amount * 10000n) / total) / 100 : 0;
  $('shareBar').style.width = `${Math.min(100, sh)}%`;
  $('amountNote').textContent = t(`投得越多，曝光越多：按现在的总投入，你会拿到约 ${pct(sh)} 的开箱曝光。广告永久在线，之后随时可以追加。`, `More money, more views: at today's totals you would get about ${pct(sh)} of all box openings. The ad stays for good; add more any time.`);
  const ln = (k, v, cls = '') => `<div class="ln ${cls}"><span>${k}</span><b class="num">${v}</b></div>`;
  $('cost').innerHTML = ln(t('投入', 'You put in'), fmt(d.amount), 'tot') + ln(t('立刻进奖金池（95%）', 'Straight into the prize pool (95%)'), amt(d.amount - fee)) + ln(t('平台手续费（5%）', 'Platform fee (5%)'), amt(fee))
    + `<div class="ln"><span>${t('不能撤回', 'Final')}</span><b>${t('钱进池后归奖金池，不退', 'once in the pool it stays there')}</b></div>`
    + (d.errs.length && !(!d.title && !d.body && !d.link && !d.video) ? `<div class="bad">${d.errs.map(esc).join(' · ')}</div>` : ''); // an untouched (or just published, so cleared) form shows no complaints
  $('publish').disabled = busy || d.errs.length > 0;
  $('publish').textContent = d.errs.length ? t('付款并发布', 'Pay and publish') : t(`付 ${fmt(d.amount)} 立即发布`, `Pay ${fmt(d.amount)} and publish now`);
  const pv = { id: 0, title: d.title || t('你的标题', 'Your title'), body: d.body, link: d.link || 'https://', video: d.video };
  const wanted = pv.video && https(pv.video) ? pv.video : '';
  if ($('preview').dataset.video !== wanted || !wanted) { // keep a playing preview video instead of reloading it on every keystroke
    $('preview').dataset.video = wanted;
    $('preview').innerHTML = wanted ? `<div class="fcard playing pv">${adScreen(pv)}</div>` : adCard(pv);
  } else { const o = $('preview').querySelector('.adover b'); if (o) o.textContent = pv.title; }
}

/** sends `amount` OKB with the call `send` builds; the wallet keeps a little back for gas */
async function pay(amount, send) {
  if (!signer) await connect();
  if ((await reader.getBalance(me)) < amount + ethers.parseEther('0.0005')) throw new Error(t(`${cfg.sym} 不够：要 ${fmt(amount)}，另留一点付 gas`, `Not enough ${cfg.sym}: ${fmt(amount)} plus a little for gas`));
  say(t('请在钱包里确认付款…', 'Confirm the payment in your wallet…'));
  await (await send(box.connect(signer), { value: amount })).wait();
}

async function publish() {
  const d = draft();
  if (d.errs.length) throw new Error(d.errs[0]);
  await pay(d.amount, (c, o) => c.publish(d.title, d.body, d.link, d.video, o));
  for (const id of ['fTitle', 'fBody', 'fLink', 'fVideo']) $(id).value = '';
  say(t('已上线，开箱的人现在就可能刷到它', 'Live: people opening the box can get it now'));
  await refresh(); renderDraft();
}

async function topUp(id) {
  const input = document.querySelector(`[data-amt="${id}"]`);
  let v = 0n; try { v = ethers.parseUnits((input.value || '0').trim(), cfg.dec); } catch {}
  if (v < cfg.minDeposit) throw new Error(t(`最少投入 ${fmt(cfg.minDeposit)}`, `At least ${fmt(cfg.minDeposit)}`));
  input.blur();
  await pay(v, (c, o) => c.deposit(id, o));
  say(t(`已追加 ${fmt(v)}，曝光随之增加`, `Added ${fmt(v)}: more views from now on`));
  await refresh();
}

async function send(fn, ok) { if (!signer) await connect(); say(t('请在钱包里确认…', 'Confirm in your wallet…')); await (await fn(box.connect(signer))).wait(); say(ok); await refresh(); }

function rules() {
  const li = (zh, en) => `<li>${t(zh, en)}</li>`;
  const tierLine = [0, 1, 2, 3].map((i) => `${TIER()[i]} ${i === 0 ? t(`奖金池的 ${cfg.jackpotBps / 100}%`, `${cfg.jackpotBps / 100}% of the pool`) : fmt(cfg.prizes[i - 1])}（${oneIn(cfg.ppm[i])}）`).join(t('，', ', '));
  const ev = cfg.prizes.reduce((s, p, i) => s + Number(ethers.formatUnits(p, cfg.dec)) * cfg.ppm[i + 1], 0) / 1e6; // OKB a box from the fixed tiers
  $('rules').innerHTML = [
    li(`只有<b>一个宝箱</b>，<b>上滑一次开一箱</b>，看完广告揭晓。合约按每条广告的<b>累计投入</b>分配曝光（投得越多，被刷到的机会越大），<b>同一条广告你一天只会看到一次</b>（UTC 0 点 = 北京时间 8 点刷新）。<b>不限次数</b>，但两箱之间至少隔 <b>${cfg.gap} 秒</b>。`, `There is <b>one box</b>: <b>each swipe up opens it</b>, the result comes after the ad. Views go to ads in proportion to <b>the money put into them</b>, and <b>you never see the same ad twice in a day</b> (resets 00:00 UTC). <b>No limit</b> on boxes, but at least <b>${cfg.gap} s</b> between two.`),
    li(`每一箱都是一次抽奖，奖级从稀到常：${tierLine}。奖金池付不起的那一档算空箱，钱留在池里。`, `Every box is one draw, rarest first: ${tierLine}. A tier the pool cannot pay counts as empty; the money stays in the pool.`),
    li(`为什么概率这么低：没有实名，开箱只花 gas，所以每箱的平均奖金（约 ${ev.toPrecision(2)} ${cfg.sym}，加上头奖）定得比开一箱的 gas（约 0.0000035 ${cfg.sym}）还低；奖金和 gas 都是 ${cfg.sym}，币价涨跌不影响这个比例，用脚本刷箱平均是亏的。真正赢钱靠运气，像买彩票。`, `Why the odds are low: there is no identity check and a box costs only gas, so a box's average prize (about ${ev.toPrecision(2)} ${cfg.sym}, plus the jackpot) is set below the gas it costs (about 0.0000035 ${cfg.sym}); both are ${cfg.sym}, so its price does not move the balance, and scripting boxes loses money on average. Winning is luck, like a lottery ticket.`),
    li(`第一次开箱前签一笔交易：授权这个浏览器里的一把<b>临时钥匙</b>，并转 ${KEY_GAS} OKB 给它当 gas（约够开 250 箱）。之后上滑就由它开箱，不再弹钱包；奖金和记录都在你的钱包名下，钥匙里只有 gas，${SESSION_HOURS} 小时后失效。`, `Before your first box you sign once: a <b>session key</b> in this browser is authorized and gets ${KEY_GAS} OKB of gas (about 250 boxes). From then on it opens boxes as you swipe, no wallet pop-ups; prizes and records stay under your wallet; the key only holds gas and expires in ${SESSION_HOURS} h.`),
    li(`广告主投入任意金额（最少 ${fmt(cfg.minDeposit)}）：<b>95% 立刻进奖金池，5% 是平台手续费</b>。广告<b>永久在线</b>，谁都删不掉，平台也不能；钱进池后不退。任何人都可以给任何一条广告追加投入。`, `Advertisers put in any amount (at least ${fmt(cfg.minDeposit)}): <b>95% straight into the prize pool, 5% platform fee</b>. An ad stays <b>for good</b>: nobody can remove it, the platform included, and money in the pool is not refunded. Anyone can add money to any ad.`),
    li('开奖：开箱交易指定「下一个区块」，keccak256(那个区块的哈希, 合约, 钱包, 区块号) mod 1,000,000 落在哪一档就中哪一档。开箱时那个区块还不存在，谁都不知道结果，平台也不知道；每个结果都附有算式，可以自己复核。', 'The draw: an opening names the next block; keccak256(that block\'s hash, contract, wallet, block) mod 1,000,000 picks the tier. That block does not exist when you open, so nobody, the platform included, knows the result; each result shows the sum so you can recheck it.'),
    li(`中奖后下一箱自动到账，或点「现在领取」；要在约 <b>${hours()} 小时</b>内（链上只保存最近 8191 个区块的哈希），过期算空箱。`, `A win comes with your next box, or press "Claim now", within about <b>${hours()} hours</b> (the chain keeps 8191 block hashes); after that it counts as empty.`),
    li('「开箱」= 广告被看到的次数，当场上链；「跳转」= 开箱的人点了广告链接，在他下一笔交易时一起上链，所以最后一箱的跳转可能漏记。奖金池只能以奖金的形式发出：平台只能拿 5% 手续费，别的什么都动不了。', '"Opened" = times the ad was seen, on chain as it happens; "Clicked" = the opener followed the link, recorded with their next transaction, so a last box\'s click can be missed. The pool only leaves as prizes: the platform gets the 5% and can touch nothing else.'),
    li(`合约 ${addrLink(ADDRESS)}。已知的理论风险：出开奖区块的一方（${CHAIN.name} 的出块节点）可以反复换区块内容去凑哈希；奖金大到值得这么做时换成 VRF 随机数。没有实名，一个人开很多钱包可以多看多抽（平均仍是亏 gas）。`, `Contract ${addrLink(ADDRESS)}. Known limits: whoever produces the draw block (${CHAIN.name}'s block producer) could retry its contents for a favourable hash (a VRF fixes that when prizes are worth it); and with no identity check one person with many wallets can open more (still losing gas on average).`),
  ].join('');
  $('footC').innerHTML = t(`合约 ${addrLink(ADDRESS)} · 平台手续费 5%`, `Contract ${addrLink(ADDRESS)} · 5% platform fee`);
}

async function connect() {
  const eth = await walletProvider();
  if (!eth) throw new Error(noWalletHint());
  let provider = new ethers.BrowserProvider(eth);
  await provider.send('eth_requestAccounts', []);
  if (Number((await provider.getNetwork()).chainId) !== window.TAPE_CHAIN_ID) { await switchChain(window.ethereum); provider = new ethers.BrowserProvider(window.ethereum); }
  provider.pollingInterval = 1000; // ethers waits for receipts every 4 s by default; blocks here come every second or faster
  signer = await provider.getSigner();
  me = lower(await signer.getAddress());
  $('wallet').textContent = short(me); $('wallet').classList.remove('hidden'); $('connect').classList.add('hidden');
  loadKey();
  if (cfg) await refresh();
}

const ERRORS = {
  SeenAll: () => t('今天的广告你基本都看过了，等会儿再试，或明天再来', 'You have seen (nearly) every ad today: try again later, or tomorrow'),
  Closed: () => t('还没有广告', 'No ads yet'),
  TooSoon: () => t('太快了，等这条广告播完', 'Too fast: let this ad finish'),
  Expired: () => t('临时钥匙过期了，签一次重新开启', 'The session key expired: sign once more'),
  NothingToDo: () => t('没有要领取的宝箱', 'Nothing to claim'),
  BadAd: () => t('广告内容或金额不符合要求', 'The ad or the amount does not meet the rules'),
  NotAllowed: () => t('没有权限', 'Not allowed'),
};
async function run(fn) {
  if (busy && fn !== next) return;
  try { await fn(); } catch (e) {
    const name = e.revert && e.revert.name;
    say(ERRORS[name] ? ERRORS[name]() : e.code === 'ACTION_REJECTED' ? t('你在钱包里取消了', 'Cancelled in the wallet') : /insufficient funds/i.test(e.message || '') ? t('临时钥匙的 gas 不够了，补充一下', 'The session key is out of gas: top it up') : e.shortMessage || e.message);
    if (st) refresh().catch(() => {});
  } finally { if (st) { renderDraft(); if (!feed.lock) renderIdle(); } }
}

$('connect').onclick = () => run(connect);
$('claimBtn').onclick = () => run(claim);
$('adgrid').onclick = (e) => { const b = e.target.closest('[data-dep]'); if (b) run(() => topUp(Number(b.dataset.dep))); };
$('mine').onclick = (e) => { const l = e.target.closest('[data-jump]'); if (l) { e.preventDefault(); const i = document.querySelector(`[data-amt="${l.dataset.jump}"]`); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } } };
$('collectBtn').onclick = () => run(() => send((c) => c.collect(), t('手续费已转到平台钱包', 'The fee is in the owner wallet')));
$('fundBtn').onclick = () => run(async () => { let v = 0n; try { v = ethers.parseUnits($('fundAmt').value.trim() || '0', cfg.dec); } catch {} await pay(v, (c, o) => c.fund(o)); say(t('奖金池已充值', 'Added to the pool')); await refresh(); });
for (const id of ['fTitle', 'fBody', 'fLink', 'fVideo', 'fAmount']) $(id).oninput = renderDraft;
$('publish').onclick = () => run(publish);

// three tabs: #box (default), #advertise, #rules; a phone shows them as a bottom bar, a desktop in the top bar
const VIEWS = ['box', 'advertise', 'rules'];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'box';
  for (const id of VIEWS) $('v-' + id).hidden = id !== v;
  for (const l of document.querySelectorAll('[data-view]')) l.toggleAttribute('aria-current', l.dataset.view === v);
  document.body.classList.toggle('onbox', v === 'box');
  for (const vid of document.querySelectorAll('#card video')) { if (v === 'box') vid.play().catch(() => {}); else vid.pause(); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();

$('net').querySelector('span').textContent = CHAIN.name;
if (!box) {
  say(t('合约还没部署（config.js 的 TAPE_BOX 为空）', 'The contract is not deployed yet (config.js TAPE_BOX is empty)'));
  $('publish').disabled = true; $('nextBtn').disabled = true;
} else {
  (async () => {
    await loadConfig();
    rules();
    await refresh();
    renderDraft();
    setInterval(() => { if (!busy) refresh().catch(() => say(t('读链失败，重试中…', 'Chain read failed, retrying…'))); }, 6000);
  })().catch((e) => say(t('读链失败：', 'Chain read failed: ') + (e.shortMessage || e.message)));
}
restoreWallet().then((eth) => eth && eth.request({ method: 'eth_accounts' }).then((a) => { if (a.length) run(connect); })).catch(() => {});

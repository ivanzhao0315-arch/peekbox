// Which wallet the page talks to (an EIP-1193 provider): the one injected into the browser (an extension, or a wallet
// app's own browser), or, on a plain phone browser, WalletConnect: a jump into the wallet app on a phone, a QR code on a
// desktop. WalletConnect needs a project id (free at cloud.reown.com) in config.js as TAPE_WC_PROJECT. The library is
// bundled into the site (vendor/walletconnect.js, loaded only when used): the on-chain gateway allows no outside scripts.
import { receiptFrom, rpcUrl } from './chain.js';
let wc = null, lib = null;

async function walletConnect() {
  const projectId = window.TAPE_WC_PROJECT;
  if (!projectId) return null;
  if (!wc) {
    lib = lib || await import('./vendor/walletconnect.js');
    const chainId = window.TAPE_CHAIN_ID || 56;
    wc = await lib.EthereumProvider.init({
      projectId, chains: [chainId], showQrModal: false, optionalMethods: ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'wallet_switchEthereumChain'],
      rpcMap: { [chainId]: rpcUrl(new URLSearchParams(location.search)) }, // the same node the page reads
      metadata: { name: '瞄一箱 PeekBox', description: 'PeekBox · peek at an ad, open a box, maybe win', url: location.origin, icons: [location.origin + '/logo.svg'] },
    });
    wc.on('display_uri', (uri) => showPairing(uri));
    wc.on('connect', () => hidePairing());
    if (!window.TAPE_RPC && chainId === 56) { const ask = wc.request.bind(wc); wc.request = (a) => (a && a.method === 'eth_getTransactionReceipt' ? receiptFrom(a.params) : ask(a)); } // its reads go to publicnode, which gives no receipts (chain.js): tx.wait() would never return
    const send = wc.request.bind(wc); // a phone does not switch to the wallet app by itself: while a request waits there, say so and offer a button that opens it
    wc.request = async (a) => { if (!a || !NEEDS_WALLET.has(a.method)) return send(a); showConfirm(); try { return await send(a); } finally { hideConfirm(); } };
  }
  return wc;
}

/** the provider to use, connecting through WalletConnect when nothing is injected; null when neither is possible */
export async function walletProvider() {
  if (window.ethereum && !window.ethereum.isTapeWalletConnect) return window.ethereum;
  const p = await walletConnect();
  if (!p) return null;
  if (!p.session) { try { await p.connect(); } finally { hidePairing(); } } // our own pairing box: QR code, or the wallet app on a phone
  p.isTapeWalletConnect = true;
  window.ethereum = p; // from here on the pages treat it like an injected wallet
  return p;
}

/** forget the connected wallet so the next connect asks again: WalletConnect ends its session, an injected wallet drops the site's permission where it can */
export async function forgetWallet() {
  if (wc && window.ethereum === wc) { try { await wc.disconnect(); } catch {} wc = null; delete window.ethereum; return; }
  if (window.ethereum) { try { await window.ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {} }
}

/** a WalletConnect session left from last time, restored without asking; null if none */
export async function restoreWallet() {
  if (window.ethereum) return window.ethereum;
  if (!window.TAPE_WC_PROJECT) return null;
  let had = false; try { had = Object.keys(localStorage).some((k) => k.startsWith('wc@2:client')); } catch {}
  if (!had) return null;
  const p = await walletConnect();
  if (!p || !p.session) return null;
  p.isTapeWalletConnect = true;
  window.ethereum = p;
  return p;
}

/** what to tell someone who has no wallet in this browser */
export function noWalletHint() {
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (window.TAPE_WC_PROJECT) return t('没有检测到钱包，点「连接钱包」用 WalletConnect 扫码或跳到钱包 App', 'No wallet in this browser: press "Connect wallet" to use WalletConnect (QR code, or your wallet app)');
  return mobile ? t('手机上请用钱包 App 里的浏览器打开这个地址（MetaMask、Trust、OKX 都有）', 'On a phone, open this address inside your wallet app\'s browser (MetaMask, Trust, OKX all have one)') : t('没有检测到钱包，先装 MetaMask 之类的浏览器扩展', 'No wallet detected: install a browser wallet such as MetaMask');
}

// ---- the pairing box: a QR code for another device, buttons that jump into wallet apps on a phone, the raw link to copy ----
const WALLETS = [ // universal links every major wallet app registers for WalletConnect pairing
  ['MetaMask', (u) => 'https://metamask.app.link/wc?uri=' + encodeURIComponent(u)],
  ['Trust Wallet', (u) => 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(u)],
  ['OKX Wallet', (u) => 'okx://main/wc?uri=' + encodeURIComponent(u)],
]; // other wallets: copy the link below and paste it into the app's WalletConnect screen
async function showPairing(uri) {
  hidePairing();
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const box = document.createElement('div'); box.id = 'wcbox';
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#000000b3;display:flex;align-items:center;justify-content:center;padding:16px';
  const card = document.createElement('div');
  card.style.cssText = 'background:#141a22;color:#ece7d8;border:1px solid #273040;border-radius:16px;padding:20px 22px;max-width:360px;width:100%;text-align:center;font:15px/1.5 -apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif';
  const title = document.createElement('div'); title.style.cssText = 'font-weight:800;font-size:17px;margin-bottom:8px'; title.textContent = t('连接钱包', 'Connect a wallet');
  const hint = document.createElement('div'); hint.style.cssText = 'color:#8b94a3;font-size:13px;margin-bottom:12px';
  hint.textContent = mobile ? t('选你手机上装的钱包，授权后回到这个页面', 'Pick the wallet app on this phone, approve, then come back to this page') : t('用手机钱包扫码（MetaMask、Trust、OKX 等），或复制链接', 'Scan with a wallet app on your phone (MetaMask, Trust, OKX…), or copy the link');
  card.append(title, hint);
  if (!mobile) { const img = document.createElement('img'); img.style.cssText = 'width:240px;height:240px;border-radius:12px;background:#fff;padding:8px'; img.src = await lib.qrDataURL(uri, { margin: 0, width: 480 }); card.append(img); }
  const btns = document.createElement('div'); btns.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px';
  if (mobile) for (const [name, link] of WALLETS) { const a = document.createElement('a'); a.href = link(uri); a.textContent = name; a.style.cssText = 'display:block;padding:11px;border-radius:10px;background:linear-gradient(180deg,#f5d77a,#e2b13c);color:#1a1200;font-weight:700;text-decoration:none'; btns.append(a); }
  const copy = document.createElement('button'); copy.textContent = t('复制连接链接', 'Copy the link'); copy.style.cssText = 'padding:9px;border-radius:10px;border:1px solid #273040;background:#ffffff0a;color:#ece7d8;cursor:pointer';
  copy.onclick = () => { navigator.clipboard.writeText(uri).then(() => (copy.textContent = t('已复制', 'Copied'))); };
  const close = document.createElement('button'); close.textContent = t('取消', 'Cancel'); close.style.cssText = 'padding:9px;border-radius:10px;border:0;background:transparent;color:#8b94a3;cursor:pointer';
  close.onclick = () => { hidePairing(); try { wc.disconnect(); } catch {} };
  btns.append(copy, close); card.append(btns); box.append(card); document.body.append(box);
}
function hidePairing() { const b = document.getElementById('wcbox'); if (b) b.remove(); }

// ---- a request waiting in the wallet: a note at the bottom, with a button into the wallet app on a phone ----
const NEEDS_WALLET = new Set(['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
function walletLink() { // the paired app's own link back in, else the known ones by name
  const m = wc && wc.session && wc.session.peer && wc.session.peer.metadata;
  if (!m) return null;
  if (m.redirect && (m.redirect.native || m.redirect.universal)) return m.redirect.native || m.redirect.universal;
  const name = `${m.name || ''} ${m.url || ''}`;
  return /metamask/i.test(name) ? 'https://metamask.app.link' : /trust/i.test(name) ? 'https://link.trustwallet.com' : /okx|okex/i.test(name) ? 'okx://main' : null;
}
let waitingN = 0;
function showConfirm() {
  waitingN++;
  if (document.getElementById('wcwait')) return;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent), link = mobile ? walletLink() : null;
  const box = document.createElement('div'); box.id = 'wcwait';
  box.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:1000;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:#141a22f5;border:1px solid #e2b13c;box-shadow:0 10px 30px #000c;color:#ece7d8;font:14px/1.4 -apple-system,"PingFang SC",sans-serif;max-width:calc(100vw - 24px)';
  const txt = document.createElement('span'); txt.textContent = mobile ? t('请到钱包 App 里确认', 'Confirm it in your wallet app') : t('请在手机钱包里确认', 'Confirm it in the wallet on your phone');
  box.append(txt);
  if (link) { const a = document.createElement('a'); a.href = link; a.textContent = t('打开钱包', 'Open the wallet'); a.style.cssText = 'flex:none;padding:9px 14px;border-radius:10px;background:linear-gradient(180deg,#f5d77a,#e2b13c);color:#1a1200;font-weight:800;text-decoration:none'; box.append(a); }
  document.body.append(box);
}
function hideConfirm() { waitingN = Math.max(0, waitingN - 1); if (!waitingN) { const b = document.getElementById('wcwait'); if (b) b.remove(); } }

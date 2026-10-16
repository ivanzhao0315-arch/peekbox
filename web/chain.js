// Chain plumbing: the known mainnets, which node to read. Everything is paid in the chain's own coin.
// blockSec: seconds a block, for "claim within ~N hours" (the chain keeps 8191 block hashes)
export const CHAINS = {
  56: { name: 'BNB Chain', currency: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com', blockSec: 0.75, decimals: 18 },
  196: { name: 'X Layer', currency: 'OKB', rpc: 'https://rpc.xlayer.tech', explorer: 'https://www.oklink.com/x-layer', blockSec: 1, decimals: 18 },
};
export const CHAIN = CHAINS[window.TAPE_CHAIN_ID] || { name: 'Local', currency: 'OKB', rpc: 'http://127.0.0.1:8547', explorer: '', blockSec: 1, decimals: 18 };
export const MAINNET = !!CHAINS[window.TAPE_CHAIN_ID];
// ?rpc= is for local testing only: on mainnet a link must not decide which node the page believes
export const rpcUrl = (q) => (!MAINNET && q.get('rpc')) || window.TAPE_RPC || CHAIN.rpc;
// publicnode answers every eth_getTransactionReceipt with "Archive requests require a personal token" (2026-09-23), so a transaction
// sent through it never confirms. Receipts come from nodes that serve them.
export const RECEIPT_RPCS = ['https://bsc.blockrazor.xyz', 'https://1rpc.io/bnb'];
export async function receiptFrom(params) {
  let last = '';
  for (const u of RECEIPT_RPCS) {
    try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params }) })).json(); if (!j.error) return j.result; last = j.error.message; } catch (e) { last = e.message; }
  }
  throw new Error('no node gave the receipt: ' + last);
}
/** a read provider for rpcUrl(); on publicnode its receipt lookups go to RECEIPT_RPCS */
export function readProvider(url) {
  const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 10 }); // rpc.xlayer.tech refuses batches over 10 (-32014)
  if (/publicnode\.com/.test(url)) { const send = p.send.bind(p); p.send = (method, params) => (method === 'eth_getTransactionReceipt' ? receiptFrom(params) : send(method, params)); }
  return p;
}
/** asks the wallet to switch to the site's chain, adding it first when the wallet does not know it (X Layer in MetaMask) */
export async function switchChain(eth) {
  const id = '0x' + window.TAPE_CHAIN_ID.toString(16);
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] }); } catch (e) {
    if (!MAINNET || (e.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e.message || ''))) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: id, chainName: CHAIN.name, nativeCurrency: { name: CHAIN.currency, symbol: CHAIN.currency, decimals: CHAIN.decimals }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }] });
  }
}

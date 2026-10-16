// Local playground: anvil (port 8547, a block a second) + a MeowBox in native coin (shown as OKB) with three sample ads
// (plus one waiting for review) + the site on http://127.0.0.1:8820/ (--port to change). Account #1 is the owner (reviews ads,
// gets the 5%), #2 the advertiser; import a printed key into a wallet (network http://127.0.0.1:8547, chainId 31337), or let the
// page's test stub use it.
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOUNDRY = process.env.FOUNDRY_BIN || path.join(os.homedir(), '.foundry', 'bin');
const portArg = process.argv.indexOf('--port'), PORT = portArg >= 0 ? process.argv[portArg + 1] : (process.env.PORT || '8820');
const RPC = 'http://127.0.0.1:8547';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mn = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const acct = (i) => ethers.HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${i}`);
const procs = [];
const stop = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// children run under a tiny shell watchdog so they die with this process even on SIGKILL
const child = (cmd, args, opts) => spawn('sh', ['-c', 'exec "$@" & p=$!; while kill -0 $PPID 2>/dev/null; do sleep 1; done; kill $p', 'sh', cmd, ...args], opts);

procs.push(child(path.join(FOUNDRY, 'anvil'), ['--port', '8547', '--accounts', '20', '--block-time', '1', '--silent'], { stdio: 'ignore' }));
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
for (let i = 0; i < 50; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(200); } }

const owner = acct(1), adv = acct(2), players = Array.from({ length: 4 }, (_, i) => acct(3 + i));
const out = execFileSync(path.join(FOUNDRY, 'forge'), ['script', 'script/DeployLocal.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', acct(0).privateKey], {
  cwd: path.join(__dirname, '..', 'contracts'), encoding: 'utf8',
  env: { ...process.env, OWNER: owner.address, ADVERTISER_KEY: adv.privateKey },
});
const box = out.match(/MeowBox\s+(0x[0-9a-fA-F]{40})/)[1];
procs.push(child('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT, TAPE_BOX: box, TAPE_RPC: RPC, TAPE_CHAIN_ID: '31337' }, stdio: 'inherit' }));
console.log(`
  site            http://127.0.0.1:${PORT}/
  MeowBox         ${box}
  wallet network  ${RPC}  chainId 31337
  owner      #1 ${owner.address}  ${owner.privateKey}
  advertiser #2 ${adv.address}  ${adv.privateKey}
  player keys (anvil gives each 10000 coins, shown as OKB):
${players.map((p, i) => `    #${i + 3} ${p.address}  ${p.privateKey}`).join('\n')}
  Ctrl-C stops everything.
`);

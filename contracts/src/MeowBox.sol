// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// 瞄一箱 PeekBox: one box, swipe to open it, watch an ad, maybe win. Advertisers put money in (the chain's native coin: OKB on X
/// Layer), at least `minDeposit` at a time: 5% to the owner, 95% straight into the public prize pool. An ad stays forever (nobody, the
/// owner included, can take it down or get its money back), and anyone can add to it; each opening shows one ad, picked with
/// weight = all the money put into it, so spending more buys more of the views.
///
/// Every box is one draw over four tiers, rarest first: the jackpot (`jackpotBps` of the pool), then three fixed prizes. The
/// chances are parts per million. They are set so that a box's average prize stays under the gas it costs to open (both in OKB,
/// so the coin's price does not matter), which is what keeps scripts from farming the pool when nobody's identity is checked. A tier the pool cannot pay counts as empty (the
/// money stays in the pool). The pool only ever leaves as prizes.
///
/// Randomness without a server: an opening names the next block, and the box is settled by its opener's next open() or
/// claim(), from that block's hash (blockhash, then EIP-2935 for 8191 blocks). A box whose hash is gone by then is empty.
/// A wallet opens at most one box per `gap` seconds (the time an ad plays), and is never shown the same ad twice in a day (UTC).
///
/// Session keys: a wallet authorizes a throwaway key (and can hand it gas in the same call); the key then opens and claims for
/// that wallet without wallet pop-ups, until it expires. Everything is kept and paid under the wallet, never the key.
contract MeowBox {
    uint256 public constant FEE_BPS = 500; // the owner's cut of every deposit
    uint256 public constant RECENT = 20; // wins kept for the page
    uint256 public constant TRIES = 8; // picks before giving up on finding an ad the wallet has not seen today
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935; // EIP-2935: hashes of the last 8191 blocks

    struct Ad {
        address owner; uint96 spent; // spent: everything put into this ad, its pick weight
        uint32 views; uint32 clicks; uint40 created;
        string title; string body; string link; string video; // video: an https video file, or ""
    }
    struct Box { uint32 ad; uint64 target; } // a wallet's last opening, not settled yet (ad 0 = none)
    struct Win { address user; uint32 ad; uint8 tier; uint40 time; uint256 amount; }
    struct Session { address user; uint64 until; } // a session key's wallet, and when it stops working

    address public immutable owner; // gets the 5%; has no other power
    uint96 public immutable minDeposit;
    uint32 public immutable gap; // seconds a wallet waits between openings
    uint16 public immutable jackpotBps; // tier 0 pays this share of the pool
    uint96 public immutable prize1; uint96 public immutable prize2; uint96 public immutable prize3; // tiers 1–3, biggest first
    uint32 public immutable ppm0; uint32 public immutable ppm1; uint32 public immutable ppm2; uint32 public immutable ppm3; // chances per million

    uint256 public pool; // prizes come out of this and nothing else
    uint256 public fees; // the owner's 5%, not collected yet
    uint256 public raised; // everything advertisers ever put in
    uint256 public opens;
    uint256 public paid;
    uint256 public wins;
    Ad[] internal _ads; // _ads[0] is a placeholder: ids start at 1
    uint256[] internal _tree; // Fenwick tree over the ads' spent, 1-based like the ids (_tree[0] unused)
    Win[RECENT] internal _recent;
    mapping(address => Box) public boxOf;
    mapping(address => uint256) public lastOpen; // wallet => when it last opened a box
    mapping(uint256 => mapping(address => uint256)) public seenDay; // ad => wallet => the UTC day (+1) it was last shown to them
    mapping(address => Session) public sessionOf; // key => its wallet; a key belongs to one wallet for good

    event Published(uint256 indexed id, address indexed advertiser);
    event Deposited(uint256 indexed id, address indexed from, uint256 amount);
    event Opened(uint256 indexed id, address indexed user, uint256 target);
    event Clicked(uint256 indexed id, address indexed user);
    event Won(uint256 indexed id, address indexed user, uint256 tier, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event Authorized(address indexed user, address indexed key, uint256 until);

    error BadConfig(); error BadAd(); error NotAllowed(); error Closed(); error Expired(); error SeenAll(); error TooSoon(); error NothingToDo(); error TransferFailed(); error Busy();

    uint256 private _lock = 1;
    /// prizes and fees go out as plain value transfers to whoever receives them; nothing re-enters while one is under way
    modifier locked() { if (_lock != 1) revert Busy(); _lock = 2; _; _lock = 1; }

    /// prizes: tiers 1–3 (fixed amounts, biggest first); ppm: tiers 0–3 chances per million
    constructor(address owner_, uint96 minDeposit_, uint32 gap_, uint16 jackpotBps_, uint96[3] memory prizes, uint32[4] memory ppm) {
        if (owner_ == address(0) || minDeposit_ < 20 || jackpotBps_ > 10000
            || uint256(ppm[0]) + ppm[1] + ppm[2] + ppm[3] > 1_000_000) revert BadConfig(); // minDeposit ≥ 20 wei: the 5% is never 0
        owner = owner_; minDeposit = minDeposit_; gap = gap_; jackpotBps = jackpotBps_;
        (prize1, prize2, prize3) = (prizes[0], prizes[1], prizes[2]);
        (ppm0, ppm1, ppm2, ppm3) = (ppm[0], ppm[1], ppm[2], ppm[3]);
        _ads.push();
        _tree.push();
    }

    /// A new ad, live for good, with its first deposit (the OKB sent).
    function publish(string calldata title, string calldata body, string calldata link, string calldata video)
        external payable returns (uint256 id)
    {
        if (bytes(title).length == 0 || bytes(title).length > 80 || bytes(body).length > 280 || bytes(link).length > 300 || !_https(link)
            || bytes(video).length > 300 || (bytes(video).length != 0 && !_https(video))) revert BadAd();
        id = _ads.length;
        _ads.push(Ad(msg.sender, 0, 0, 0, uint40(block.timestamp), title, body, link, video));
        _tree.push(); // a new leaf: it covers (id - lowbit(id), id], whose earlier part is a prefix difference
        uint256 low = id & (~id + 1);
        _tree[id] = _prefix(id - 1) - _prefix(id - low);
        emit Published(id, msg.sender);
        _deposit(id, msg.value);
    }

    /// Anyone puts more OKB into an ad: more weight, more views. 95% into the pool, 5% to the owner, no way back.
    function deposit(uint256 id) external payable {
        _ad(id);
        _deposit(id, msg.value);
    }

    function _deposit(uint256 id, uint256 amount) internal {
        if (amount < minDeposit || amount > type(uint96).max - _ads[id].spent) revert BadAd();
        uint256 fee = amount * FEE_BPS / 10000;
        _ads[id].spent += uint96(amount);
        uint256 n = _tree.length;
        for (uint256 i = id; i < n; i += i & (~i + 1)) _tree[i] += amount;
        fees += fee; pool += amount - fee; raised += amount;
        emit Deposited(id, msg.sender, amount);
    }

    /// The caller (a wallet) lets `key` open and claim for it until `until`; any OKB sent goes on to the key as its gas. The key
    /// agrees by signing keyMessage(caller) (so nobody can make someone else's wallet their key). A key belongs to the first
    /// wallet that authorizes it, for good: that wallet can extend it, or end it with `until` 0.
    function authorize(address key, uint64 until, uint8 v, bytes32 r, bytes32 s) external payable locked {
        Session storage k = sessionOf[key];
        if (key == address(0) || key == msg.sender || (k.user != address(0) && k.user != msg.sender)) revert NotAllowed();
        if (ecrecover(keyMessage(msg.sender), v, r, s) != key) revert NotAllowed();
        k.user = msg.sender; k.until = until;
        emit Authorized(msg.sender, key, until);
        if (msg.value != 0) { (bool ok,) = key.call{value: msg.value}(""); if (!ok) revert TransferFailed(); } // slither-disable-line arbitrary-send-eth
    }

    /// Settles my last box first (`clicked`: I followed its link, counted once), then opens the box for me: an ad I have not
    /// seen today, picked with weight = its money. Called by the wallet, or by a session key for it.
    function open(bool clicked) external locked {
        address user = _user();
        uint256 won = _settle(user, clicked);
        if (_ads.length == 1) revert Closed();
        if (block.timestamp < lastOpen[user] + gap) revert TooSoon();
        lastOpen[user] = block.timestamp;
        uint256 today = block.timestamp / 1 days + 1;
        uint256 id = _pick(user, today);
        seenDay[id][user] = today;
        _ads[id].views++;
        opens++;
        boxOf[user] = Box(uint32(id), uint64(block.number + 1));
        emit Opened(id, user, block.number + 1);
        _send(user, won); // token calls come last
    }

    /// Settles my last box (paying its prize, if it won) without opening another. Wallet or session key.
    function claim(bool clicked) external locked {
        address user = _user();
        if (boxOf[user].ad == 0) revert NothingToDo();
        _send(user, _settle(user, clicked));
    }

    /// Anyone adds OKB to the prize pool without an ad.
    function fund() external payable {
        if (msg.value == 0) revert BadConfig();
        pool += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// Anyone sends the collected 5% to the owner.
    function collect() external locked {
        uint256 f = fees;
        fees = 0;
        _send(owner, f);
    }

    /// what a session key signs (EIP-191 personal_sign of "PeekBox session" bound to this chain, contract and wallet)
    function keyMessage(address user) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode("PeekBox session", block.chainid, address(this), user))));
    }

    /// the tier a roll in [0, 1e6) lands in (0 = jackpot … 3 = smallest), 4 = no prize
    function tierOf(uint256 roll) public view returns (uint256) {
        uint256 edge = ppm0;
        if (roll < edge) return 0;
        if (roll < (edge += ppm1)) return 1;
        if (roll < (edge += ppm2)) return 2;
        if (roll < edge + ppm3) return 3;
        return 4;
    }

    /// what tier `tier` pays with the pool as it is now; 0 when the pool cannot pay it
    function prizeOf(uint256 tier) public view returns (uint256 a) {
        a = tier == 0 ? pool * jackpotBps / 10000 : tier == 1 ? prize1 : tier == 2 ? prize2 : tier == 3 ? prize3 : 0;
        if (a > pool) a = 0;
    }

    function adCount() external view returns (uint256) { return _ads.length - 1; }

    /// ads from..to (inclusive) in one call, so the page needs no event scan
    function ads(uint256 from, uint256 to) external view returns (Ad[] memory list) {
        list = new Ad[](to + 1 - from);
        for (uint256 i; i < list.length; i++) list[i] = _ad(from + i);
    }

    /// the last wins, newest first
    function recent() external view returns (Win[] memory list) {
        uint256 n = wins < RECENT ? wins : RECENT;
        list = new Win[](n);
        for (uint256 i; i < n; i++) list[i] = _recent[(wins - 1 - i) % RECENT];
    }

    /// what `user`'s box pays if settled now (tier 4, amount 0: nothing); the page shows it before the claim
    function pending(address user) external view returns (uint256 tier, uint256 amount) {
        Box memory b = boxOf[user];
        if (b.ad == 0 || block.number <= b.target) return (4, 0);
        tier = _tier(user, b);
        amount = prizeOf(tier);
    }

    /// the wallet a call acts for: a live session key's wallet, else the caller; an expired key acts for nobody
    function _user() internal view returns (address) {
        Session memory k = sessionOf[msg.sender];
        if (k.user == address(0)) return msg.sender;
        if (block.timestamp > k.until) revert Expired();
        return k.user;
    }

    function _settle(address user, bool clicked) internal returns (uint256 amount) {
        Box memory b = boxOf[user];
        if (b.ad == 0) return 0;
        if (block.number <= b.target) revert TooSoon(); // its block is not out yet
        delete boxOf[user];
        if (clicked) { _ads[b.ad].clicks++; emit Clicked(b.ad, user); }
        uint256 tier = _tier(user, b);
        amount = prizeOf(tier);
        if (amount == 0) return 0;
        pool -= amount; paid += amount;
        _recent[wins % RECENT] = Win(user, b.ad, uint8(tier), uint40(block.timestamp), amount);
        wins++;
        emit Won(b.ad, user, tier, amount);
    }

    /// ponytail: the random number is the hash of a block that did not exist when the box was opened. Whoever produces that
    /// block (the X Layer sequencer, a BSC validator) could grind it; with prizes worth that trouble, switch to a VRF.
    function _tier(address user, Box memory b) internal view returns (uint256) {
        bytes32 h = _hash(b.target);
        if (h == 0) return 4;
        // slither-disable-next-line weak-prng
        return tierOf(uint256(keccak256(abi.encode(h, address(this), user, b.target))) % 1_000_000);
    }

    /// An ad `user` has not seen today, picked with weight = its money: up to TRIES weighted picks, skipping seen ones.
    /// ponytail: with most ads already seen, it can give up while one is left; the page says "try again" for SeenAll.
    /// The pick only decides which ad is shown (from the last block's hash): who wins is decided by the next block.
    function _pick(address user, uint256 today) internal view returns (uint256) {
        uint256 total = _prefix(_tree.length - 1);
        bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1), user, opens));
        for (uint256 i; i < TRIES; i++) {
            // slither-disable-next-line weak-prng
            uint256 id = _find(uint256(keccak256(abi.encode(seed, i))) % total);
            if (seenDay[id][user] != today) return id;
        }
        revert SeenAll();
    }

    /// sum of spent over ads 1..i
    function _prefix(uint256 i) internal view returns (uint256 sum) {
        for (; i > 0; i -= i & (~i + 1)) sum += _tree[i];
    }

    /// the ad whose slice of [0, total) holds r
    function _find(uint256 r) internal view returns (uint256 pos) {
        uint256 n = _tree.length - 1;
        uint256 step = 1;
        while (step <= n) step <<= 1;
        for (step >>= 1; step > 0; step >>= 1) {
            if (pos + step <= n && _tree[pos + step] <= r) { pos += step; r -= _tree[pos]; }
        }
        return pos + 1;
    }

    function _ad(uint256 id) internal view returns (Ad storage) {
        if (id == 0 || id >= _ads.length) revert BadAd();
        return _ads[id];
    }

    function _https(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        return b.length > 8 && bytes8(b[:8]) == "https://";
    }

    /// blockhash for the last 256 blocks, the EIP-2935 contract for the 8191 before; 0 when neither has it
    function _hash(uint256 n) internal view returns (bytes32 h) {
        h = blockhash(n);
        if (h != 0) return h;
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        // the receiver is only ever the wallet a box was opened for, the owner, or a session key: never a caller-chosen address
        // slither-disable-next-line arbitrary-send-eth
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

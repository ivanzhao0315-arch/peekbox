// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {MeowBox} from "../src/MeowBox.sol";

/// Stands in for the EIP-2935 history contract: a hash per block number, zero when unknown.
contract MockHistory {
    mapping(uint256 => bytes32) public hashes;
    function set(uint256 n, bytes32 h) external { hashes[n] = h; }
    fallback(bytes calldata data) external returns (bytes memory) { return abi.encode(hashes[abi.decode(data, (uint256))]); }
}

/// Opens up the weighted pick's tree.
contract TreeHarness is MeowBox {
    constructor() MeowBox(address(1), 0.001 ether, 8, 2000, [uint96(0.1 ether), 0.01 ether, 0.001 ether], [uint32(1), 5, 50, 1000]) {}
    function find(uint256 r) external view returns (uint256) { return _find(r); }
    function prefix(uint256 i) external view returns (uint256) { return _prefix(i); }
}

/// A winner whose wallet refuses OKB, and tries to re-enter when paid.
contract Grabby {
    MeowBox public b;
    bool public reenter;
    constructor(MeowBox b_) { b = b_; }
    function open() external { b.open(false); }
    function claim(bool again) external { reenter = again; b.claim(false); }
    receive() external payable { if (reenter) b.claim(false); }
}

/// Amounts in OKB (18 decimals): at least 0.001 a deposit; prizes 0.1 / 0.01 / 0.001 and the jackpot = 20% of the pool, at
/// 1 / 5 / 50 / 1000 per million (the anti-farming tiers); one opening per 8 s a wallet.
contract MeowBoxTest is Test {
    MeowBox box;
    address owner = makeAddr("owner");
    address adv = makeAddr("advertiser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint32 constant GAP = 8;
    uint96 constant MIN = 0.001 ether;
    uint96[3] PRIZES = [uint96(0.1 ether), 0.01 ether, 0.001 ether];
    uint32[4] PPM = [uint32(1), 5, 50, 1000];

    function setUp() public {
        vm.warp(1_750_000_000);
        vm.roll(1000);
        for (uint256 i; i < 4; i++) vm.deal([adv, alice, bob, owner][i], 1000 ether);
        box = _box(PPM);
    }

    function _box(uint32[4] memory ppm) internal returns (MeowBox) {
        return new MeowBox(owner, MIN, GAP, 2000, PRIZES, ppm);
    }

    function _publish(MeowBox b, uint256 amount) internal returns (uint256 id) {
        vm.prank(adv);
        id = b.publish{value: amount}("Meow App", "the best cat app", "https://apps.apple.com/app/id1", "");
    }

    /// a hash for which `user`'s box at `target` lands in `tier` (cheap only for the generous test tiers)
    function _hashFor(MeowBox b, address user, uint256 target, uint256 tier) internal view returns (bytes32 h) {
        for (uint256 i;; i++) {
            h = keccak256(abi.encode(user, target, i));
            if (b.tierOf(uint256(keccak256(abi.encode(h, address(b), user, target))) % 1_000_000) == tier) return h;
        }
    }

    /// opens a box for `user` and mines its block so that it lands in `tier`; returns the ad shown
    function _open(MeowBox b, address user, uint256 tier) internal returns (uint256 id) {
        vm.warp(block.timestamp + GAP);
        vm.prank(user);
        b.open(false);
        (uint32 ad, uint64 target) = b.boxOf(user);
        id = ad;
        vm.roll(target + 1);
        vm.setBlockhash(target, _hashFor(b, user, target, tier));
    }

    function _conserved(MeowBox b) internal view {
        assertEq(address(b).balance, b.pool() + b.fees(), "every wei is in the pool or the fee");
    }

    function test_depositSplitsNinetyFiveFive() public {
        uint256 id = _publish(box, 2 ether);
        assertEq(box.pool(), 1.9 ether);
        assertEq(box.fees(), 0.1 ether);
        assertEq(box.raised(), 2 ether);
        vm.prank(bob); // anyone can add to any ad
        box.deposit{value: 1 ether}(id);
        assertEq(box.ads(id, id)[0].spent, 3 ether);
        assertEq(box.pool(), 1.9 ether + 0.95 ether);
        uint256 before = owner.balance;
        box.collect();
        assertEq(owner.balance - before, 0.15 ether);
        _conserved(box);
    }

    function test_minimumDeposit() public {
        vm.expectRevert(MeowBox.BadAd.selector);
        _publish(box, MIN - 1);
        uint256 id = _publish(box, MIN);
        vm.expectRevert(MeowBox.BadAd.selector);
        vm.prank(bob);
        box.deposit{value: MIN - 1}(id);
        vm.expectRevert(MeowBox.BadAd.selector);
        vm.prank(bob);
        box.deposit{value: MIN}(99);
    }

    function test_tiersAreDisjointRarestFirst() public view {
        assertEq(box.tierOf(0), 0);
        assertEq(box.tierOf(1), 1);
        assertEq(box.tierOf(5), 1);
        assertEq(box.tierOf(6), 2);
        assertEq(box.tierOf(55), 2);
        assertEq(box.tierOf(56), 3);
        assertEq(box.tierOf(1055), 3);
        assertEq(box.tierOf(1056), 4);
        assertEq(box.tierOf(999_999), 4);
    }

    function test_averagePrizeUnderTheGasOfABox() public view {
        // fixed tiers: 0.1 × 5/1e6 + 0.01 × 50/1e6 + 0.001 × 1000/1e6 = 0.000002 OKB a box (plus 20% of the pool × 1/1e6);
        // an opening is ~174k gas, 0.0000035 OKB at X Layer's 0.02 gwei
        uint256 fixedEv = (uint256(PRIZES[0]) * PPM[1] + uint256(PRIZES[1]) * PPM[2] + uint256(PRIZES[2]) * PPM[3]) / 1_000_000;
        assertEq(fixedEv, 0.000002 ether);
        assertLt(fixedEv, 174_000 * 0.02 gwei);
    }

    function test_everyTierPays() public {
        MeowBox b = _box([uint32(250_000), 250_000, 250_000, 250_000]); // every box wins something: each tier is quick to hit
        _publish(b, 10 ether); // pool 9.5
        uint256[4] memory want = [uint256(0), 0.1 ether, 0.01 ether, 0.001 ether];
        for (uint256 tier; tier < 4; tier++) {
            address u = makeAddr(string(abi.encode("t", tier)));
            _open(b, u, tier);
            uint256 pool = b.pool();
            if (tier == 0) want[0] = pool * 2000 / 10000;
            (uint256 pt, uint256 pa) = b.pending(u);
            assertEq(pt, tier);
            assertEq(pa, want[tier]);
            vm.prank(u);
            b.claim(true);
            assertEq(u.balance, want[tier], "paid to the wallet");
            assertEq(b.pool(), pool - want[tier]);
        }
        assertEq(b.wins(), 4);
        MeowBox.Win[] memory r = b.recent();
        assertEq(r[0].tier, 3);
        assertEq(r[3].tier, 0);
        _conserved(b);
    }

    function test_aTierThePoolCannotPayIsEmpty() public {
        MeowBox b = _box([uint32(0), 1_000_000, 0, 0]); // always the 0.1 OKB tier
        _publish(b, 0.01 ether); // pool 0.0095 < 0.1
        _open(b, alice, 1);
        (, uint256 a) = b.pending(alice);
        assertEq(a, 0);
        vm.prank(alice);
        b.claim(false);
        assertEq(b.pool(), 0.0095 ether, "the money stays in the pool");
        assertEq(b.wins(), 0);
    }

    function test_nextOpenSettlesTheLastAndCountsTheClick() public {
        MeowBox b = _box([uint32(0), 0, 0, 1_000_000]); // always 0.001
        _publish(b, 1 ether);
        _publish(b, 1 ether);
        uint256 id = _open(b, alice, 3);
        uint256 before = alice.balance;
        vm.warp(block.timestamp + GAP);
        vm.prank(alice);
        b.open(true); // pays the last box, records its click, opens another
        assertEq(alice.balance - before, 0.001 ether);
        assertEq(b.ads(id, id)[0].clicks, 1);
        (uint32 next,) = b.boxOf(alice);
        assertTrue(next != id, "never the same ad twice in a day");
        vm.expectRevert(MeowBox.TooSoon.selector); // the new box's block is not out yet
        vm.prank(alice);
        b.claim(false);
    }

    function test_gapBetweenOpens() public {
        for (uint256 i; i < 3; i++) _publish(box, 1 ether);
        _open(box, alice, 4);
        vm.warp(block.timestamp + GAP - 1);
        vm.expectRevert(MeowBox.TooSoon.selector);
        vm.prank(alice);
        box.open(false);
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        box.open(false);
    }

    function test_seenAllThenTomorrow() public {
        _publish(box, 1 ether);
        _publish(box, 1 ether);
        _open(box, alice, 4);
        _open(box, alice, 4);
        vm.warp(block.timestamp + GAP);
        vm.expectRevert(MeowBox.SeenAll.selector);
        vm.prank(alice);
        box.open(false);
        vm.warp(block.timestamp + 1 days);
        _open(box, alice, 4);
    }

    function test_noAdNoBox() public {
        vm.expectRevert(MeowBox.Closed.selector);
        vm.prank(alice);
        box.open(false);
    }

    function test_pickFollowsTheMoney() public {
        uint256 small = _publish(box, 0.01 ether);
        uint256 big = _publish(box, 0.99 ether); // 99× the weight
        uint256 bigShown;
        for (uint256 i; i < 40; i++) {
            address u = makeAddr(string(abi.encode(i)));
            vm.roll(block.number + 1);
            vm.setBlockhash(block.number - 1, keccak256(abi.encode("pick", i)));
            vm.prank(u);
            box.open(false);
            (uint32 ad,) = box.boxOf(u);
            if (ad == big) bigShown++;
            else assertEq(ad, small);
        }
        assertGt(bigShown, 35, "about 99% of boxes show the ad with 99% of the money");
        vm.prank(bob);
        box.deposit{value: 9.9 ether}(small); // topping up moves the weight
        assertEq(box.ads(small, small)[0].spent, 9.91 ether);
    }

    /// the tree's pick matches a plain walk over the spends, for any spends and any point
    function testFuzz_treeMatchesALinearWalk(uint256 seed) public {
        TreeHarness h = new TreeHarness();
        vm.deal(adv, 1e30);
        uint256 n = seed % 37 + 1;
        uint256[] memory spent = new uint256[](n + 1);
        for (uint256 i = 1; i <= n; i++) {
            uint256 a = MIN + uint256(keccak256(abi.encode(seed, i))) % 1e20;
            vm.prank(adv);
            h.publish{value: a}("x", "", "https://ok.example", "");
            spent[i] = a;
            if (i > 1 && uint256(keccak256(abi.encode(seed, i, "top"))) % 3 == 0) { // top up an earlier ad after later ones exist
                uint256 j = uint256(keccak256(abi.encode(seed, i, "which"))) % (i - 1) + 1;
                vm.prank(adv);
                h.deposit{value: 2 * MIN}(j);
                spent[j] += 2 * MIN;
            }
        }
        uint256 total;
        for (uint256 i = 1; i <= n; i++) total += spent[i];
        assertEq(h.prefix(n), total);
        for (uint256 k; k < 20; k++) {
            uint256 r = uint256(keccak256(abi.encode(seed, "r", k))) % total;
            uint256 want = 1;
            for (uint256 acc = spent[1]; acc <= r; acc += spent[++want]) {}
            assertEq(h.find(r), want);
        }
    }

    /// a fresh session key for `user`, signed and authorized, carrying 0.001 OKB of gas
    function _session(MeowBox b, address user, uint256 keyPk, uint64 until) internal returns (address key) {
        key = vm.addr(keyPk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyPk, b.keyMessage(user));
        vm.prank(user);
        b.authorize{value: 0.001 ether}(key, until, v, r, s);
    }

    function test_sessionKeyOpensAndPaysTheWallet() public {
        MeowBox b = _box([uint32(0), 0, 0, 1_000_000]);
        _publish(b, 1 ether);
        address key = _session(b, alice, 0xA11CE, uint64(block.timestamp + 1 days));
        assertEq(key.balance, 0.001 ether, "the gas went on to the key");
        vm.warp(block.timestamp + GAP);
        vm.prank(key);
        b.open(false);
        (uint32 ad, uint64 target) = b.boxOf(alice);
        assertTrue(ad != 0, "the box is the wallet's");
        (uint32 none,) = b.boxOf(key);
        assertEq(none, 0, "nothing under the key");
        vm.roll(target + 1);
        uint256 before = alice.balance;
        vm.prank(key);
        b.claim(true);
        assertEq(alice.balance - before, 0.001 ether, "the prize goes to the wallet");
        assertEq(key.balance, 0.001 ether, "the key keeps only its gas");
        assertGt(b.seenDay(ad, alice), 0);
    }

    function test_sessionKeyExpiresAndCanBeEnded() public {
        _publish(box, 1 ether);
        _publish(box, 1 ether);
        address key = _session(box, alice, 0xA11CE, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 101);
        vm.expectRevert(MeowBox.Expired.selector);
        vm.prank(key);
        box.open(false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA11CE, box.keyMessage(alice));
        vm.prank(alice);
        box.authorize(key, uint64(block.timestamp + 100), v, r, s); // the same wallet extends it
        vm.prank(key);
        box.open(false);
        vm.prank(alice);
        box.authorize(key, 0, v, r, s); // and ends it
        vm.warp(block.timestamp + GAP);
        vm.roll(block.number + 2);
        vm.expectRevert(MeowBox.Expired.selector);
        vm.prank(key);
        box.open(false);
    }

    function test_noOneCanTakeSomeoneElsesKeyOrWallet() public {
        address key = _session(box, alice, 0xA11CE, uint64(block.timestamp + 1 days));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA11CE, box.keyMessage(bob));
        vm.expectRevert(MeowBox.NotAllowed.selector); // alice's key, even signed again for bob, stays alice's
        vm.prank(bob);
        box.authorize(key, uint64(block.timestamp + 1 days), v, r, s);
        (v, r, s) = vm.sign(0xB0B, box.keyMessage(alice));
        vm.expectRevert(MeowBox.NotAllowed.selector); // bob cannot make alice's wallet his key: it never signed for him
        vm.prank(bob);
        box.authorize(alice, uint64(block.timestamp + 1 days), v, r, s);
        vm.expectRevert(MeowBox.NotAllowed.selector); // a signature for another wallet does not work for this one
        vm.prank(bob);
        box.authorize(vm.addr(0xB0B), uint64(block.timestamp + 1 days), v, r, s);
    }

    function test_aWinnerCannotReenter() public {
        MeowBox b = _box([uint32(0), 0, 0, 1_000_000]);
        _publish(b, 1 ether);
        Grabby g = new Grabby(b);
        vm.warp(block.timestamp + GAP);
        g.open();
        vm.roll(block.number + 2);
        vm.expectRevert(MeowBox.TransferFailed.selector); // its receive() calls claim again: the lock stops it, so the payment fails
        g.claim(true);
        g.claim(false); // without the re-entry it is paid once
        assertEq(address(g).balance, 0.001 ether);
        _conserved(b);
    }

    function test_oldHashComesFromHistory() public {
        MeowBox b = _box([uint32(0), 0, 0, 1_000_000]);
        MockHistory mock = new MockHistory();
        vm.etch(b.HISTORY(), address(mock).code);
        _publish(b, 1 ether);
        vm.warp(block.timestamp + GAP);
        vm.prank(alice);
        b.open(false);
        (, uint64 target) = b.boxOf(alice);
        vm.roll(target + 1000); // past blockhash's 256 blocks, inside the history's 8191
        MockHistory(b.HISTORY()).set(target, keccak256("old"));
        uint256 before = alice.balance;
        vm.prank(alice);
        b.claim(false);
        assertEq(alice.balance - before, 0.001 ether);
    }

    function test_lostHashIsEmpty() public {
        MeowBox b = _box([uint32(0), 0, 0, 1_000_000]); // would always win, if the hash were still there
        _publish(b, 1 ether);
        vm.warp(block.timestamp + GAP);
        vm.prank(alice);
        b.open(false);
        (, uint64 target) = b.boxOf(alice);
        vm.roll(target + 9000);
        (uint256 tier,) = b.pending(alice);
        assertEq(tier, 4);
        uint256 pool = b.pool();
        vm.prank(alice);
        b.claim(false);
        assertEq(b.pool(), pool);
        vm.expectRevert(MeowBox.NothingToDo.selector);
        vm.prank(alice);
        b.claim(false);
    }

    function test_badAds() public {
        vm.startPrank(adv);
        vm.expectRevert(MeowBox.BadAd.selector);
        box.publish{value: 1 ether}("x", "", "javascript:alert(1)", "");
        vm.expectRevert(MeowBox.BadAd.selector);
        box.publish{value: 1 ether}("x", "", "https://ok.example", "http://v.example/a.mp4");
        vm.expectRevert(MeowBox.BadAd.selector);
        box.publish{value: 1 ether}("", "", "https://ok.example", "");
        vm.expectRevert(MeowBox.BadAd.selector);
        box.publish{value: 1 ether}(string(new bytes(81)), "", "https://ok.example", "");
        box.publish{value: 1 ether}("x", "", "https://ok.example", "https://v.example/a.mp4");
        vm.stopPrank();
    }

    function test_badConfig() public {
        vm.expectRevert(MeowBox.BadConfig.selector);
        new MeowBox(owner, MIN, GAP, 2000, PRIZES, [uint32(1), 5, 50, 999_945]); // chances over 100%
        vm.expectRevert(MeowBox.BadConfig.selector);
        new MeowBox(address(0), MIN, GAP, 2000, PRIZES, PPM); // no owner
        vm.expectRevert(MeowBox.BadConfig.selector);
        new MeowBox(owner, MIN, GAP, 10001, PRIZES, PPM); // a jackpot over the pool
    }

    /// random deposits, opens, claims and days across wallets with generous tiers: every wei stays accounted for, and the prizes
    /// paid plus the pool are exactly what was funded plus what was deposited, less the 5%
    function testFuzz_conservation(uint256 seed) public {
        MeowBox b = _box([uint32(20_000), 50_000, 100_000, 200_000]);
        vm.prank(owner);
        b.fund{value: 0.5 ether}();
        for (uint256 i; i < 4; i++) _publish(b, 0.1 ether + i * 0.1 ether);
        address[3] memory us = [alice, bob, owner];
        for (uint256 step; step < 40; step++) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address u = us[r % 3];
            (uint32 pend, uint64 target) = b.boxOf(u);
            if (pend != 0) { vm.roll(target + 1); vm.setBlockhash(target, bytes32(r)); }
            if ((r >> 16) % 7 == 0) { if (pend != 0) { vm.prank(u); b.claim((r >> 24) % 2 == 0); } }
            else if ((r >> 16) % 11 == 1) { vm.prank(bob); b.deposit{value: MIN + (r >> 40) % 0.1 ether}((r >> 8) % 4 + 1); }
            else { vm.prank(u); try b.open((r >> 24) % 2 == 0) {} catch {} }
            vm.warp(block.timestamp + GAP);
            if ((r >> 32) % 5 == 0) vm.warp(block.timestamp + 1 days);
            _conserved(b);
        }
        assertEq(b.paid() + b.pool(), 0.5 ether + b.raised() - b.fees());
    }
}

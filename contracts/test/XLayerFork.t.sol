// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {MeowBox} from "../src/MeowBox.sol";

/// On a fork of X Layer: the whole flow in OKB, with the fee paid out to the real owner wallet (an EIP-7702 account, so a plain
/// value call to it must go through). forge test --match-contract XLayerFork --fork-url https://rpc.xlayer.tech (skipped elsewhere)
contract XLayerForkTest is Test {
    address owner = 0xAAB5fDD295F6d5fF8C874c7ad74889F5Ae9ea9b1;

    function test_fullFlowInOkb() public {
        if (block.chainid != 196) return;
        MeowBox b = new MeowBox(owner, 0.001 ether, 8, 2000, [uint96(0.1 ether), 0.01 ether, 0.001 ether], [uint32(0), 0, 0, 1_000_000]); // always the smallest tier: the payout runs
        address adv = makeAddr("adv");
        address user = makeAddr("user");
        vm.deal(adv, 1 ether);
        vm.prank(adv);
        b.publish{value: 0.1 ether}("ad", "", "https://example.com", "");
        vm.warp(block.timestamp + 8);
        vm.prank(user);
        b.open(false);
        vm.roll(block.number + 2);
        vm.prank(user);
        b.claim(true);
        assertEq(user.balance, 0.001 ether);
        uint256 before = owner.balance;
        b.collect();
        assertEq(owner.balance - before, 0.005 ether, "the 5% reached the owner wallet");
        assertEq(address(b).balance, b.pool() + b.fees());
    }
}

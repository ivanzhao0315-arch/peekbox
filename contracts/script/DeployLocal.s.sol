// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {MeowBox} from "../src/MeowBox.sol";

/// Local anvil: a MeowBox in native coin owned by OWNER, with the mainnet tiers (0.1 / 0.01 / 0.001 OKB and 20% of the pool) but
/// 100× the chances so a test session sees wins, one box per 8 s, at least 0.001 a deposit; three sample ads paid by ADVERTISER
/// (one with a CC0 sample video). env: OWNER, ADVERTISER_KEY. Players use anvil's own funded accounts.
contract DeployLocal is Script {
    function run() external {
        vm.startBroadcast();
        MeowBox box = new MeowBox(vm.envAddress("OWNER"), 0.001 ether, 8, 2000, [uint96(0.1 ether), 0.01 ether, 0.001 ether], [uint32(100), 500, 5000, 100000]);
        vm.stopBroadcast();
        vm.startBroadcast(vm.envUint("ADVERTISER_KEY"));
        box.publish{value: 3 ether}(unicode"喵喵德州俱乐部", unicode"链上德州扑克，BEM 现金桌，入座即开局", "https://meowtopia.club/", "");
        box.publish{value: 2 ether}(unicode"Grail Spark 手办估价", unicode"拍一张照片，识别手办并估价", "https://apps.apple.com/us/app/grail-spark/id6799032121",
            "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4");
        box.publish{value: 1 ether}(unicode"喵喵彩票", unicode"每 30 分钟开一期，奖池 90% 归中奖者", "https://lottery.meowtopia.club/", "");
        vm.stopBroadcast();
        console.log("MeowBox       ", address(box));
    }
}

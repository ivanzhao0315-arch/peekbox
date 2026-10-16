// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {MeowBox} from "../src/MeowBox.sol";

/// Mainnet: one MeowBox (native OKB). env: OWNER (gets the 5%, no other power), MIN_DEPOSIT (wei), GAP (seconds
/// between a wallet's openings), JACKPOT_BPS (the jackpot's share of the pool), PRIZES (three fixed prizes in wei, biggest first,
/// comma separated), PPM (four chances per million: jackpot, then the three prizes, comma separated).
contract Deploy is Script {
    function run() external {
        uint256[] memory p = vm.envUint("PRIZES", ",");
        uint256[] memory c = vm.envUint("PPM", ",");
        vm.startBroadcast();
        MeowBox b = new MeowBox(vm.envAddress("OWNER"), uint96(vm.envUint("MIN_DEPOSIT")), uint32(vm.envUint("GAP")),
            uint16(vm.envUint("JACKPOT_BPS")), [uint96(p[0]), uint96(p[1]), uint96(p[2])], [uint32(c[0]), uint32(c[1]), uint32(c[2]), uint32(c[3])]);
        vm.stopBroadcast();
        console.log("MeowBox       ", address(b));
    }
}

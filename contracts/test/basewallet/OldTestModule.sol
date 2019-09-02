pragma solidity ^0.5.4;

import "../../modules/common/BaseModule.sol";
import "../../modules/common/RelayerModule.sol";
import "../../modules/common/OnlyOwnerModule.sol";
import "./TestDapp.sol";
import "./OldBaseWallet.sol";

/**
 * @title OldTestModule
 * @dev Test Module
 * @author Olivier VDB - <olivier@argent.xyz>
 */
contract OldTestModule is BaseModule, RelayerModule, OnlyOwnerModule {

    bytes32 constant NAME = "OldTestModule";

    TestDapp public dapp;

    // *************** Constructor ********************** //

    constructor(
        ModuleRegistry _registry
    )
        BaseModule(_registry, NAME)
        public
    {
        dapp = new TestDapp();
    }

    // *************** External/Public Functions ********************* //

    function callDapp(OldBaseWallet _wallet)
        external
    {
        _wallet.invoke(address(dapp), 0, abi.encodeWithSignature("noReturn()", 0));
    }

}
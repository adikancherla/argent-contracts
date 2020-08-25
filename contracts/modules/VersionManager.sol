// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;

import "../infrastructure/base/Owned.sol";
import "./common/BaseModule.sol";
import "./common/OnlyOwnerFeature.sol";

/**
 * @title VersionManager
 * @notice Intermediate contract between features and wallets. VersionManager checks that a calling feature is
 * authorised for the wallet and if so, forwards the call to it.
 * @author Olivier VDB <olivier@argent.xyz>
 */
contract VersionManager is IVersionManager, BaseModule, OnlyOwnerFeature, Owned {

    bytes32 constant NAME = "VersionManager";

    uint256 public lastVersion;
    mapping(address => uint256) public walletVersions; // [wallet] => [version]
    mapping(address => mapping(uint256 => bool)) public isFeatureInVersion; // [feature][version] => bool
    mapping(uint256 => address[]) public versionFeatures; // [version] => [features]

    mapping(uint256 => bytes4[]) public staticCallSignatures; // [version] => [sigs]
    mapping(uint256 => mapping(bytes4 => address)) public staticCallExecutors; // [version][sig] => [feature]

    event VersionAdded(uint256 _version);
    event WalletUpgraded(address _wallet, uint256 _version);

    /* ***************** Modifiers ************************* */

    modifier onlyFeature(address _wallet) {
        require(isFeatureAuthorised(msg.sender, _wallet), "VM: sender should be authorized feature");
        _;
    }

    /* ***************** Constructor ************************* */

    constructor(
        IModuleRegistry _registry,
        IGuardianStorage _guardianStorage
    )
        BaseModule(_registry, NAME)
        BaseFeature(_registry, _guardianStorage, IVersionManager(address(this)), NAME)
        public
    {
    }

    /* ***************** External methods ************************* */

    function init(address _wallet) public override(BaseModule, BaseFeature) onlyWallet(_wallet) {
        doUpgradeWallet(_wallet, versionFeatures[lastVersion]);
    }

    function addVersion(address[] calldata _features) external onlyOwner {
        uint256 newVersion = ++lastVersion;
        for(uint256 i = 0; i < _features.length; i++) {
            isFeatureInVersion[_features[i]][newVersion] = true;

            // Store static call information to optimise its use by wallets
            bytes4[] memory sigs = IFeature(_features[i]).getStaticCallSignatures();
            for(uint256 j = 0; j < sigs.length; j++) {
                staticCallSignatures[newVersion].push(sigs[j]);
                staticCallExecutors[newVersion][sigs[j]] = _features[i];
            }
        }
        versionFeatures[newVersion] = _features;
        
        emit VersionAdded(newVersion);
    }

    function upgradeWallet(
        address _wallet, 
        address[] calldata _featuresToInit // it's cheaper to pass features to init as calldata than reading them from storage
    ) 
        external 
        onlyWalletOwnerOrFeature(_wallet) 
        onlyWhenUnlocked(_wallet) 
    {
        doUpgradeWallet(_wallet, _featuresToInit);
    }

    /**
     * @notice Add another module
     */
    function addModule(address _wallet, address _module) public onlyWalletOwnerOrFeature(_wallet) onlyWhenUnlocked(_wallet) {
        require(registry.isRegisteredModule(_module), "VM: module is not registered");
        IWallet(_wallet).authoriseModule(_module, true);
    }

    /**
     * @inheritdoc IVersionManager
     */
    function isFeatureAuthorised(address _wallet, address _feature) public view override returns (bool) {
        return isFeatureInVersion[_feature][walletVersions[_wallet]];
    }
    
    /**
     * @inheritdoc IVersionManager
     */
    function invokeWallet(
        address _wallet, 
        address _to, 
        uint256 _value, 
        bytes memory _data
    ) 
        external 
        onlyFeature(_wallet)
        override
        returns (bytes memory _res) 
    {
        bool success;
        (success, _res) = _wallet.call(abi.encodeWithSignature("invoke(address,uint256,bytes)", _to, _value, _data));
        if (success && _res.length > 0) { //_res is empty if _wallet is an "old" BaseWallet that can't return output values
            (_res) = abi.decode(_res, (bytes));
        } else if (_res.length > 0) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        } else if (!success) {
            revert("VM: wallet invoke reverted");
        }
    }

    /**
     * @notice Lets a feature call into a moduleOnly method (used for backward compatibility with old Storages)
     */
    function invokeVersionManager(address _wallet, address _to, bytes calldata _data) external onlyFeature(_wallet) {
        (bool success,) = _to.call(_data);
        require(success, "VM: invokeVersionManager failed");
    }

    /**
     * @notice This method delegates the static call to a target feature
     */
    fallback() external payable {
        uint256 version = walletVersions[msg.sender];
        address feature = staticCallExecutors[version][msg.sig];
        require(feature != address(0), "VM: Static call not supported for wallet version");

        // solhint-disable-next-line no-inline-assembly
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := staticcall(gas(), feature, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {revert(0, returndatasize())}
            default {return (0, returndatasize())}
        }
    }


    function doUpgradeWallet(
        address _wallet, 
        address[] memory _featuresToInit
    ) 
        internal 
    {
        uint256 fromVersion = walletVersions[_wallet];
        uint256 toVersion = lastVersion;
        require(fromVersion < toVersion, "VM: Already on last version");
        walletVersions[_wallet] = toVersion;

        // Setup static call redirection
        bytes4[] storage sigs = staticCallSignatures[toVersion];
        for(uint256 i = 0; i < sigs.length; i++) {
            IWallet(_wallet).enableStaticCall(address(this), sigs[i]);
        }
        
        // Init features
        for(uint256 i = 0; i < _featuresToInit.length; i++) {
            // The following check is there for extra security. As it's somewhat expensive, we may want to get rid of it
            if(!isFeatureInVersion[_featuresToInit[i]][fromVersion] && isFeatureInVersion[_featuresToInit[i]][toVersion]) {
                IFeature(_featuresToInit[i]).init(_wallet);
            }
        }
        
        emit WalletUpgraded(_wallet, toVersion);
    }

}
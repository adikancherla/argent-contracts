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
pragma solidity >=0.5.4 <0.7.0;

import "../../modules/common/IFeature.sol";

/**
 * @title Storage
 * @notice Base contract for the storage of a wallet.
 * @author Julien Niset - <julien@argent.xyz>, Olivier VDB - <olivier@argent.xyz>
 */
contract Storage {

    /**
     * @notice Throws if the caller is not an authorised feature.
     */
    modifier onlyFeature(address _wallet) {
        require(
            IFeature(msg.sender).isFeatureAuthorisedInVersionManager(_wallet, msg.sender), 
            "S: must be an authorized feature to call this method"
        );
        _;
    }
}
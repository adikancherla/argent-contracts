/* global artifacts */
const ethers = require("ethers");

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const RelayerModule = artifacts.require("RelayerModule");
const Registry = artifacts.require("ModuleRegistry");
const GuardianStorage = artifacts.require("GuardianStorage");
const LimitStorage = artifacts.require("LimitStorage");
const GuardianManager = artifacts.require("GuardianManager");
const ApprovedTransfer = artifacts.require("ApprovedTransfer");
const ERC20 = artifacts.require("TestERC20");
const WETH = artifacts.require("WETH9");
const TestContract = artifacts.require("TestContract");
const TestLimitModule = artifacts.require("TestLimitModule");

const TestManager = require("../utils/test-manager");
const { sortWalletByAddress, parseRelayReceipt, ETH_TOKEN, increaseTime } = require("../utils/utilities.js");

const ZERO_BYTES32 = ethers.constants.HashZero;

const WRONG_SIGNATURE_NUMBER_REVERT_MSG = "RM: Wrong number of signatures";
const INVALID_SIGNATURES_REVERT_MSG = "RM: Invalid signatures";

contract("ApprovedTransfer", (accounts) => {
  const manager = new TestManager();

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const guardian1 = accounts[2];
  const guardian2 = accounts[3];
  const guardian3 = accounts[4];
  const recipient = accounts[5];

  let deployer;
  let wallet;
  let walletImplementation;
  let guardianManager;
  let approvedTransfer;
  let limitModule;
  let relayerModule;
  let erc20;
  let weth;
  const amountToTransfer = 10000;
  let contract;

  before(async () => {
    deployer = manager.newDeployer();
    weth = await WETH.new();
    const registry = await Registry.new();
    const guardianStorage = await GuardianStorage.new();
    const limitStorage = await LimitStorage.new();
    guardianManager = await GuardianManager.new(registry.address, guardianStorage.address, 24, 12);
    approvedTransfer = await ApprovedTransfer.new(
      registry.address,
      guardianStorage.address,
      limitStorage.address,
      weth.address,
    );
    relayerModule = await RelayerModule.new(
      registry.address,
      guardianStorage.address,
      limitStorage.address,
      ethers.constants.AddressZero,
    );
    manager.setRelayerModule(relayerModule);
    walletImplementation = await BaseWallet.new();

    limitModule = await TestLimitModule.new(registry.address, guardianStorage.address, limitStorage.address);
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = BaseWallet.at(proxy.address);

    await wallet.init(owner,
      [
        approvedTransfer.address,
        guardianManager.address,
        relayerModule.address,
        limitModule.address,
      ]);

    const decimals = 12; // number of decimal for TOKN contract
    erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
    await wallet.send(50000000);
  });

  async function addGuardians(guardians) {
    // guardians can be BaseWallet or ContractWrapper objects
    const guardianAddresses = guardians.map((guardian) => {
      if (guardian) return guardian;
      return guardian.address;
    });

    for (const address of guardianAddresses) {
      await guardianManager.from(owner).addGuardian(wallet.address, address);
    }

    await increaseTime(30);
    for (let i = 1; i < guardianAddresses.length; i += 1) {
      await guardianManager.confirmGuardianAddition(wallet.address, guardianAddresses[i]);
    }
    const count = (await guardianManager.guardianCount(wallet.address)).toNumber();
    assert.equal(count, guardians.length, `${guardians.length} guardians should be added`);
  }

  async function createSmartContractGuardians(guardians) {
    const wallets = [];
    for (const g of guardians) {
      const guardianWallet = await BaseWallet.new();
      await guardianWallet.init(g, [guardianManager.address]);
      wallets.push(guardianWallet);
    }
    return wallets;
  }

  async function transferToken(_token, _signers) {
    const to = recipient;
    const before = _token === ETH_TOKEN ? await deployer.provider.getBalance(to) : await erc20.balanceOf(to);
    await manager.relay(approvedTransfer, "transferToken",
      [wallet.address, _token, to, amountToTransfer, ZERO_BYTES32], wallet, _signers);
    const after = _token === ETH_TOKEN ? await deployer.provider.getBalance(to) : await erc20.balanceOf(to);
    assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the amount");
  }

  async function callContract(_signers) {
    const before = await deployer.provider.getBalance(contract.address);
    const newState = parseInt((await contract.state()).toString(), 10) + 1;
    const dataToTransfer = contract.contract.interface.functions.setState.encode([newState]);
    await manager.relay(approvedTransfer, "callContract",
      [wallet.address, contract.address, amountToTransfer, dataToTransfer], wallet, _signers);
    const after = await deployer.provider.getBalance(contract.address);
    assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    assert.equal((await contract.state()).toNumber(), newState, "the state of the external contract should have been changed");
  }

  describe("Transfer", () => {
    async function expectFailingTransferToken(_token, _signers, _reason) {
      await assert.revertWith(
        manager.relay(
          approvedTransfer,
          "transferToken",
          [wallet.address, _token, recipient, amountToTransfer, ZERO_BYTES32],
          wallet,
          _signers,
        ), _reason,
      );
    }

    describe("Approved by EOA guardians", () => {
      describe("1 guardian", () => {
        beforeEach(async () => {
          await addGuardians([guardian1]);
        });
        it("should transfer ETH with 1 confirmation for 1 guardian", async () => {
          await transferToken(ETH_TOKEN, [owner, guardian1]);
        });
        it("should fail to transfer ETH when signer is not a guardian", async () => {
          await expectFailingTransferToken(ETH_TOKEN, [owner, guardian2], INVALID_SIGNATURES_REVERT_MSG);
        });
        it("should transfer ERC20 with 1 confirmation for 1 guardian", async () => {
          await transferToken(erc20.address, [owner, guardian1]);
        });
      });
      describe("2 guardians", () => {
        beforeEach(async () => {
          await addGuardians([guardian1, guardian2]);
        });
        it("should transfer ETH with 1 confirmation for 2 guardians", async () => {
          await transferToken(ETH_TOKEN, [owner, guardian1]);
        });
      });
      describe("3 guardians", () => {
        beforeEach(async () => {
          await addGuardians([guardian1, guardian2, guardian3]);
        });
        it("should not transfer ETH with 1 confirmation for 3 guardians", async () => {
          await expectFailingTransferToken(ETH_TOKEN, [owner, guardian1], WRONG_SIGNATURE_NUMBER_REVERT_MSG);
        });
        it("should transfer ETH with 2 confirmations for 3 guardians", async () => {
          await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        });
        it("should fail to transfer ERC20 with 1 confirmation for 3 guardians", async () => {
          await expectFailingTransferToken(erc20.address, [owner, guardian1], WRONG_SIGNATURE_NUMBER_REVERT_MSG);
        });
        it("should transfer ERC20 with 2 confirmations for 3 guardians", async () => {
          await transferToken(erc20.address, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        });
      });
    });

    describe("Approved by smart-contract guardians", () => {
      describe("1 guardian", () => {
        beforeEach(async () => {
          await addGuardians(await createSmartContractGuardians([guardian1]));
        });
        it("should transfer ETH with 1 confirmation for 1 guardian", async () => {
          await transferToken(ETH_TOKEN, [owner, guardian1]);
        });
        it("should transfer ERC20 with 1 confirmation for 1 guardian", async () => {
          await transferToken(erc20.address, [owner, guardian1]);
        });
      });
      describe("2 guardians", () => {
        beforeEach(async () => {
          await addGuardians(await createSmartContractGuardians([guardian1, guardian2]));
        });
        it("should transfer ETH with 1 confirmation for 2 guardians", async () => {
          await transferToken(ETH_TOKEN, [owner, guardian1]);
        });
      });
      describe("3 guardians", () => {
        beforeEach(async () => {
          await addGuardians(await createSmartContractGuardians([guardian1, guardian2, guardian3]));
        });
        it("should not transfer ETH with 1 confirmation for 3 guardians", async () => {
          await expectFailingTransferToken(ETH_TOKEN, [owner, guardian1], WRONG_SIGNATURE_NUMBER_REVERT_MSG);
        });
        it("should transfer ETH with 2 confirmations for 3 guardians", async () => {
          await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        });
        it("should not transfer ERC20 with 1 confirmations for 3 guardians", async () => {
          await expectFailingTransferToken(erc20.address, [owner, guardian1], WRONG_SIGNATURE_NUMBER_REVERT_MSG);
        });
        it("should transfer ERC20 with 2 confirmations for 3 guardians", async () => {
          await transferToken(erc20.address, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        });
      });
    });

    describe("Approved by EOA and smart-contract guardians", () => {
      it("should transfer ETH with 1 EOA guardian and 2 smart-contract guardians", async () => {
        await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian3])]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      });
      it("should transfer ETH with 2 EOA guardians and 1 smart-contract guardian", async () => {
        await addGuardians([guardian1, guardian2, ...await createSmartContractGuardians([guardian3])]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian1, guardian3])]);
        await transferToken(ETH_TOKEN, [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      });
    });
  });

  describe("Contract call", () => {
    describe("Approved by 1 EOA and 2 smart-contract guardians", () => {
      beforeEach(async () => {
        contract = await TestContract.new();
        assert.equal(await contract.state(), 0, "initial contract state should be 0");
        await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      });

      it("should call a contract and transfer ETH with 1 EOA guardian and 2 smart-contract guardians", async () => {
        await callContract([owner, ...sortWalletByAddress([guardian1, guardian2])]);
        await callContract([owner, ...sortWalletByAddress([guardian1, guardian3])]);
        await callContract([owner, ...sortWalletByAddress([guardian2, guardian3])]);
      });

      it("should not be able to call the wallet itself", async () => {
        const txReceipt = await manager.relay(approvedTransfer, "callContract",
          [wallet.address, wallet.address, amountToTransfer, ethers.constants.HashZero],
          wallet,
          [owner, ...sortWalletByAddress([guardian1, guardian2])]);
        const { success, error } = parseRelayReceipt(txReceipt);
        assert.isFalse(success);
        assert.equal(error, "BT: Forbidden contract");
      });
    });
  });

  describe("Approve token and Contract call", () => {
    describe("Approved by 1 EOA and 2 smart-contract guardians", () => {
      const amountToApprove = 10000;

      beforeEach(async () => {
        contract = await TestContract.new();
        assert.equal(await contract.state(), 0, "initial contract state should be 0");
        await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      });

      describe("Invalid Target", () => {
        async function expectFailingApproveTokenAndCallContract(target) {
          const invalidData = contract.contract.interface.functions.setStateAndPayToken.encode([2, erc20.address, amountToApprove]);
          const txReceipt = await manager.relay(approvedTransfer, "approveTokenAndCallContract",
            [wallet.address, erc20.address, wallet.address, amountToApprove, target.address, invalidData],
            wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
          const { success, error } = parseRelayReceipt(txReceipt);
          assert.isFalse(success);
          assert.equal(error, "BT: Forbidden contract");
        }

        it("should revert when target contract is the wallet", async () => {
          await expectFailingApproveTokenAndCallContract(wallet);
        });

        it("should revert when target contract is an authorised module", async () => {
          await expectFailingApproveTokenAndCallContract(approvedTransfer);
        });
      });

      describe("Valid Target", () => {
        async function approveTokenAndCallContract(_signers, _consumerAddress = contract.address, _wrapEth = false) {
          const newState = parseInt((await contract.state()).toString(), 10) + 1;
          const token = _wrapEth ? weth : erc20;
          const fun = _consumerAddress === contract.address ? "setStateAndPayToken" : "setStateAndPayTokenWithConsumer";
          const data = contract.contract.interface.functions[fun].encode(
            [newState, token.address, amountToApprove],
          );
          const before = await token.balanceOf(contract.address);
          const params = [wallet.address]
            .concat(_wrapEth ? [] : [erc20.address])
            .concat([_consumerAddress, amountToApprove, contract.address, data]);
          const method = _wrapEth ? "approveWethAndCallContract" : "approveTokenAndCallContract";
          await manager.relay(
            approvedTransfer,
            method,
            params,
            wallet,
            _signers,
          );
          const after = await token.balanceOf(contract.address);
          assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
          assert.equal((await contract.state()).toNumber(), newState, "the state of the external contract should have been changed");
        }

        it("should approve token for a spender then call a contract with 3 guardians, spender = contract", async () => {
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian2])]);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian3])]);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian2, guardian3])]);
        });

        it("should approve WETH for a spender then call a contract with 3 guardians, spender = contract", async () => {
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian2])], contract.address, true);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian3])], contract.address, true);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian2, guardian3])], contract.address, true);
        });

        it("should approve token for a spender then call a contract with 3 guardians, spender != contract", async () => {
          const consumer = await contract.tokenConsumer();
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian2])], consumer);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian1, guardian3])], consumer);
          await approveTokenAndCallContract([owner, ...sortWalletByAddress([guardian2, guardian3])], consumer);
        });

        it("should restore the original approved amount", async () => {
          const consumer = await contract.tokenConsumer();
          const allowanceBefore = await erc20.allowance(wallet.address, consumer);
          const balanceBefore = await erc20.balanceOf(contract.address);

          const dataToTransfer = contract.contract.interface.functions
            .setStateAndPayTokenWithConsumer.encode([2, erc20.address, amountToApprove]);
          await manager.relay(approvedTransfer, "approveTokenAndCallContract",
            [wallet.address, erc20.address, consumer, amountToApprove, contract.address, dataToTransfer],
            wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);

          const balanceAfter = await erc20.balanceOf(contract.address);
          assert.equal(balanceAfter.sub(balanceBefore).toNumber(), amountToApprove, "should have approved and transfered the token amount");
          assert.equal((await contract.state()).toNumber(), 2, "the state of the external contract should have been changed");

          const allowanceAfter = await erc20.allowance(wallet.address, consumer);
          assert.equal(allowanceAfter.toNumber(), allowanceBefore.toNumber());
        });
      });
    });
  });

  describe("Daily Limit", () => {
    beforeEach(async () => {
      await addGuardians([guardian1]);
      await limitModule.setLimitAndDailySpent(wallet.address, 1000000, 500);
    });

    it("should change the limit immediately", async () => {
      let limit = await limitModule.getLimit(wallet.address);
      assert.equal(limit.toNumber(), 1000000, "limit should be 1000000");
      await manager.relay(approvedTransfer, "changeLimit", [wallet.address, 4000000], wallet, [owner, guardian1]);
      limit = await limitModule.getLimit(wallet.address);
      assert.equal(limit.toNumber(), 4000000, "limit should be changed immediately");
    });

    it("should reset the daily consumption", async () => {
      let dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 500, "dailySpent should be 500");
      await manager.relay(approvedTransfer, "resetDailySpent", [wallet.address], wallet, [owner, guardian1]);
      dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 0, "dailySpent should be 0");
    });

    it("should reset the daily consumption after a transfer", async () => {
      let dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 500, "dailySpent should be 500");
      await transferToken(ETH_TOKEN, [owner, guardian1]);
      dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 0, "dailySpent should be 0");
    });

    it("should reset the daily consumption after a call contract", async () => {
      let dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 500, "dailySpent should be 500");
      await callContract([owner, guardian1]);
      dailySpent = await limitModule.getDailySpent(wallet.address);
      assert.equal(dailySpent.toNumber(), 0, "dailySpent should be 0");
    });
  });
});

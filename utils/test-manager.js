const etherlime = require("etherlime-lib");
const ethers = require("ethers");
const ps = require("ps-node");
const { signOffchain, ETH_TOKEN } = require("./utilities.js");

class TestManager {
  constructor(network = "ganache", deployer) {
    this.network = network;
    this.deployer = deployer || this.newDeployer();
    this.provider = this.deployer.provider;
  }

  static newDeployer() {
    const defaultConfigs = {
      gasLimit: ethers.BigNumber.from(20700000),
    };
    const deployerInstance = new etherlime.EtherlimeGanacheDeployer("0x7ab741b57e8d94dd7e1a29055646bafde7010f38a900f55bbd7647880faa6ee8");
    deployerInstance.setDefaultOverrides(defaultConfigs);
    return deployerInstance;
  }

  async getCurrentBlock() {
    const block = await this.provider.getBlockNumber();
    return block;
  }

  async getTimestamp(blockNumber) {
    const block = await this.provider.getBlock(blockNumber);
    return block.timestamp;
  }

  async getNonceForRelay() {
    const block = await this.provider.getBlockNumber();
    const timestamp = new Date().getTime();
    return `0x${ethers.utils.hexZeroPad(ethers.utils.hexlify(block), 16)
      .slice(2)}${ethers.utils.hexZeroPad(ethers.utils.hexlify(timestamp), 16).slice(2)}`;
  }

  setRelayerModule(relayerModule) {
    this.relayerModule = relayerModule;
  }

  async relay(_module, _method, _params, _wallet, _signers,
    _relayer = this.accounts[9].signer,
    _estimate = false,
    _gasLimit = 2000000,
    _nonce,
    _gasPrice = 0,
    _refundToken = ETH_TOKEN,
    _refundAddress = ethers.constants.AddressZero,
    _gasLimitRelay = (_gasLimit * 1.1)) {
    const nonce = _nonce || await this.getNonceForRelay();
    const methodData = _module.contract.interface.functions[_method].encode(_params);
    const signatures = await signOffchain(
      _signers,
      this.relayerModule.address,
      _module.address,
      0,
      methodData,
      nonce,
      _gasPrice,
      _gasLimit,
      _refundToken,
      _refundAddress,
    );
    if (_estimate === true) {
      const gasUsed = await this.relayerModule.estimate.execute(
        _wallet.address,
        _module.address,
        methodData,
        nonce,
        signatures,
        _gasPrice,
        _gasLimit,
        _refundToken,
        _refundAddress,
        { gasLimit: _gasLimitRelay, gasPrice: _gasPrice },
      );
      return gasUsed;
    }
    const tx = await this.relayerModule.from(_relayer).execute(
      _wallet.address,
      _module.address,
      methodData,
      nonce,
      signatures,
      _gasPrice,
      _gasLimit,
      _refundToken,
      _refundAddress,
      { gasLimit: _gasLimitRelay, gasPrice: _gasPrice },
    );
    const txReceipt = await _module.verboseWaitForTransaction(tx);
    return txReceipt;
  }

  async increaseTime(seconds) {
    if (this.network === "ganache") {
      await this.provider.send("evm_increaseTime", seconds);
      await this.provider.send("evm_mine");
    } else {
      return new Promise((res) => { setTimeout(res, seconds * 1000); });
    }
    return null;
  }

  async runningEtherlimeGanache() { // eslint-disable-line class-methods-use-this
    return new Promise((res) => {
      ps.lookup({ arguments: ["etherlime", "ganache"] }, (err, processes) => {
        const runningEthGanache = !err && processes.reduce((etherlimeGanacheFound, p) => etherlimeGanacheFound
          || (p.command + p.arguments.join("-")).includes("etherlime-ganache"), false);
        return res(runningEthGanache);
      });
    });
  }

  async isRevertReason(error, reason) {
    const runningEthGanache = await this.runningEtherlimeGanache();
    // by default, we match the error with a generic "revert" keyword
    // but if we are running etherlime ganache (and not e.g. ganache-cli),
    // we can match the error with the exact reason message
    const expectedReason = runningEthGanache ? reason : "revert";
    return (error.message || error.toString()).includes(expectedReason);
  }
}

module.exports = TestManager;

const semver = require("semver");
const childProcess = require("child_process");
const MultiSig = require("../build/MultiSigWallet");
const ModuleRegistry = require("../build/ModuleRegistry");
const Upgrader = require("../build/SimpleUpgrader");
const DeployManager = require("../utils/deploy-manager.js");
const MultisigExecutor = require("../utils/multisigexecutor.js");

const LimitStorage = require("../build/LimitStorage");
const TokenPriceStorage = require("../build/TokenPriceStorage");

const ApprovedTransfer = require("../build/ApprovedTransfer");
const CompoundManager = require("../build/CompoundManager");
const GuardianManager = require("../build/GuardianManager");
const LockManager = require("../build/LockManager");
const NftTransfer = require("../build/NftTransfer");
const RecoveryManager = require("../build/RecoveryManager");
const TokenExchanger = require("../build/TokenExchanger");
const MakerV2Manager = require("../build/MakerV2Manager");
const TransferManager = require("../build/TransferManager");
const RelayerManager = require("../build/RelayerManager");
const VersionManager = require("../build/VersionManager");

const BaseWallet = require("../build/BaseWallet");
const WalletFactory = require("../build/WalletFactory");
const ENSManager = require("../build/ArgentENSManager");

const utils = require("../utils/utilities.js");

const TARGET_VERSION = "2.0.1";
const MODULES_TO_ENABLE = [
  "VersionManager",
];
const MODULES_TO_DISABLE = [
  "MakerManager",   
  "ApprovedTransfer",
  "CompoundManager",
  "GuardianManager",
  "LockManager",
  "NftTransfer",
  "RecoveryManager",
  "TokenExchanger",
  "MakerV2Manager",
  "TransferManager"
];

const BACKWARD_COMPATIBILITY = 1;

const deploy = async (network) => {
  if (!["kovan", "kovan-fork", "staging", "prod"].includes(network)) {
    console.warn("------------------------------------------------------------------------");
    console.warn(`WARNING: The MakerManagerV2 module is not fully functional on ${network}`);
    console.warn("------------------------------------------------------------------------");
  }

  const newModuleWrappers = [];
  const newVersion = {};

  // //////////////////////////////////
  // Setup
  // //////////////////////////////////

  const manager = new DeployManager(network);
  await manager.setup();

  const { configurator } = manager;
  const { deployer } = manager;
  const { abiUploader } = manager;
  const { versionUploader } = manager;
  const { gasPrice } = deployer.defaultOverrides;
  const deploymentWallet = deployer.signer;
  const { config } = configurator;

  const ModuleRegistryWrapper = await deployer.wrapDeployedContract(ModuleRegistry, config.contracts.ModuleRegistry);
  const MultiSigWrapper = await deployer.wrapDeployedContract(MultiSig, config.contracts.MultiSigWallet);
  const multisigExecutor = new MultisigExecutor(MultiSigWrapper, deploymentWallet, config.multisig.autosign, { gasPrice });
  const ENSManagerWrapper = await deployer.wrapDeployedContract(ENSManager, config.contracts.ENSManager);

  // //////////////////////////////////
  // Deploy infrastructure contracts
  // //////////////////////////////////

  // Deploy the Base Wallet Library
  const BaseWalletWrapper = await deployer.deploy(BaseWallet);
  // Deploy the Wallet Factory
  const WalletFactoryWrapper = await deployer.deploy(WalletFactory, {},
    ModuleRegistryWrapper.contractAddress, BaseWalletWrapper.contractAddress, ENSManagerWrapper.contractAddress, config.modules.GuardianStorage);
  // Deploy the new LimitStorage
  const LimitStorageWrapper = await deployer.deploy(LimitStorage);
  // Deploy the new TokenPriceStorage
  const TokenPriceStorageWrapper = await deployer.deploy(TokenPriceStorage);

  // //////////////////////////////////
  // Deploy new modules
  // //////////////////////////////////
  const VersionManagerWrapper = await deployer.deploy(
    VersionManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage
  );
  newModuleWrappers.push(VersionManagerWrapper);

  // //////////////////////////////////
  // Deploy new features
  // //////////////////////////////////
  const ApprovedTransferWrapper = await deployer.deploy(
    ApprovedTransfer,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    LimitStorageWrapper.contractAddress,
    VersionManagerWrapper.contractAddress,
    config.defi.weth,
  );

  const CompoundManagerWrapper = await deployer.deploy(
    CompoundManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    config.defi.compound.comptroller,
    config.contracts.CompoundRegistry,
    VersionManagerWrapper.contractAddress,
  );

  const GuardianManagerWrapper = await deployer.deploy(
    GuardianManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    VersionManagerWrapper.contractAddress,
    config.settings.securityPeriod || 0,
    config.settings.securityWindow || 0,
  );

  const LockManagerWrapper = await deployer.deploy(
    LockManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    VersionManagerWrapper.contractAddress,
    config.settings.lockPeriod || 0,
  );

  const NftTransferWrapper = await deployer.deploy(
    NftTransfer,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    TokenPriceStorageWrapper.contractAddress,
    VersionManagerWrapper.contractAddress,
    config.CryptoKitties.contract
  );

  const RecoveryManagerWrapper = await deployer.deploy(
    RecoveryManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    VersionManagerWrapper.contractAddress,
    config.settings.recoveryPeriod || 0,
    config.settings.lockPeriod || 0,
  );

  const TokenExchangerWrapper = await deployer.deploy(
    TokenExchanger,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    TokenPriceStorageWrapper.contractAddress,
    VersionManagerWrapper.contractAddress,
    config.defi.paraswap.contract,
    "argent",
    Object.values(config.defi.paraswap.authorisedExchanges),
  );

  const MakerV2ManagerWrapper = await deployer.deploy(
    MakerV2Manager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    config.defi.maker.migration,
    config.defi.maker.pot,
    config.defi.maker.jug,
    config.contracts.MakerRegistry,
    config.defi.uniswap.factory,
    VersionManagerWrapper.contractAddress
  );

  const TransferManagerWrapper = await deployer.deploy(
    TransferManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.TransferStorage,
    config.modules.GuardianStorage,
    LimitStorageWrapper.contractAddress,
    TokenPriceStorageWrapper.contractAddress,
    VersionManagerWrapper.contractAddress,
    config.settings.securityPeriod || 0,
    config.settings.securityWindow || 0,
    config.settings.defaultLimit || "1000000000000000000",
    config.defi.weth,
    ["test", "staging", "prod"].includes(network) ? config.modules.TransferManager : "0x0000000000000000000000000000000000000000",
  );

  const RelayerManagerWrapper = await deployer.deploy(
    RelayerManager,
    {},
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    LimitStorageWrapper.contractAddress,
    TokenPriceStorageWrapper.contractAddress,
    VersionManagerWrapper.contractAddress
  );

  // //////////////////////////////////
  // Set contracts' managers
  // //////////////////////////////////
  await multisigExecutor.executeCall(ENSManagerWrapper, "addManager", [WalletFactoryWrapper.contractAddress]);

  for (const idx in config.backend.accounts) {
    const account = config.backend.accounts[idx];
    const WalletFactoryAddManagerTx = await WalletFactoryWrapper.contract.addManager(account, { gasPrice });
    await WalletFactoryWrapper.verboseWaitForTransaction(WalletFactoryAddManagerTx, `Set ${account} as the manager of the WalletFactory`);

    const TokenPriceStorageAddManagerTx = await TokenPriceStorageWrapper.contract.addManager(account, { gasPrice });
    await TokenPriceStorageWrapper.verboseWaitForTransaction(TokenPriceStorageAddManagerTx,
      `Set ${account} as the manager of the TokenPriceStorage`);
  }

  // //////////////////////////////////
  // Set contracts' owners
  // //////////////////////////////////

  let changeOwnerTx = await WalletFactoryWrapper.contract.changeOwner(config.contracts.MultiSigWallet, { gasPrice });
  await WalletFactoryWrapper.verboseWaitForTransaction(changeOwnerTx, "Set the MultiSig as the owner of WalletFactory");

  changeOwnerTx = await TokenPriceStorageWrapper.contract.changeOwner(config.contracts.MultiSigWallet, { gasPrice });
  await TokenPriceStorageWrapper.verboseWaitForTransaction(changeOwnerTx, "Set the MultiSig as the owner of TokenPriceStorageWrapper");

  // /////////////////////////////////////////////////
  // Update config and Upload ABIs
  // /////////////////////////////////////////////////

  // TODO: change name from "module" to "feature" where appropriate
  configurator.updateModuleAddresses({
    LimitStorage: LimitStorageWrapper.contractAddress,
    TokenPriceStorage: TokenPriceStorageWrapper.contractAddress,
    ApprovedTransfer: ApprovedTransferWrapper.contractAddress,
    CompoundManager: CompoundManagerWrapper.contractAddress,
    GuardianManager: GuardianManagerWrapper.contractAddress,
    LockManager: LockManagerWrapper.contractAddress,
    NftTransfer: NftTransferWrapper.contractAddress,
    RecoveryManager: RecoveryManagerWrapper.contractAddress,
    TokenExchanger: TokenExchangerWrapper.contractAddress,
    MakerV2Manager: MakerV2ManagerWrapper.contractAddress,
    TransferManager: TransferManagerWrapper.contractAddress,
    RelayerManager: RelayerManagerWrapper.contractAddress,
    VersionManager: VersionManagerWrapper.contractAddress,
  });

  configurator.updateInfrastructureAddresses({
    BaseWallet: BaseWalletWrapper.contractAddress,
    WalletFactory: WalletFactoryWrapper.contractAddress,
  });

  const gitHash = childProcess.execSync("git rev-parse HEAD").toString("utf8").replace(/\n$/, "");
  configurator.updateGitHash(gitHash);
  await configurator.save();

  await Promise.all([
    abiUploader.upload(LimitStorageWrapper, "modules"),
    abiUploader.upload(ApprovedTransferWrapper, "modules"),
    abiUploader.upload(CompoundManagerWrapper, "modules"),
    abiUploader.upload(GuardianManagerWrapper, "modules"),
    abiUploader.upload(LockManagerWrapper, "modules"),
    abiUploader.upload(NftTransferWrapper, "modules"),
    abiUploader.upload(RecoveryManagerWrapper, "modules"),
    abiUploader.upload(TokenExchangerWrapper, "modules"),
    abiUploader.upload(MakerV2ManagerWrapper, "modules"),
    abiUploader.upload(TransferManagerWrapper, "modules"),
    abiUploader.upload(RelayerManagerWrapper, "modules"),
    abiUploader.upload(TokenPriceStorageWrapper, "contracts"),
    abiUploader.upload(BaseWalletWrapper, "contracts"),
    abiUploader.upload(WalletFactoryWrapper, "contracts"),
  ]);

  // //////////////////////////////////
  // Register new modules
  // //////////////////////////////////

  for (let idx = 0; idx < newModuleWrappers.length; idx += 1) {
    const wrapper = newModuleWrappers[idx];
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [wrapper.contractAddress, utils.asciiToBytes32(wrapper._contract.contractName)]);
  }

  // //////////////////////////////////
  // Deploy and Register upgraders
  // //////////////////////////////////

  let fingerprint;
  const versions = await versionUploader.load(BACKWARD_COMPATIBILITY);
  for (let idx = 0; idx < versions.length; idx += 1) {
    const version = versions[idx];
    let toAdd; let toRemove;
    if (idx === 0) {
      const moduleNamesToRemove = MODULES_TO_DISABLE.concat(MODULES_TO_ENABLE);
      toRemove = version.modules.filter((module) => moduleNamesToRemove.includes(module.name));
      toAdd = newModuleWrappers.map((wrapper) => ({
        address: wrapper.contractAddress,
        name: wrapper._contract.contractName,
      }));
      const toKeep = version.modules.filter((module) => !moduleNamesToRemove.includes(module.name));
      const modulesInNewVersion = toKeep.concat(toAdd);
      fingerprint = utils.versionFingerprint(modulesInNewVersion);
      newVersion.version = semver.lt(version.version, TARGET_VERSION) ? TARGET_VERSION : semver.inc(version.version, "patch");
      newVersion.createdAt = Math.floor((new Date()).getTime() / 1000);
      newVersion.modules = modulesInNewVersion;
      newVersion.fingerprint = fingerprint;
    } else {
      // add all modules present in newVersion that are not present in version
      toAdd = newVersion.modules.filter((module) => !version.modules.map((m) => m.address).includes(module.address));
      // remove all modules from version that are no longer present in newVersion
      toRemove = version.modules.filter((module) => !newVersion.modules.map((m) => m.address).includes(module.address));
    }

    const upgraderName = `${version.fingerprint}_${fingerprint}`;

    const UpgraderWrapper = await deployer.deploy(
      Upgrader,
      {},
      config.contracts.ModuleRegistry,
      toRemove.map((module) => module.address),
      toAdd.map((module) => module.address),
    );
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [UpgraderWrapper.contractAddress, utils.asciiToBytes32(upgraderName)]);

    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerUpgrader",
      [UpgraderWrapper.contractAddress, utils.asciiToBytes32(upgraderName)]);
  }

  // //////////////////////////////////
  // Upload Version
  // //////////////////////////////////

  await versionUploader.upload(newVersion);
};

module.exports = {
  deploy,
};

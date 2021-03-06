const seedrandom = require('seedrandom');
const ainUtil = require('@ainblockchain/ain-util');
const logger = require('../logger');
const { Block } = require('../blockchain/block');
const ChainUtil = require('../chain-util');
const PushId = require('../db/push-id');
const { MessageTypes, STAKE, WriteDbOperations, PredefinedDbPaths } = require('../constants');
const { ConsensusMessageTypes, ConsensusConsts,
        ConsensusStatus, ConsensusDbPaths } = require('./constants');

const LOG_PREFIX = 'CONSENSUS';

class Consensus {
  constructor(server, node) {
    this.server = server;
    this.node = node;
    this.status = null;
    this.statusChangedBlockNumber = null;
    this.setter = '';
    this.setStatus(ConsensusStatus.STARTING);
    this.timeoutId = null;
    this.timeoutInfo = null;
    this.state = {
      number: 0,
      // Round is increased by 1 whenever there's a timeout and is appended to the lastBlockHash.
      // The combined string becomes the seed for the pseudo-random number generator which is used
      // to select a next proposer.
      round: 0,
      proposer: null
    }
  }

  init() {
    const LOG_SUFFIX = 'init';
    let currentStake;

    this.state.number = this.node.bc.lastBlockNumber() + 1;
    this.setStatus(ConsensusStatus.INITIALIZED, 'init');

    try {
      if (this.state.number === 1) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] this.state.number = 1`);
        currentStake = this.getValidConsensusDeposit(this.node.account.address);
      } else {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] this.state.number = ` + this.state.number);
        currentStake = this.getStakeAtNumber(this.state.number, this.node.account.address);
      }

      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Current stake: ` + currentStake);

      if (!currentStake) {
        if (STAKE && STAKE > 0) {
          this.stake(STAKE);
        } else {
          logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Node doesn't have any stakes. Initialized as a non-validator.`);
        }
      }
      this.start();
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Initialized to number ${this.state.number} and round ${this.state.round}`);
    } catch(e) {
      this.setStatus(ConsensusStatus.STARTING, 'init');
    }
  }

  setStatus(status, setter = '') {
    this.status = status;
    this.statusChangedBlockNumber = this.node.bc.lastBlockNumber();
    this.setter = setter;
  }

  start() {
    this.setStatus(ConsensusStatus.RUNNING, 'start');
    this.updateToState();
  }

  stop() {
    this.setStatus(ConsensusStatus.STOPPED, 'stop');
    if (this.timeoutInfo) {
      clearTimeout(this.timeoutInfo);
      this.timeoutInfo = null;
    }
    // FIXME: reset consensus state?
  }

  updateToState() {
    const LOG_SUFFIX = 'updateToState';

    if (this.state.number > this.node.bc.lastBlockNumber() + 1) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to update to state (${this.state.number}/${this.node.bc.lastBlockNumber()})`);
      return;
    }

    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Current: ${this.state.number}/${this.state.round}`);
    this.state.number = this.node.bc.lastBlockNumber() + 1;
    this.state.round = 0;
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Updated: ${this.state.number}/${this.state.round}`);
    this.state.proposer = this.selectProposer();

    // To avoid call stack exceeded errors
    setTimeout(() => {
      this.tryPropose();
    }, ConsensusConsts.TRANSITION_TIMEOUT_MS);
  }

  // If I haven't received a proposal for the number, move onto the next round and another proposer
  handleTimeout(timeoutInfo) {
    const LOG_SUFFIX = 'handleTimeout';
    const { number, round } = timeoutInfo;

    if (number !== this.state.number || round < this.state.round) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Ignoring timeout because we're ahead (${this.state.number}/${this.state.round}) vs (${number}/${round})`);
      return;
    }
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Current: ${this.state.number}/${this.state.round}/${this.state.proposer}\n`);
    this.state.round = round + 1;
    this.state.proposer = this.selectProposer();
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Changed: ${number}/${this.state.round}/${this.state.proposer}`);
    this.tryPropose();
  }

  // Currently the only type of consensus messages is proposal: { value: Block, type = 'PROPOSE' }
  handleConsensusMessage(msg) {
    const LOG_SUFFIX = 'handleConsensusMessage';

    if (this.status !== ConsensusStatus.RUNNING) {
      return;
    }
    if (msg.type !== ConsensusMessageTypes.PROPOSE) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid message type: ${msg.type}`);
      return;
    }
    if (!msg.value) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid message value: ${msg.value}`);
      return;
    }
    if (msg.value.number !== this.state.number) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid number: Expected: ${this.state.number}, Actual: ${msg.value.number}`);
      if (msg.value.number > this.state.number) {
        // I might be falling behind. Try to catch up
        // TODO(lia): This has a possibility of being exploited by an attacker. The attacker
        // can keep sending messages with higher numbers, making the node's status unsynced, and
        // prevent the node from getting/handling messages properly.
        logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Trying to sync. Current last block is ${JSON.stringify(this.node.bc.lastBlock())}`);
        this.node.bc.syncedAfterStartup = false;
        this.server.requestChainSubsection(this.node.bc.lastBlock());
      }
      return;
    }
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Consensus state: ${this.state.number}/${this.state.round}, Blockchain state: ${this.node.bc.lastBlockNumber()}, Message: ${msg.value.number}`);
    if (this.checkProposal(msg.value)) {
      this.commit(msg.value);
      this.server.broadcastConsensusMessage(msg);
    }
  }

  scheduleTimeout(newTimeoutInfo, durationMs) {
    const LOG_SUFFIX = 'scheduleTimeout';

    logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] ${JSON.stringify(newTimeoutInfo)} / ${JSON.stringify(this.timeoutInfo)}`);
    if (this.timeoutInfo) {
      const ti = this.timeoutInfo;

      if (newTimeoutInfo.number < ti.number || (newTimeoutInfo.number === ti.number && newTimeoutInfo.round < ti.round)) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Ignoring old number/round`);
        return;
      }
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
      }
    }

    this.timeoutInfo = newTimeoutInfo;
    this.timeoutId = setTimeout(() => {
      this.handleTimeout(newTimeoutInfo);
    }, durationMs);
  }

  tryPropose() {
    const LOG_SUFFIX = 'tryPropose';

    if (ainUtil.areSameAddresses(this.state.proposer, this.node.account.address)) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] I'm the proposer`);
      this.scheduleTimeout({ number: this.state.number, round: this.state.round }, ConsensusConsts.PROPOSAL_TIMEOUT_MS);
      this.handleConsensusMessage({ value: this.createBlockProposal(), type: ConsensusMessageTypes.PROPOSE });
    } else {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Not my turn`);
      this.scheduleTimeout({ number: this.state.number, round: this.state.round }, ConsensusConsts.PROPOSAL_TIMEOUT_MS);
    }
  }

  // TODO(lia): Sign and verify the proposals
  createBlockProposal() {
    const lastBlock = this.node.bc.lastBlock();
    const blockNumber = this.state.number; // Should be equal to lastBlock.number + 1
    const transactions = this.node.tp.getValidTransactions();
    const proposer = this.node.account.address;
    const validators = this.getValidatorsVotedFor(lastBlock.number, lastBlock.hash);
    const totalAtStake = Object.values(validators).reduce(function(a, b) { return a + b; }, 0);
    // This should be part of the proposals, but to reduce complexity, we're including it in transactions for now
    // TODO(lia): Make proposals SET_VALUE transactions and include it in last_votes of the next block
    // TODO(lia): Include block_hash in the proposal tx's value
    let consensusUpdateTx;
    const proposeTx = {
      type: WriteDbOperations.SET_VALUE,
      ref: ChainUtil.formatPath([
        ConsensusDbPaths.CONSENSUS,
        ConsensusDbPaths.NUMBER,
        blockNumber,
        ConsensusDbPaths.PROPOSE
      ]),
      value: {
        number: blockNumber,
        validators,
        total_at_stake: totalAtStake,
        proposer
      }
    }

    if (blockNumber <= ConsensusConsts.MAX_CONSENSUS_STATE_DB) {
      consensusUpdateTx = this.node.createTransaction({ operation: proposeTx }, false);
    } else {
      consensusUpdateTx = this.node.createTransaction({
        operation: {
          type: WriteDbOperations.SET,
          op_list: [
            proposeTx,
            {
              type: WriteDbOperations.SET_VALUE,
              ref: ChainUtil.formatPath([
                ConsensusDbPaths.CONSENSUS,
                ConsensusDbPaths.NUMBER,
                blockNumber - ConsensusConsts.MAX_CONSENSUS_STATE_DB
              ]),
              value: null
            }
          ]
        }
      }, false);
    }

    transactions.push(consensusUpdateTx);
    // FIXME: This should be fixed with the proposal revamp
    this.server.executeTransaction(consensusUpdateTx, MessageTypes.TRANSACTION);

    return Block.createBlock(this.node.bc.lastBlock().hash, [], transactions, blockNumber, proposer, validators);
  }

  checkProposal(block) {
    const LOG_SUFFIX = 'checkProposal';

    logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}]\nlastBlock: ${JSON.stringify(this.node.bc.lastBlock(), null, 2)}` +
                 `\nIncoming proposal: ${JSON.stringify(block, null, 2)}`);
    if (!Block.validateProposedBlock(block, this.node.bc)) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposed block didn't pass the basic checks`);
      return false;
    }
    if (block.proposer !== this.state.proposer) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Not the right proposer 
                    (${block.proposer}/${this.state.proposer})`);
      return false;
    }
    logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposed block passed the basic checks`);

    return true;
  }

  commit(block) {
    // TODO(lia): Use fianlized state snapshot to verify the block first, and update the finalized state
    const LOG_SUFFIX = 'commit';

    if (this.node.addNewBlock(block)) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Committing a block of number ${block.number} and hash ${block.hash}`);
      this.tryRegister(block);
      this.updateToState();
    } else {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to commit a block: ` + JSON.stringify(this.state.proposedBlock, null, 2));
    }
  }

  selectProposer() {
    const LOG_SUFFIX = 'selectProposer';
    const validators = this.getValidatorsAtNumber(this.state.number);

    logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] ${this.state.number}/${this.state.round}`);

    if (!validators || !Object.keys(validators).length) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to select a proposer: no validators given.`);
      return null;
    }
    // TODO(lia): find a better random seeding mechanism
    const seedBlock = this.state.number <= ConsensusConsts.MAX_CONSENSUS_STATE_DB ?
        this.node.bc.lastBlock() : this.node.bc.getBlockByNumber(this.state.number - ConsensusConsts.MAX_CONSENSUS_STATE_DB);
    const seed = seedBlock.hash + this.state.round;
    const alphabeticallyOrderedValidators = Object.keys(validators).sort();
    const totalAtStake = Object.values(validators).reduce((a, b) => { return a + b; }, 0);
    const randomNumGenerator = seedrandom(seed);
    const targetValue = randomNumGenerator() * totalAtStake;
    let cumulative = 0;

    for (let i = 0; i < alphabeticallyOrderedValidators.length; i++) {
      cumulative += validators[alphabeticallyOrderedValidators[i]];
      if (cumulative > targetValue) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposer is ${alphabeticallyOrderedValidators[i]}`);
        return alphabeticallyOrderedValidators[i];
      }
    }
    logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to get the proposer.\nvalidators: ${alphabeticallyOrderedValidators}\n` +
                  `totalAtStake: ${totalAtStake}\nseed: ${seed}\ntargetValue: ${targetValue}`);

    return null;
  }

  getValidatorsAtNumber(number) {
    // FIXME: Is there a better way?
    if (number === 1) {
      return STAKE > 0 ? { [this.node.account.address] :  STAKE } : {};
    }
    const block = this.node.bc.lastBlock();
    if (!block) {
      logger.error(`[${LOG_PREFIX}:getValidatorsAtNumber] No past block of number ` +
                   `${number - 1} for validators reference`);
      return null;
    }

    return block.validators;
  }

  getValidatorsVotedFor(number, hash) {
    const LOG_SUFFIX = 'getValidatorsVotedFor';

    if (number === 0) {
      const myAddr = this.node.account.address;
      return STAKE > 0 ? { [myAddr] :  this.getValidConsensusDeposit(myAddr) } : {};
    }

    const registerRef = ChainUtil.formatPath([
      ConsensusDbPaths.CONSENSUS,
      ConsensusDbPaths.NUMBER,
      number,
      ConsensusDbPaths.REGISTER
    ]);
    const registration = this.node.db.getValue(registerRef);

    logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] registration (${number}, ${hash}): ${JSON.stringify(registration, null, 2)}`);
    if (!registration) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] No validators registered`);
      throw Error('No validators registered');
    }

    const addresses = Object.keys(registration).filter((addr) => { return registration[addr].block_hash === hash });
    const validators = {};

    addresses.forEach(addr => {
      validators[addr] = registration[addr].stake;
    });

    return validators;
  }

  getValidConsensusDeposit(address) {
    const deposit = this.node.db.getValue(ChainUtil.formatPath([
      PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
      address
    ]));

    if (deposit && deposit.value > 0 && deposit.expire_at > Date.now() + ConsensusConsts.DAY_MS) {
      return deposit.value;
    }

    return 0;
  }

  getStakeAtNumber(number, address) {
    if (number <= 1) return 0;

    const block = this.node.bc.getBlockByNumber(number - 1);

    if (!block) {
      logger.error(`[${LOG_PREFIX}:getStakeAtNumber] No past block of number ` +
                   `${number - 1} for validators reference`);
      throw Error('No past validator reference block available.');
    }

    return block.validators[address] ? block.validators[address] : 0;
  }

  tryRegister(block) {
    const myAddr = this.node.account.address;
    const myStake = this.getValidConsensusDeposit(myAddr);

    if (myStake === 0) return;

    const registerTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.formatPath([
          ConsensusDbPaths.CONSENSUS,
          ConsensusDbPaths.NUMBER,
          block.number,
          ConsensusDbPaths.REGISTER,
          myAddr
        ]),
        value: {
          [ConsensusDbPaths.BLOCK_HASH]: block.hash,
          [ConsensusDbPaths.STAKE]: myStake
        }
      }
    }, false);

    return this.server.executeAndBroadcastTransaction(registerTx, MessageTypes.TRANSACTION);
  }

  stake(amount) {
    if (!amount || amount <= 0) {
      logger.debug(`[${LOG_PREFIX}:stake] Invalid staking amount received: ${amount}`);
      return null;
    }

    const depositTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.formatPath([
            PredefinedDbPaths.DEPOSIT_CONSENSUS,
            this.node.account.address,
            PushId.generate(),
            PredefinedDbPaths.DEPOSIT_VALUE
          ]),
        value: amount
      }
    }, false);

    return this.server.executeAndBroadcastTransaction(depositTx, MessageTypes.TRANSACTION);
  }
}

module.exports = Consensus;
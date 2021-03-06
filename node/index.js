const ainUtil = require('@ainblockchain/ain-util');
const logger = require('../logger');
const { PORT, ACCOUNT_INDEX, GenesisAccounts } = require('../constants');
const Blockchain = require('../blockchain');
const TransactionPool = require('../tx-pool');
const DB = require('../db');
const Transaction = require('../tx-pool/transaction');

const NODE_PREFIX = 'NODE';

class Node {
  constructor() {
    this.bc = new Blockchain(String(PORT));
    this.tp = new TransactionPool();
    this.db = new DB();
    this.nonce = null;
    this.initialized = false;
    // TODO(lia): Add account importing functionality.
    this.account = ACCOUNT_INDEX !== null ?
        GenesisAccounts.others[ACCOUNT_INDEX] : ainUtil.createAccount();
    logger.info(`[${NODE_PREFIX}] Initializing a new node with account: ${this.account.address}`);
  }

  // For testing purpose only.
  setAccountForTesting(accountIndex) {
    this.account = GenesisAccounts.others[accountIndex];
  }

  init(isFirstNode) {
    logger.info(`[${NODE_PREFIX}] Initializing node..`);
    this.bc.init(isFirstNode);
    this.bc.setBackupDb(new DB());
    this.nonce = this.getNonce();
    this.reconstruct();
    this.initialized = true;
  }

  getNonce() {
    // TODO (Chris): Search through all blocks for any previous nonced transaction with current
    //               publicKey
    let nonce = 0;
    for (let i = this.bc.chain.length - 1; i > -1; i--) {
      for (let j = this.bc.chain[i].transactions.length -1; j > -1; j--) {
        if (ainUtil.areSameAddresses(this.bc.chain[i].transactions[j].address,
                                     this.account.address)
            && this.bc.chain[i].transactions[j].nonce > -1) {
          // If blockchain is being restarted, retreive nonce from blockchain
          nonce = this.bc.chain[i].transactions[j].nonce + 1;
          break;
        }
      }
      if (nonce > 0) {
        break;
      }
    }

    logger.info(`[${NODE_PREFIX}] Setting nonce to ${nonce}`);
    return nonce;
  }

  /**
    * Validates transaction is valid according to AIN database rules and returns a transaction
    * instance
    *
    * @param {dict} operation - Database write operation to be converted to transaction
    * @param {boolean} isNoncedTransaction - Indicates whether transaction should include nonce or
    *                                        not
    * @return {Transaction} Instance of the transaction class
    */
  createTransaction(txData, isNoncedTransaction = true) {
    if (Transaction.isBatchTransaction(txData)) {
      const txList = [];
      txData.tx_list.forEach((subData) => {
        txList.push(this.createSingleTransaction(subData, isNoncedTransaction));
      })
      return { tx_list: txList };
    }
    return this.createSingleTransaction(txData, isNoncedTransaction);
  }

  createSingleTransaction(txData, isNoncedTransaction) {
    // Workaround for skip_verif with custom address
    if (txData.address !== undefined) {
      txData.skip_verif = true;
    }
    if (txData.nonce === undefined) {
      let nonce;
      if (isNoncedTransaction) {
        nonce = this.nonce;
        this.nonce++;
      } else {
        nonce = -1;
      }
      txData.nonce = nonce;
    }
    return Transaction.newTransaction(this.account.private_key, txData);
  }

  addNewBlock(block) {
    if (this.bc.addNewBlock(block)) {
      this.tp.cleanUpForNewBlock(block);
      this.reconstruct();
      return true;
    }
    return false;
  }

  reconstruct() {
    logger.info(`[${NODE_PREFIX}] Reconstructing database (Current chain length: ${this.bc.chain.length})`);
    this.db.setDbToSnapshot(this.bc.backupDb);
    this.executeChainOnDb();
    this.db.executeTransactionList(this.tp.getValidTransactions());
  }

  executeChainOnDb() {
    logger.info(`[${NODE_PREFIX}] Executing database`);
    this.bc.chain.forEach((block) => {
      const transactions = block.transactions;
      this.db.executeTransactionList(transactions);
      this.tp.updateNonceTrackers(transactions);
    });
  }
}

module.exports = Node;

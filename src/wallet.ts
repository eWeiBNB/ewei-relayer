import { ethers, JsonRpcProvider, Wallet, TransactionRequest } from 'ethers';
import { config } from './config';
import { createChildLogger } from './logger';

const log = createChildLogger('wallet');

/**
 * Hot wallet manager for the relayer node.
 * Handles nonce tracking, balance monitoring, and transaction signing.
 */
export class WalletManager {
  private wallet: Wallet;
  private provider: JsonRpcProvider;
  private fallbackProvider: JsonRpcProvider | null = null;
  private currentNonce: number = -1;
  private pendingNonces: Set<number> = new Set();
  private readonly minBalance: bigint;

  constructor() {
    this.provider = new JsonRpcProvider(config.bscRpcUrl, config.chainId);

    if (config.bscRpcUrlFallback) {
      this.fallbackProvider = new JsonRpcProvider(config.bscRpcUrlFallback, config.chainId);
    }

    this.wallet = new Wallet(config.relayerPrivateKey, this.provider);
    this.minBalance = ethers.parseEther(config.minBalanceThreshold);

    log.info({ address: this.wallet.address }, 'Wallet manager initialized');
  }

  get address(): string {
    return this.wallet.address;
  }

  get signer(): Wallet {
    return this.wallet;
  }

  /** Initialize nonce from on-chain state */
  async initialize(): Promise<void> {
    this.currentNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    log.info({ nonce: this.currentNonce, address: this.wallet.address }, 'Nonce initialized');
  }

  /** Get and reserve the next available nonce */
  async acquireNonce(): Promise<number> {
    if (this.currentNonce === -1) {
      await this.initialize();
    }

    const nonce = this.currentNonce;
    this.currentNonce++;
    this.pendingNonces.add(nonce);

    log.debug({ nonce }, 'Nonce acquired');
    return nonce;
  }

  /** Release a nonce that was not used (tx failed before submission) */
  releaseNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    log.debug({ nonce }, 'Nonce released');
  }

  /** Confirm a nonce was used successfully */
  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
  }

  /** Re-sync nonce from chain (use after stuck transactions) */
  async resyncNonce(): Promise<void> {
    const onChainNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    const oldNonce = this.currentNonce;
    this.currentNonce = onChainNonce;
    this.pendingNonces.clear();
    log.warn({ oldNonce, newNonce: onChainNonce }, 'Nonce resynced from chain');
  }

  /** Get current BNB balance */
  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  /** Check if balance is above minimum threshold */
  async isBalanceHealthy(): Promise<boolean> {
    const balance = await this.getBalance();
    const healthy = balance >= this.minBalance;

    if (!healthy) {
      log.warn(
        {
          balance: ethers.formatEther(balance),
          threshold: ethers.formatEther(this.minBalance),
        },
        'Wallet balance below threshold!',
      );
    }

    return healthy;
  }

  /** Sign and send a raw transaction */
  async sendTransaction(tx: TransactionRequest): Promise<ethers.TransactionResponse> {
    try {
      const response = await this.wallet.sendTransaction(tx);
      log.info({ txHash: response.hash, nonce: response.nonce }, 'Transaction sent');
      return response;
    } catch (err) {
      // Try fallback provider if primary fails
      if (this.fallbackProvider && err instanceof Error && err.message.includes('network')) {
        log.warn('Primary RPC failed, trying fallback');
        const fallbackWallet = this.wallet.connect(this.fallbackProvider);
        return fallbackWallet.sendTransaction(tx);
      }
      throw err;
    }
  }

  /** Get the active provider (for reads) */
  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  /** Get latest block number */
  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /** Get current pending nonce count */
  get pendingCount(): number {
    return this.pendingNonces.size;
  }
}

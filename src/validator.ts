import { ethers, Contract, JsonRpcProvider } from 'ethers';
import { SponsorRequest, SponsorPolicy } from './types';
import { config } from './config';
import { createChildLogger } from './logger';
import { query } from './db';

const log = createChildLogger('validator');

// Minimal Forwarder ABI for verification
const FORWARDER_ABI = [
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data) req, bytes signature) view returns (bool)',
];

// Minimal PolicyRegistry ABI
const POLICY_ABI = [
  'function getPolicy(bytes32 policyId) view returns (tuple(address sponsor, uint256 maxGasPerTx, uint256 maxTotalGas, uint256 usedGas, address[] allowedContracts, bytes4[] allowedMethods, bool active, uint256 expiresAt))',
];

/**
 * Validates sponsored transaction requests before they enter the queue.
 * Checks signatures, policies, deadlines, and simulates execution.
 */
export class TransactionValidator {
  private forwarder: Contract;
  private policyRegistry: Contract;
  private provider: JsonRpcProvider;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
    this.forwarder = new Contract(config.forwarderAddress, FORWARDER_ABI, provider);
    this.policyRegistry = new Contract(config.policyRegistryAddress, POLICY_ABI, provider);
  }

  /** Full validation pipeline for an incoming sponsor request */
  async validate(request: SponsorRequest): Promise<ValidationResult> {
    const errors: string[] = [];

    // 1. Basic field validation
    if (!ethers.isAddress(request.from)) {
      errors.push('Invalid sender address');
    }
    if (!ethers.isAddress(request.to)) {
      errors.push('Invalid target address');
    }
    if (!request.signature || request.signature.length < 130) {
      errors.push('Invalid signature length');
    }
    if (!request.policyId) {
      errors.push('Missing policy ID');
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 2. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (request.deadline <= now) {
      errors.push(`Transaction deadline has passed (deadline: ${request.deadline}, now: ${now})`);
    } else if (request.deadline - now < 30) {
      errors.push('Transaction deadline too close (< 30 seconds)');
    }

    // 3. Verify signature on-chain via Forwarder
    try {
      const isValid = await this.forwarder.verify(
        {
          from: request.from,
          to: request.to,
          value: request.value,
          gas: request.gasLimit,
          nonce: request.nonce,
          deadline: request.deadline,
          data: request.data,
        },
        request.signature,
      );

      if (!isValid) {
        errors.push('Signature verification failed on Forwarder contract');
      }
    } catch (err) {
      log.error({ err, from: request.from }, 'Signature verification call failed');
      errors.push('Could not verify signature (RPC error)');
    }

    // 4. Check nonce hasn't been used
    try {
      const currentNonce = await this.forwarder.getNonce(request.from);
      if (BigInt(request.nonce) < currentNonce) {
        errors.push(`Nonce already used (current: ${currentNonce}, provided: ${request.nonce})`);
      }
    } catch (err) {
      log.warn({ err }, 'Nonce check failed');
    }

    // 5. Validate policy
    try {
      const policy = await this.fetchPolicy(request.policyId);
      if (!policy) {
        errors.push('Policy not found');
      } else {
        const policyErrors = this.validatePolicy(policy, request);
        errors.push(...policyErrors);
      }
    } catch (err) {
      log.error({ err, policyId: request.policyId }, 'Policy fetch failed');
      errors.push('Could not fetch policy');
    }

    // 6. Simulate execution (optional, best-effort)
    if (errors.length === 0) {
      try {
        await this.simulateExecution(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown simulation error';
        log.warn({ err, from: request.from }, 'Transaction simulation failed');
        errors.push(`Simulation failed: ${message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /** Fetch and cache policy from chain or database */
  private async fetchPolicy(policyId: string): Promise<SponsorPolicy | null> {
    // Try database cache first
    const cached = await query<SponsorPolicy>(
      'SELECT * FROM policies WHERE id = $1 AND synced_at > NOW() - INTERVAL \'5 minutes\'',
      [policyId],
    );

    if (cached.length > 0) {
      return cached[0];
    }

    // Fetch from chain
    try {
      const raw = await this.policyRegistry.getPolicy(policyId);
      const policy: SponsorPolicy = {
        id: policyId,
        sponsor: raw.sponsor,
        maxGasPerTx: raw.maxGasPerTx,
        maxTotalGas: raw.maxTotalGas,
        usedGas: raw.usedGas,
        allowedContracts: raw.allowedContracts,
        allowedMethods: raw.allowedMethods,
        active: raw.active,
        expiresAt: Number(raw.expiresAt),
      };

      // Update cache
      await query(
        `INSERT INTO policies (id, sponsor, max_gas_per_tx, max_total_gas, used_gas, allowed_contracts, allowed_methods, active, expires_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (id) DO UPDATE SET
           used_gas = $5, active = $8, synced_at = NOW()`,
        [
          policy.id,
          policy.sponsor,
          policy.maxGasPerTx.toString(),
          policy.maxTotalGas.toString(),
          policy.usedGas.toString(),
          policy.allowedContracts,
          policy.allowedMethods,
          policy.active,
          policy.expiresAt,
        ],
      );

      return policy;
    } catch (err) {
      log.error({ err, policyId }, 'Failed to fetch policy from chain');
      return null;
    }
  }

  /** Validate request against policy rules */
  private validatePolicy(policy: SponsorPolicy, request: SponsorRequest): string[] {
    const errors: string[] = [];

    if (!policy.active) {
      errors.push('Policy is not active');
    }

    const now = Math.floor(Date.now() / 1000);
    if (policy.expiresAt > 0 && policy.expiresAt <= now) {
      errors.push('Policy has expired');
    }

    if (BigInt(request.gasLimit) > policy.maxGasPerTx) {
      errors.push(
        `Gas limit ${request.gasLimit} exceeds policy max per tx (${policy.maxGasPerTx})`,
      );
    }

    if (policy.usedGas + BigInt(request.gasLimit) > policy.maxTotalGas) {
      errors.push('Policy total gas budget would be exceeded');
    }

    // Check allowed contracts
    if (policy.allowedContracts.length > 0) {
      const target = request.to.toLowerCase();
      const allowed = policy.allowedContracts.map((c) => c.toLowerCase());
      if (!allowed.includes(target)) {
        errors.push(`Target contract ${request.to} not allowed by policy`);
      }
    }

    // Check allowed methods (first 4 bytes of calldata)
    if (policy.allowedMethods.length > 0 && request.data.length >= 10) {
      const methodSig = request.data.slice(0, 10);
      if (!policy.allowedMethods.includes(methodSig)) {
        errors.push(`Method ${methodSig} not allowed by policy`);
      }
    }

    return errors;
  }

  /** Simulate the meta-transaction execution via eth_call */
  private async simulateExecution(request: SponsorRequest): Promise<void> {
    // Encode the forwarder execute call
    const iface = new ethers.Interface([
      'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data) req, bytes signature) payable returns (bool, bytes)',
    ]);

    const calldata = iface.encodeFunctionData('execute', [
      {
        from: request.from,
        to: request.to,
        value: request.value,
        gas: request.gasLimit,
        nonce: request.nonce,
        deadline: request.deadline,
        data: request.data,
      },
      request.signature,
    ]);

    await this.provider.call({
      to: config.forwarderAddress,
      data: calldata,
    });
  }
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

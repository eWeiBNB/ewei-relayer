<div align="center">
  <img src="https://raw.githubusercontent.com/eWeiBNB/ewei-relayer/main/assets/logo.png" alt="eWei" width="120" />
</div>

# eWei Relayer Node

Open-source relay node for the [eWei gas sponsorship protocol](https://github.com/eWeiBNB/ewei-sdk) on BNB Smart Chain. The relayer accepts sponsored meta-transactions, validates them against on-chain policies, and submits them to the network on behalf of users who don't hold BNB for gas.

## Architecture

```
SDK/dApp  ──>  Relayer API  ──>  Queue (Redis)  ──>  Submitter  ──>  BSC
                   │                                      │
                   │                                      v
                   └─── Validator ◄── PolicyRegistry    Forwarder
                         │                              Contract
                         v
                      Simulator
```

The relayer node consists of:

- **REST API** — Receives sponsor requests from the eWei SDK, validates API keys, rate-limits
- **Transaction Validator** — Verifies EIP-712 signatures, checks policy constraints, simulates execution
- **Priority Queue** — Redis-backed sorted set with deduplication and retry logic
- **Submitter** — Picks transactions from the queue, manages hot wallet nonces, submits to BSC
- **Gas Oracle** — Tracks gas prices, detects spikes, caps maximum spend
- **Monitor** — Health checks, Prometheus metrics, wallet balance alerts

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env
# Edit .env with your RPC URL, private key, and contract addresses

docker compose up -d
```

The relayer API will be available at `http://localhost:3100`.

### Manual

```bash
# Prerequisites: Node.js 18+, PostgreSQL 14+, Redis 7+

npm install
npm run build

# Initialize database
psql $DATABASE_URL -f src/db/schema.sql

# Start
npm start
```

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
|----------|----------|-------------|
| `BSC_RPC_URL` | Yes | BNB Smart Chain RPC endpoint |
| `RELAYER_PRIVATE_KEY` | Yes | Hot wallet private key (hex) |
| `EWEI_FORWARDER_ADDRESS` | Yes | Deployed Forwarder contract |
| `EWEI_POLICY_REGISTRY_ADDRESS` | Yes | Deployed PolicyRegistry contract |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | No | Redis connection (default: localhost:6379) |
| `MAX_GAS_PRICE_GWEI` | No | Gas price ceiling (default: 10) |
| `MIN_BALANCE_THRESHOLD` | No | Alert when balance drops below (BNB, default: 0.05) |

## API

### Submit a sponsored transaction

```
POST /api/v1/relay
Authorization: Bearer ewei_...
```

```json
{
  "from": "0x...",
  "to": "0x...",
  "data": "0x...",
  "value": "0",
  "gasLimit": "200000",
  "deadline": 1704067200,
  "nonce": "1",
  "signature": "0x...",
  "policyId": "0x..."
}
```

**Response (202):**
```json
{
  "id": "uuid",
  "status": "queued",
  "message": "Transaction queued for relay"
}
```

### Check transaction status

```
GET /api/v1/relay/:txId
Authorization: Bearer ewei_...
```

### Health check

```
GET /health
```

## Monitoring

- **Health endpoint**: `GET /health` returns relayer status, wallet balance, queue depth, and dependency checks
- **Prometheus metrics**: Available on port `9090` at `/metrics`

Key metrics:
- `ewei_relayer_tx_submitted_total` — Transactions submitted
- `ewei_relayer_tx_confirmed_total` — Transactions confirmed
- `ewei_relayer_tx_failed_total` — Failed transactions by reason
- `ewei_relayer_queue_depth` — Current queue depth
- `ewei_relayer_wallet_balance_bnb` — Wallet balance
- `ewei_relayer_gas_price_gwei` — Current gas price

## Operator Guide

### Wallet Funding

The relayer hot wallet pays gas for all sponsored transactions. Monitor the `ewei_relayer_wallet_balance_bnb` metric and set alerts for when it drops below your threshold.

### Nonce Management

The relayer tracks nonces locally for performance. If transactions get stuck, the nonce will auto-resync. For manual intervention:

```sql
-- Check pending transactions
SELECT id, status, relayer_nonce, tx_hash, attempts
FROM transactions
WHERE status IN ('pending', 'submitted')
ORDER BY created_at DESC;
```

### Gas Spike Protection

The relayer automatically pauses when gas prices exceed `MAX_GAS_PRICE_GWEI`. Queued transactions will be held until prices normalize. The gas oracle polls every 12 seconds by default.

## Development

```bash
npm install
npm run dev          # Watch mode with tsx
npm test             # Run tests
npm run lint         # Lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup.

## License

MIT - see [LICENSE](LICENSE)

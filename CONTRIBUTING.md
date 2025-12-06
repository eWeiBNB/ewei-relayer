# Contributing to eWei Relayer

Thank you for your interest in contributing to the eWei relayer node. This document covers how to get started.

## Development Setup

1. **Prerequisites**
   - Node.js 18+
   - Docker and Docker Compose (for local Redis + PostgreSQL)
   - A BNB Smart Chain RPC endpoint

2. **Clone and install**
   ```bash
   git clone https://github.com/eWeiBNB/ewei-relayer.git
   cd ewei-relayer
   npm install
   ```

3. **Start dependencies**
   ```bash
   docker compose up -d postgres redis
   ```

4. **Configure**
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

5. **Run in development**
   ```bash
   npm run dev
   ```

## Code Style

- TypeScript strict mode is enforced
- Use `pino` for all logging (never `console.log`)
- All async functions must handle errors explicitly
- Database queries go through `src/db/index.ts` helpers

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## Pull Requests

- Branch from `main`
- Include tests for new functionality
- Ensure `npm run lint` passes
- Keep PRs focused on a single change

## Database Migrations

New migrations go in `src/db/migrations/` with sequential numbering:

```
002_add_feature.sql
003_another_change.sql
```

## Security

If you discover a security vulnerability, please email dev@ewei.io instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

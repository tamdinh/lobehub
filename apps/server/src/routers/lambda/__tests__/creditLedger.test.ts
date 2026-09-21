// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageLedgerService } from '@/business/server/usage/UsageLedgerService';
import type { LobeChatDatabase } from '@/database/type';

describe('SaaS Immutable Credit Ledger', () => {
  let mockDb: any;
  let ledgerStore: any[];

  beforeEach(() => {
    ledgerStore = [];
    mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => ({
          returning: vi.fn(async () => {
            const row = { id: `credit-${ledgerStore.length + 1}`, createdAt: new Date(), ...val };
            ledgerStore.push(row);
            return [row];
          }),
        })),
      })),
      query: {
        saasUsageEvents: {
          findMany: vi.fn(async (options?: any) => {
            return ledgerStore.filter((row) => {
              return row.eventType === 'CREDIT_GRANT' || row.eventType === 'CREDIT_CONSUMPTION';
            });
          }),
        },
      },
    };
  });

  it('grants immutable credits and updates balance', async () => {
    const service = new UsageLedgerService(mockDb as unknown as LobeChatDatabase);

    // Grant 100,000,000 micros ($100)
    await service.grantCredits({
      actorId: 'admin-1',
      amountMicros: 100_000_000,
      reason: 'Starter plan allocation',
      workspaceId: 'ws-tenant-1',
    });

    const balance = await service.getCreditBalance('ws-tenant-1');
    expect(balance.totalGrantedMicros).toBe(100_000_000);
    expect(balance.totalConsumedMicros).toBe(0);
    expect(balance.netBalanceMicros).toBe(100_000_000);
  });

  it('consumes credits and prevents balance deficit', async () => {
    const service = new UsageLedgerService(mockDb as unknown as LobeChatDatabase);

    // 1. Grant $50
    await service.grantCredits({
      actorId: 'admin-1',
      amountMicros: 50_000_000,
      reason: 'Pro plan credit',
      workspaceId: 'ws-tenant-1',
    });

    // 2. Consume $20
    await service.consumeCredits({
      actorId: 'user-1',
      amountMicros: 20_000_000,
      reason: 'Agent run execution',
      workspaceId: 'ws-tenant-1',
    });

    let balance = await service.getCreditBalance('ws-tenant-1');
    expect(balance.totalGrantedMicros).toBe(50_000_000);
    expect(balance.totalConsumedMicros).toBe(20_000_000);
    expect(balance.netBalanceMicros).toBe(30_000_000);

    // 3. Attempt to consume $40 (more than available $30) -> must throw INSUFFICIENT_CREDITS
    await expect(
      service.consumeCredits({
        actorId: 'user-1',
        amountMicros: 40_000_000,
        reason: 'Over-budget agent run',
        workspaceId: 'ws-tenant-1',
      }),
    ).rejects.toThrowError(/INSUFFICIENT_CREDITS/);
  });

  it('disregards expired credits when calculating net balance', async () => {
    const service = new UsageLedgerService(mockDb as unknown as LobeChatDatabase);

    // Grant $25 expired yesterday
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await service.grantCredits({
      actorId: 'promo-system',
      amountMicros: 25_000_000,
      expiresAt: yesterday,
      reason: 'Expired beta promo',
      workspaceId: 'ws-tenant-1',
    });

    // Grant $10 active
    await service.grantCredits({
      actorId: 'billing-admin',
      amountMicros: 10_000_000,
      reason: 'Paid top-up',
      workspaceId: 'ws-tenant-1',
    });

    const balance = await service.getCreditBalance('ws-tenant-1');
    // The expired $25 is excluded from available balance
    expect(balance.totalGrantedMicros).toBe(10_000_000);
    expect(balance.netBalanceMicros).toBe(10_000_000);
  });
});

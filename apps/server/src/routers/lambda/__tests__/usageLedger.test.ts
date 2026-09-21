// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageLedgerService } from '@/business/server/usage/UsageLedgerService';
import type { LobeChatDatabase } from '@/database/type';

describe('SaaS Immutable Usage Ledger', () => {
  let mockDb: any;
  let ledgerStore: any[];

  beforeEach(() => {
    ledgerStore = [];
    mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => ({
          returning: vi.fn(async () => {
            const row = { id: `event-${ledgerStore.length + 1}`, createdAt: new Date(), ...val };
            ledgerStore.push(row);
            return [row];
          }),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => {
            // Aggregate from ledgerStore
            const totalEvents = ledgerStore.length;
            const netCostMicros = ledgerStore.reduce((acc, r) => acc + (r.costMicros || 0), 0);
            const netInputTokens = ledgerStore.reduce((acc, r) => acc + (r.totalInputTokens || 0), 0);
            const netOutputTokens = ledgerStore.reduce((acc, r) => acc + (r.totalOutputTokens || 0), 0);
            const netTotalTokens = ledgerStore.reduce((acc, r) => acc + (r.totalTokens || 0), 0);

            return [{
              count: totalEvents,
              netCostMicros,
              netInputTokens,
              netOutputTokens,
              netTotalTokens,
            }];
          }),
        })),
      })),
    };
  });

  it('records an immutable usage event with correct token counts', async () => {
    const service = new UsageLedgerService(mockDb as unknown as LobeChatDatabase);

    const event = await service.recordUsageEvent({
      actorId: 'user-1',
      costMicros: 15000, // $0.015
      model: 'gpt-4o',
      provider: 'openai',
      requestId: 'req-1',
      runId: 'run-1',
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalTokens: 1500,
      workspaceId: 'ws-1',
    });

    expect(event.eventType).toBe('USAGE');
    expect(event.totalTokens).toBe(1500);
    expect(event.costMicros).toBe(15000);
    expect(ledgerStore).toHaveLength(1);
  });

  it('supports immutable adjustments and reversals without mutating historical events', async () => {
    const service = new UsageLedgerService(mockDb as unknown as LobeChatDatabase);

    // 1. Initial usage event
    const original = await service.recordUsageEvent({
      actorId: 'user-1',
      costMicros: 20000,
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      requestId: 'req-2',
      runId: 'run-2',
      totalInputTokens: 2000,
      totalOutputTokens: 1000,
      totalTokens: 3000,
      workspaceId: 'ws-1',
    });

    // 2. Adjustment (+500 tokens, +$0.005)
    await service.recordAdjustment({
      actorId: 'admin-1',
      adjustmentCostMicros: 5000,
      adjustmentTokens: 500,
      reason: 'Late prompt cache miss reconciliation',
      referenceEventId: original.id,
      workspaceId: 'ws-1',
    });

    // 3. Reversal (full refund of original)
    await service.recordReversal({
      actorId: 'billing-admin',
      originalEvent: original,
      reason: 'Network drop during streaming output',
    });

    // Verify 3 distinct rows exist in the ledger (nothing deleted/mutated)
    expect(ledgerStore).toHaveLength(3);
    expect(ledgerStore[0].eventType).toBe('USAGE');
    expect(ledgerStore[1].eventType).toBe('ADJUSTMENT');
    expect(ledgerStore[2].eventType).toBe('REVERSAL');

    // 4. Summarize: net cost should be 20000 + 5000 - 20000 = 5000 micros
    const summary = await service.getTenantUsageSummary({ workspaceId: 'ws-1' });
    expect(summary.totalEvents).toBe(3);
    expect(summary.netCostMicros).toBe(5000);
    expect(summary.netTotalTokens).toBe(500); // 3000 + 500 - 3000
  });
});

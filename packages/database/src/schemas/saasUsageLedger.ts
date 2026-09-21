import { bigint, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz } from './_helpers';
import { workspaces } from './workspace';

export type UsageEventType = 'USAGE' | 'ADJUSTMENT' | 'REVERSAL';

/**
 * Immutable Usage Ledger
 * Invariant: Never use mutable counters as the source of truth.
 * Historical records are never updated in-place.
 */
export const saasUsageEvents = pgTable(
  'saas_usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    /**
     * Type of event:
     * - USAGE: Direct token consumption from an agent run
     * - ADJUSTMENT: Correction/recalculation
     * - REVERSAL: Cancellation or refund of a previous usage event
     */
    eventType: text('event_type').$type<UsageEventType>().notNull().default('USAGE'),

    // Reference to original event if this is an ADJUSTMENT or REVERSAL
    referenceEventId: uuid('reference_event_id'),

    // Correlated identifiers
    runId: text('run_id'),
    requestId: text('request_id'),
    traceId: text('trace_id'),

    // Tenant & Actor scope
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    agentId: text('agent_id'),

    // Model details
    provider: text('provider'),
    model: text('model'),

    // Token accounting metrics
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),

    // Cost in micro-currency (1 USD = 1,000,000 micros)
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),

    // Context metadata
    metadata: jsonb('metadata').default({}),

    // Immutable timestamp - intentionally NO updatedAt
    createdAt: createdAt(),
  },
  (t) => [
    index('saas_usage_events_workspace_id_idx').on(t.workspaceId),
    index('saas_usage_events_actor_id_idx').on(t.actorId),
    index('saas_usage_events_run_id_idx').on(t.runId),
    index('saas_usage_events_created_at_idx').on(t.createdAt),
    index('saas_usage_events_event_type_idx').on(t.eventType),
  ],
);

export type SaasUsageEventItem = typeof saasUsageEvents.$inferSelect;
export type NewSaasUsageEvent = typeof saasUsageEvents.$inferInsert;

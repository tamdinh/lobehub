import { boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, timestamps, timestamptz } from './_helpers';
import { workspaces } from './workspace';

/**
 * Commercial Plan Definitions
 * Defines entitlements and limits associated with each tier.
 */
export const saasPlans = pgTable('saas_plans', {
  id: text('id').primaryKey(), // 'free' | 'pro' | 'enterprise'
  name: text('name').notNull(),
  description: text('description'),

  // Entitlements
  maxWorkspaces: integer('max_workspaces').notNull().default(1),
  maxAgents: integer('max_agents').notNull().default(5),
  monthlyTokens: integer('monthly_tokens').notNull().default(100000), // 100k free
  premiumModels: boolean('premium_models').notNull().default(false),
  backgroundAgents: boolean('background_agents').notNull().default(false),

  metadata: jsonb('metadata').default({}),

  ...timestamps,
});

export type SaasPlanItem = typeof saasPlans.$inferSelect;
export type NewSaasPlan = typeof saasPlans.$inferInsert;

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing';

/**
 * Tenant Subscriptions
 * Maps workspaces/organizations to commercial plans and tracks billing periods.
 */
export const saasSubscriptions = pgTable(
  'saas_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    organizationId: text('organization_id'),
    planId: text('plan_id')
      .references(() => saasPlans.id)
      .notNull(),

    status: text('status').$type<SubscriptionStatus>().notNull().default('active'),

    currentPeriodStart: timestamptz('current_period_start').notNull(),
    currentPeriodEnd: timestamptz('current_period_end').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),

    // External billing references (Stripe / LemonSqueezy)
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),

    metadata: jsonb('metadata').default({}),

    ...timestamps,
  },
  (t) => [
    index('saas_subscriptions_workspace_id_idx').on(t.workspaceId),
    index('saas_subscriptions_plan_id_idx').on(t.planId),
    index('saas_subscriptions_status_idx').on(t.status),
    index('saas_subscriptions_stripe_customer_id_idx').on(t.stripeCustomerId),
  ],
);

export type SaasSubscriptionItem = typeof saasSubscriptions.$inferSelect;
export type NewSaasSubscription = typeof saasSubscriptions.$inferInsert;

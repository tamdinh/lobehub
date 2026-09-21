// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  BillingAgent,
  ModelOperationsAgent,
  OperationsAgent,
  SecurityAgent,
  SupportAgent,
} from '@/business/server/admin/SpecialistAdminAgents';
import { ModelCatalogService } from '@/business/server/catalog/ModelCatalogService';

describe('SaaS Specialist AI Admin Read-Only Agents (Mission 5)', () => {
  it('OperationsAgent diagnoses run failures and generates non-destructive retry recommendations', async () => {
    const agent = new OperationsAgent();

    const report = await agent.diagnoseAgentRuns('ws-1', [
      { agentId: 'ag-1', runId: 'run-1', status: 'completed' },
      { agentId: 'ag-1', error: 'LLM Rate limit', runId: 'run-2', status: 'failed' },
    ]);

    expect(report.status).toBe('DEGRADED');
    expect(report.findings).toHaveLength(1);
    expect(report.recommendations).toHaveLength(1);

    const rec = report.recommendations[0];
    expect(rec.action).toBe('admin.agent.retry');
    expect(rec.riskLevel).toBe('LOW');
    expect(rec.confidence).toBeGreaterThan(0.8);
    expect(rec.parameters.runId).toBe('run-2');
  });

  it('SupportAgent diagnoses user access barriers without altering user state', async () => {
    const agent = new SupportAgent();

    // 1. Missing membership
    const uninvitedReport = await agent.diagnoseUserAccess({
      userId: 'usr-new',
      workspaceId: 'ws-1',
    });
    expect(uninvitedReport.status).toBe('DEGRADED');
    expect(uninvitedReport.findings[0]).toMatch(/no active membership/);
    expect(uninvitedReport.summary).toMatch(/lacks membership/);

    // 2. Suspended user
    const bannedReport = await agent.diagnoseUserAccess({
      isBanned: true,
      membershipRole: 'admin',
      userId: 'usr-bad',
      workspaceId: 'ws-1',
    });
    expect(bannedReport.status).toBe('CRITICAL');
    expect(bannedReport.findings[0]).toMatch(/suspended/);
  });

  it('ModelOperationsAgent detects candidate failure and recommends model disablement', async () => {
    const agent = new ModelOperationsAgent();
    const catalog = new ModelCatalogService();

    // When both openai and azure are down -> gpt-4o has zero healthy candidates
    const report = await agent.diagnoseModelHealth(catalog, ['openai', 'azure']);

    expect(report.status).toBe('CRITICAL');
    expect(report.recommendations.length).toBeGreaterThan(0);

    const gpt4oRec = report.recommendations.find((r) => r.targetResource === 'gpt-4o');
    expect(gpt4oRec).toBeDefined();
    expect(gpt4oRec?.action).toBe('admin.model.disable');
    expect(gpt4oRec?.riskLevel).toBe('MEDIUM');
  });

  it('SecurityAgent detects repeated access denial spikes and recommends account suspension', async () => {
    const agent = new SecurityAgent();

    const mockLogs = [
      { action: 'workspace.settings.update', actorId: 'usr-attacker', result: 'DENIED', workspaceId: 'ws-1' },
      { action: 'agent.delete', actorId: 'usr-attacker', result: 'DENIED', workspaceId: 'ws-1' },
      { action: 'apiKey.create', actorId: 'usr-attacker', result: 'DENIED', workspaceId: 'ws-1' },
      { action: 'agent.read', actorId: 'usr-legit', result: 'SUCCESS', workspaceId: 'ws-1' },
    ];

    const report = await agent.diagnoseSecurityAudit(mockLogs);

    expect(report.status).toBe('CRITICAL');
    expect(report.recommendations).toHaveLength(1);

    const rec = report.recommendations[0];
    expect(rec.action).toBe('admin.user.suspend');
    expect(rec.riskLevel).toBe('HIGH');
    expect(rec.targetResource).toBe('usr-attacker');
  });

  it('BillingAgent detects past due subscriptions and recommends freeze', async () => {
    const agent = new BillingAgent();

    const report = await agent.diagnoseBillingStatus({
      creditBalanceMicros: 0,
      monthlyTokensLimit: 1_000_000,
      monthlyTokensUsed: 1_200_000,
      subscriptionStatus: 'past_due',
      workspaceId: 'ws-delinquent',
    });

    expect(report.status).toBe('CRITICAL');
    expect(report.recommendations).toHaveLength(1);

    const rec = report.recommendations[0];
    expect(rec.action).toBe('admin.workspace.freeze');
    expect(rec.riskLevel).toBe('CRITICAL');
    expect(rec.targetResource).toBe('ws-delinquent');
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelCatalogService } from '@/business/server/catalog/ModelCatalogService';
import { ApprovalEngine } from '@/business/server/governance/ApprovalEngine';
import { ControlledAutonomyController } from '@/business/server/governance/ControlledAutonomyController';
import { RiskEngine } from '@/business/server/governance/RiskEngine';
import type { ActionRecommendation, ActorContext } from '@lobechat/types';

describe('SaaS Controlled Autonomy Controller (Mission 7)', () => {
  let riskEngine: RiskEngine;
  let approvalEngine: ApprovalEngine;
  let catalog: ModelCatalogService;
  let auditLogsStore: any[];
  let mockAuditService: any;

  beforeEach(() => {
    riskEngine = new RiskEngine();
    approvalEngine = new ApprovalEngine();
    catalog = new ModelCatalogService();
    auditLogsStore = [];
    mockAuditService = {
      recordAuditEvent: vi.fn(async (ev: any) => {
        auditLogsStore.push(ev);
      }),
    };
  });

  const systemActor: ActorContext = {
    actorId: 'system_autonomy_agent',
    actorType: 'SYSTEM',
    authSource: 'SYSTEM',
    organizationId: 'org_platform',
    permissions: ['*'],
    roles: ['admin'],
  };

  it('auto-remediates low-risk transient failures and records audit log', async () => {
    const controller = new ControlledAutonomyController(
      riskEngine,
      approvalEngine,
      mockAuditService,
      catalog,
    );

    const retryRecommendation: ActionRecommendation = {
      action: 'admin.agent.retry',
      agentType: 'OPERATIONS',
      confidence: 0.95,
      createdAt: new Date(),
      id: 'rec_retry_1',
      parameters: { runId: 'run_failed_100' },
      reasoning: 'Transient rate limit failure',
      riskLevel: 'LOW',
      targetResource: 'run_failed_100',
    };

    const result = await controller.processRecommendation(
      retryRecommendation,
      systemActor,
      'ws_tenant_1',
    );

    expect(result.status).toBe('AUTO_REMEDIATED');
    expect(result.executed).toBe(true);
    expect(result.remediationId).toMatch(/^rem_/);
    expect(controller.getExecutionCount('run_failed_100')).toBe(1);

    expect(mockAuditService.recordAuditEvent).toHaveBeenCalled();
    expect(auditLogsStore[0].action).toBe('autonomy.remediated.admin.agent.retry');
  });

  it('prevents runaway self-healing loops by capping auto-remediations per resource', async () => {
    const controller = new ControlledAutonomyController(
      riskEngine,
      approvalEngine,
      mockAuditService,
      catalog,
    );

    const retryRecommendation: ActionRecommendation = {
      action: 'admin.agent.retry',
      agentType: 'OPERATIONS',
      confidence: 0.95,
      createdAt: new Date(),
      id: 'rec_retry_loop',
      parameters: { runId: 'run_stuck_forever' },
      reasoning: 'Persistent failure',
      riskLevel: 'LOW',
      targetResource: 'run_stuck_forever',
    };

    // 1. Run 3 times (allowed)
    await controller.processRecommendation(retryRecommendation, systemActor, 'ws_tenant_1');
    await controller.processRecommendation(retryRecommendation, systemActor, 'ws_tenant_1');
    await controller.processRecommendation(retryRecommendation, systemActor, 'ws_tenant_1');
    expect(controller.getExecutionCount('run_stuck_forever')).toBe(3);

    // 2. Attempt 4th time -> BLOCKED_LOOP_LIMIT
    const blockedResult = await controller.processRecommendation(
      retryRecommendation,
      systemActor,
      'ws_tenant_1',
    );

    expect(blockedResult.status).toBe('BLOCKED_LOOP_LIMIT');
    expect(blockedResult.executed).toBe(false);
    expect(blockedResult.reason).toMatch(/Max automated remediation attempts/);
    expect(auditLogsStore.some((l) => l.action === 'autonomy.loop_limit_exceeded')).toBe(true);
  });

  it('auto-remediates model disablement and updates catalog', async () => {
    const controller = new ControlledAutonomyController(
      riskEngine,
      approvalEngine,
      mockAuditService,
      catalog,
    );

    expect(catalog.getModel('gpt-4o')?.enabled).toBe(true);

    const disableRecommendation: ActionRecommendation = {
      action: 'admin.model.disable',
      agentType: 'MODEL_OPS',
      confidence: 0.98,
      createdAt: new Date(),
      id: 'rec_disable_1',
      parameters: { modelId: 'gpt-4o' },
      reasoning: 'All upstream providers down',
      riskLevel: 'MEDIUM',
      targetResource: 'gpt-4o',
    };

    const result = await controller.processRecommendation(
      disableRecommendation,
      systemActor,
      'system',
    );

    expect(result.status).toBe('AUTO_REMEDIATED');
    expect(result.executed).toBe(true);
    expect(catalog.getModel('gpt-4o')?.enabled).toBe(false);
  });

  it('unconditionally escalates high and critical risk actions to ApprovalEngine', async () => {
    const controller = new ControlledAutonomyController(
      riskEngine,
      approvalEngine,
      mockAuditService,
      catalog,
    );

    const freezeRecommendation: ActionRecommendation = {
      action: 'admin.workspace.freeze',
      agentType: 'BILLING',
      confidence: 0.99,
      createdAt: new Date(),
      id: 'rec_freeze_delinquent',
      parameters: { reason: 'Severe delinquency', workspaceId: 'ws_delinquent' },
      reasoning: 'Subscription canceled, payment failed',
      riskLevel: 'CRITICAL',
      targetResource: 'ws_delinquent',
    };

    const result = await controller.processRecommendation(
      freezeRecommendation,
      systemActor,
      'ws_delinquent',
    );

    expect(result.status).toBe('ESCALATED_FOR_APPROVAL');
    expect(result.executed).toBe(false);
    expect(result.approvalId).toMatch(/^apr_/);

    expect(auditLogsStore.some((l) => l.action === 'autonomy.escalated_to_approval')).toBe(true);
  });
});

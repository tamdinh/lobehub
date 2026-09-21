// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMMERCIAL_MODELS,
  ModelCatalogService,
} from '@/business/server/catalog/ModelCatalogService';

describe('SaaS Model Catalog & Capability Routing', () => {
  it('loads default commercial models and filters by tier and capability', () => {
    const catalog = new ModelCatalogService();

    const standardModels = catalog.listModels({ tier: 'standard' });
    expect(standardModels.length).toBeGreaterThan(0);
    expect(standardModels.map((m) => m.id)).toContain('gpt-4o');

    const reasoningModels = catalog.listModels({ capability: 'reasoning' });
    expect(reasoningModels.map((m) => m.id)).toContain('o1');
    expect(reasoningModels.map((m) => m.id)).not.toContain('gpt-4o-mini');
  });

  it('resolves commercial model to highest priority healthy runtime provider', () => {
    const catalog = new ModelCatalogService();

    // Default resolution: priority 1 (anthropic)
    const result = catalog.resolveRuntimeProvider({
      modelId: 'claude-3-5-sonnet',
      requiredCapabilities: ['tool_call'],
    });

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('supports failover to candidate provider when primary is unhealthy', () => {
    const catalog = new ModelCatalogService();

    // Anthropic is marked unhealthy -> fails over to Bedrock (priority 2)
    const result = catalog.resolveRuntimeProvider({
      modelId: 'claude-3-5-sonnet',
      unhealthyProviders: ['anthropic'],
    });

    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('anthropic.claude-3-5-sonnet-v2');
  });

  it('rejects execution when required capability is missing', () => {
    const catalog = new ModelCatalogService();

    expect(() =>
      catalog.resolveRuntimeProvider({
        modelId: 'o1',
        requiredCapabilities: ['vision'], // o1 does not support vision
      }),
    ).toThrowError(/CAPABILITY_NOT_SUPPORTED/);
  });

  it('rejects execution when all provider candidates are unhealthy', () => {
    const catalog = new ModelCatalogService();

    expect(() =>
      catalog.resolveRuntimeProvider({
        modelId: 'claude-3-5-sonnet',
        unhealthyProviders: ['anthropic', 'bedrock'],
      }),
    ).toThrowError(/NO_HEALTHY_PROVIDER_CANDIDATE/);
  });
});

import type {
  CommercialModel,
  ModelCapability,
  ModelTier,
  ProviderCandidate,
} from '@lobechat/types';

export const DEFAULT_COMMERCIAL_MODELS: CommercialModel[] = [
  {
    candidates: [
      {
        costPer1kInputTokensMicros: 150,
        costPer1kOutputTokensMicros: 600,
        enabled: true,
        model: 'gpt-4o-mini',
        priority: 1,
        provider: 'openai',
      },
    ],
    capabilities: ['chat', 'vision', 'tool_call', 'json_mode', 'code'],
    contextWindow: 128000,
    description: 'Fast, lightweight model for everyday tasks',
    enabled: true,
    id: 'gpt-4o-mini',
    maxOutputTokens: 16384,
    name: 'GPT-4o Mini',
    tier: 'standard',
  },
  {
    candidates: [
      {
        costPer1kInputTokensMicros: 2500,
        costPer1kOutputTokensMicros: 10000,
        enabled: true,
        model: 'gpt-4o',
        priority: 1,
        provider: 'openai',
      },
      {
        costPer1kInputTokensMicros: 2500,
        costPer1kOutputTokensMicros: 10000,
        enabled: true,
        model: 'gpt-4o-deployment',
        priority: 2,
        provider: 'azure',
      },
    ],
    capabilities: ['chat', 'vision', 'tool_call', 'json_mode', 'code'],
    contextWindow: 128000,
    description: 'Flagship versatile multimodal model',
    enabled: true,
    id: 'gpt-4o',
    maxOutputTokens: 16384,
    name: 'GPT-4o',
    tier: 'standard',
  },
  {
    candidates: [
      {
        costPer1kInputTokensMicros: 3000,
        costPer1kOutputTokensMicros: 15000,
        enabled: true,
        model: 'claude-3-5-sonnet-20241022',
        priority: 1,
        provider: 'anthropic',
      },
      {
        costPer1kInputTokensMicros: 3000,
        costPer1kOutputTokensMicros: 15000,
        enabled: true,
        model: 'anthropic.claude-3-5-sonnet-v2',
        priority: 2,
        provider: 'bedrock',
      },
    ],
    capabilities: ['chat', 'vision', 'tool_call', 'code'],
    contextWindow: 200000,
    description: 'State of the art reasoning and coding model',
    enabled: true,
    id: 'claude-3-5-sonnet',
    maxOutputTokens: 8192,
    name: 'Claude 3.5 Sonnet',
    tier: 'premium',
  },
  {
    candidates: [
      {
        costPer1kInputTokensMicros: 15000,
        costPer1kOutputTokensMicros: 60000,
        enabled: true,
        model: 'o1',
        priority: 1,
        provider: 'openai',
      },
    ],
    capabilities: ['chat', 'reasoning', 'code'],
    contextWindow: 200000,
    description: 'Deep reasoning model for complex STEM and math',
    enabled: true,
    id: 'o1',
    maxOutputTokens: 100000,
    name: 'OpenAI o1',
    tier: 'enterprise',
  },
];

export class ModelCatalogService {
  private models: Map<string, CommercialModel> = new Map();

  constructor(initialModels: CommercialModel[] = DEFAULT_COMMERCIAL_MODELS) {
    for (const model of initialModels) {
      this.models.set(model.id, model);
    }
  }

  registerModel = (model: CommercialModel): void => {
    this.models.set(model.id, model);
  };

  getModel = (modelId: string): CommercialModel | undefined => {
    return this.models.get(modelId);
  };

  listModels = (filter?: {
    capability?: ModelCapability;
    enabledOnly?: boolean;
    tier?: ModelTier;
  }): CommercialModel[] => {
    let result = Array.from(this.models.values());

    if (filter?.enabledOnly !== false) {
      result = result.filter((m) => m.enabled);
    }
    if (filter?.tier) {
      result = result.filter((m) => m.tier === filter.tier);
    }
    if (filter?.capability) {
      result = result.filter((m) => m.capabilities.includes(filter.capability!));
    }

    return result;
  };

  /**
   * Resolves a commercial model to a concrete runtime provider candidate.
   * Encapsulates candidate failover, capability verification, and provider decoupling.
   */
  resolveRuntimeProvider = (params: {
    modelId: string;
    requiredCapabilities?: ModelCapability[];
    unhealthyProviders?: string[];
  }): { candidate: ProviderCandidate; model: string; provider: string } => {
    const commercialModel = this.models.get(params.modelId);

    if (!commercialModel || !commercialModel.enabled) {
      throw new Error(`COMMERCIAL_MODEL_NOT_FOUND: Model '${params.modelId}' is not available.`);
    }

    if (params.requiredCapabilities && params.requiredCapabilities.length > 0) {
      for (const cap of params.requiredCapabilities) {
        if (!commercialModel.capabilities.includes(cap)) {
          throw new Error(
            `CAPABILITY_NOT_SUPPORTED: Model '${params.modelId}' lacks required capability '${cap}'.`,
          );
        }
      }
    }

    const unhealthy = new Set(params.unhealthyProviders || []);
    const eligibleCandidates = commercialModel.candidates
      .filter((c) => c.enabled !== false && !unhealthy.has(c.provider))
      .sort((a, b) => a.priority - b.priority);

    if (eligibleCandidates.length === 0) {
      throw new Error(
        `NO_HEALTHY_PROVIDER_CANDIDATE: All backend candidates for '${params.modelId}' are unhealthy or disabled.`,
      );
    }

    const chosen = eligibleCandidates[0];
    return {
      candidate: chosen,
      model: chosen.model,
      provider: chosen.provider,
    };
  };
}

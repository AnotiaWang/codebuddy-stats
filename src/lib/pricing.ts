export interface PricingTier {
  limit: number
  pricePerMTok: number
}

export interface ModelPricing {
  prompt: PricingTier[]
  completion: PricingTier[]
  cacheRead: PricingTier[]
  cacheWrite: PricingTier[]
}

// 模型价格 (USD / 1M tokens)
function createPricing(
  inputPrice: number,
  cachedInputPrice: number,
  outputPrice: number,
  cacheWritePrice?: number
): ModelPricing {
  return {
    prompt: [{ limit: Number.POSITIVE_INFINITY, pricePerMTok: inputPrice }],
    completion: [{ limit: Number.POSITIVE_INFINITY, pricePerMTok: outputPrice }],
    cacheRead: [{ limit: Number.POSITIVE_INFINITY, pricePerMTok: cachedInputPrice }],
    cacheWrite: [
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: cacheWritePrice ?? inputPrice },
    ],
  }
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.2': createPricing(1.75, 0.175, 14.0),
  'gpt-5.1': createPricing(1.25, 0.125, 10.0),
  'gpt-5': createPricing(1.25, 0.125, 10.0),
  'gpt-5-mini': createPricing(0.25, 0.025, 2.0),
  'gpt-5-nano': createPricing(0.05, 0.005, 0.4),
  'gpt-5.1-chat-latest': createPricing(1.25, 0.125, 10.0),
  'gpt-5-chat-latest': createPricing(1.25, 0.125, 10.0),
  'gpt-5.1-codex': createPricing(1.25, 0.125, 10.0),
  'gpt-5-codex': createPricing(1.25, 0.125, 10.0),

  'claude-opus-4.5': createPricing(5.0, 0.5, 25.0, 10.0),

  'claude-4.5': {
    prompt: [
      { limit: 200_000, pricePerMTok: 3.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 6.0 },
    ],
    completion: [
      { limit: 200_000, pricePerMTok: 15.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 22.5 },
    ],
    cacheRead: [
      { limit: 200_000, pricePerMTok: 0.3 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 0.6 },
    ],
    cacheWrite: [
      { limit: 200_000, pricePerMTok: 6.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 12.0 },
    ],
  },

  'gemini-3-pro': {
    prompt: [
      { limit: 200_000, pricePerMTok: 2.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 4.0 },
    ],
    completion: [
      { limit: 200_000, pricePerMTok: 12.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 18.0 },
    ],
    cacheRead: [
      { limit: 200_000, pricePerMTok: 0.2 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 0.4 },
    ],
    cacheWrite: [
      { limit: 200_000, pricePerMTok: 0.2 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 0.4 },
    ],
  },

  'gemini-2.5-pro': {
    prompt: [
      { limit: 200_000, pricePerMTok: 1.25 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 2.5 },
    ],
    completion: [
      { limit: 200_000, pricePerMTok: 10.0 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 15.0 },
    ],
    cacheRead: [
      { limit: 200_000, pricePerMTok: 0.125 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 0.25 },
    ],
    cacheWrite: [
      { limit: 200_000, pricePerMTok: 0.125 },
      { limit: Number.POSITIVE_INFINITY, pricePerMTok: 0.25 },
    ],
  },
}

export const DEFAULT_MODEL_ID = 'gpt-5.1' as const

export function selectTierPrice(tokens: number, tiers: PricingTier[]): number {
  if (tokens <= 0) return tiers[0]?.pricePerMTok ?? 0
  for (const tier of tiers) {
    if (tokens <= tier.limit) {
      return tier.pricePerMTok
    }
  }
  return tiers[tiers.length - 1]?.pricePerMTok ?? 0
}

export function tokensToCost(tokens: number, tiers: PricingTier[]): number {
  if (!tokens) return 0
  const price = selectTierPrice(tokens, tiers)
  return (tokens / 1_000_000) * price
}

export function getPricingForModel(modelId: string | null | undefined): ModelPricing {
  if (modelId && MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId]
  }
  const fallback = MODEL_PRICING[DEFAULT_MODEL_ID]
  if (!fallback) {
    throw new Error(`Missing pricing for default model: ${DEFAULT_MODEL_ID}`)
  }
  return fallback
}

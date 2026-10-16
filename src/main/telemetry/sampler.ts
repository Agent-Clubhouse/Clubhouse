/**
 * FlowSampler (spec §6.4). Flow roots are sampled at the advanced "trace
 * sample rate" (1.0 by default) with ParentBased(TraceIdRatioBased)
 * semantics, and every sampled span carries `microsoft.sample_rate` so App
 * Insights `itemCount` stays correct. The Errors-level tail decision is made
 * later by ErrorTailSpanProcessor, not here: a sampler cannot see the outcome.
 */
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import {
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from '@opentelemetry/sdk-trace-base';
import { SDK_ATTRIBUTE_KEYS } from '../../shared/telemetry/attributes';

export class FlowSampler implements Sampler {
  private readonly delegate: Sampler;
  private readonly samplePercent: number;

  constructor(readonly sampleRate = 1) {
    const rate = sampleRate > 0 && sampleRate <= 1 ? sampleRate : 1;
    this.samplePercent = Math.round(rate * 10000) / 100;
    this.delegate = new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(rate) });
  }

  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const result = this.delegate.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
    if (result.decision !== SamplingDecision.RECORD_AND_SAMPLED) return result;
    // App Insights reads the rate per item, so every sampled span carries it.
    return {
      ...result,
      attributes: { ...result.attributes, [SDK_ATTRIBUTE_KEYS.sampleRate]: this.samplePercent },
    };
  }

  toString(): string {
    return `FlowSampler{rate=${this.sampleRate}}`;
  }
}

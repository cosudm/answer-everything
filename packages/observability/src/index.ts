import { trace, type Span, SpanStatusCode } from "@opentelemetry/api";
import pino, { type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
}

/**
 * Structured JSON logging. Fields that could carry user content or secrets
 * are redacted at the logger so no call site can leak them by accident.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const pretty = opts.pretty ?? (process.env.NODE_ENV !== "production" && process.stdout.isTTY);
  return pino({
    name: opts.name,
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.password",
        "*.token",
        "*.refreshToken",
        "*.content",
        "*.messages",
        "*.system",
      ],
      censor: "[redacted]",
    },
    transport: pretty ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } : undefined,
  });
}

const tracer = trace.getTracer("answer-everything");

/**
 * Wraps work in an OpenTelemetry span. With no SDK configured (local dev)
 * this is a no-op tracer; deployments configure an OTLP exporter via env.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attributes)) if (v !== undefined) span.setAttribute(k, v);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Minimal in-process metrics. Exposed at /metrics by the API in Prometheus  */
/* text format so any scraper (or Application Insights via OTel) can read.   */
/* ------------------------------------------------------------------------ */

type LabelSet = Record<string, string>;

class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}
  inc(labels: LabelSet = {}, by = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, v] of this.values) lines.push(`${this.name}${key} ${v}`);
    return lines.join("\n");
  }
}

class Histogram {
  private readonly buckets = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
  private readonly counts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}
  observe(labels: LabelSet, value: number) {
    const key = labelKey(labels);
    const arr = this.counts.get(key) ?? new Array(this.buckets.length).fill(0);
    this.buckets.forEach((b, i) => {
      if (value <= b) arr[i] = (arr[i] ?? 0) + 1;
    });
    this.counts.set(key, arr);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, arr] of this.counts) {
      const base = key.slice(1, -1);
      this.buckets.forEach((b, i) =>
        lines.push(`${this.name}_bucket{${base}${base ? "," : ""}le="${b}"} ${arr[i]}`),
      );
      lines.push(`${this.name}_bucket{${base}${base ? "," : ""}le="+Inf"} ${this.totals.get(key)}`);
      lines.push(`${this.name}_sum${key} ${this.sums.get(key)}`);
      lines.push(`${this.name}_count${key} ${this.totals.get(key)}`);
    }
    return lines.join("\n");
  }
}

function labelKey(labels: LabelSet): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "";
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(",")}}`;
}

export const metrics = {
  httpRequests: new Counter("ae_http_requests_total", "HTTP requests by route and status"),
  modelRuns: new Counter("ae_model_runs_total", "Model runs by model and status"),
  modelTokens: new Counter("ae_model_tokens_total", "Tokens by model and direction"),
  modelCostUsd: new Counter("ae_model_cost_usd_total", "Estimated model spend in USD"),
  authzDecisions: new Counter("ae_authorization_decisions_total", "Authorization decisions by outcome"),
  jobs: new Counter("ae_jobs_total", "Background jobs by type and status"),
  modelLatency: new Histogram("ae_model_latency_ms", "Model run latency in ms"),
  render(): string {
    return [
      this.httpRequests,
      this.modelRuns,
      this.modelTokens,
      this.modelCostUsd,
      this.authzDecisions,
      this.jobs,
      this.modelLatency,
    ]
      .map((m) => m.render())
      .join("\n\n");
  },
};

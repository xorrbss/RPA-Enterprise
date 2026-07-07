export type ElementType = "button" | "input" | "link" | "table" | "row" | "field" | "message" | "other";
export type ElementStability = "stable" | "review_needed" | "broken";
export type ElementSource = "manual" | "pbd" | "capture" | "imported";
export type ElementProbeStatus = "matched" | "not_found" | "invalid_selector" | "failed" | "not_run";
export type ElementConfidence = "high" | "medium" | "low" | "unknown";

export interface SiteElementRow {
  id: string;
  site_profile_id: string;
  element_key: string;
  label: string;
  selector: string;
  element_type: ElementType;
  stability: ElementStability;
  confidence: ElementConfidence;
  source: ElementSource;
  sample_url: string | null;
  last_probe_result: unknown;
  notes: string | null;
  usage_count: number;
  last_verified_at: Date | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

export interface CreateBody {
  readonly elementKey: string;
  readonly label: string;
  readonly selector: string;
  readonly elementType: ElementType;
  readonly stability: ElementStability;
  readonly source: ElementSource;
  readonly sampleUrl: string | null;
  readonly notes: string | null;
}

export interface UpdateBody {
  label?: string;
  selector?: string;
  elementType?: ElementType;
  stability?: ElementStability;
  sampleUrl?: string | null;
  notes?: string | null;
}

export interface ProbeBody {
  readonly sampleUrl: string | null;
}

export function mapElement(row: SiteElementRow): Record<string, unknown> {
  return {
    element_id: row.id,
    site_profile_id: row.site_profile_id,
    element_key: row.element_key,
    label: row.label,
    selector: row.selector,
    element_type: row.element_type,
    stability: row.stability,
    confidence: row.confidence,
    source: row.source,
    sample_url: row.sample_url,
    last_probe_result: row.last_probe_result,
    notes: row.notes,
    usage_count: row.usage_count,
    last_verified_at: row.last_verified_at !== null ? row.last_verified_at.toISOString() : null,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

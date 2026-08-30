export type DocumentRoundTripIssueCode =
  | "ROUND_TRIP_PART_MISSING"
  | "ROUND_TRIP_PART_CHANGED"
  | "ROUND_TRIP_CONTENT_TYPE_CHANGED"
  | "ROUND_TRIP_UNSUPPORTED_PART_ADDED"
  | "ROUND_TRIP_RELATIONSHIP_LOST"
  | "ROUND_TRIP_RELATIONSHIP_CHANGED"
  | "ROUND_TRIP_RELATIONSHIP_ADDED"
  | "ROUND_TRIP_PACKAGE_INVALID";

export interface DocumentRoundTripPreservationIssue {
  code: DocumentRoundTripIssueCode;
  entry?: string;
  relationshipId?: string;
  relationshipType?: string;
  reason: string;
}

export interface DocumentRoundTripPreservationReport {
  safe: boolean;
  issues: readonly DocumentRoundTripPreservationIssue[];
}

/** Authoritative save boundary for checking that an editor preserved opaque DOCX data. */
export interface DocumentRoundTripSentinelPort {
  verify(input: { sourceBytes: Uint8Array; outputBytes: Uint8Array }): Promise<DocumentRoundTripPreservationReport>;
}

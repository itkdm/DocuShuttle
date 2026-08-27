export interface CapabilityCatalogEntry {
  readonly featureId: string;
  readonly spec: string;
  readonly read: boolean;
  readonly preserve: boolean;
  readonly agentVisible: boolean;
  readonly editable: "supported" | "guarded" | "unsupported";
  readonly operations: readonly string[];
  readonly validation: readonly string[];
  readonly fixtures: readonly string[];
  readonly knownGaps: readonly string[];
}

/** Machine-readable conformance source of truth; UI/docs may project this catalog. */
export const capabilityCatalog: readonly CapabilityCatalogEntry[] = Object.freeze([
  { featureId: "paragraph", spec: "w:p/w:r/w:t", read: true, preserve: true, agentVisible: true, editable: "supported", operations: ["read", "replace-text"], validation: ["xml-well-formed", "semantic", "source-preservation"], fixtures: ["synthetic", "real-docx"], knownGaps: ["fields", "tracked revisions", "content controls", "cross-run default guarded"] },
  { featureId: "table-cell", spec: "w:tbl/w:tr/w:tc", read: true, preserve: true, agentVisible: true, editable: "supported", operations: ["read", "set-cell-text"], validation: ["xml-well-formed", "semantic", "source-preservation"], fixtures: ["synthetic", "real-docx"], knownGaps: ["nested-table container guarded"] },
  { featureId: "image", spec: "a:blip/@r:embed + OPC media part", read: true, preserve: true, agentVisible: true, editable: "supported", operations: ["read", "replace-image"], validation: ["opc-integrity", "semantic", "source-preservation"], fixtures: ["synthetic", "real-docx"], knownGaps: ["shared media guarded"] },
  { featureId: "textbox", spec: "w:txbxContent + mc:AlternateContent", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["xml-well-formed", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["Choice/Fallback coherence adapter"] },
  { featureId: "cross-run-text", spec: "multiple w:r/w:t in one paragraph", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read", "replace-text with inherit-start"], validation: ["xml-well-formed", "semantic", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["dominant/end/explicit format policies"] },
  { featureId: "nested-table-container", spec: "w:tc containing child w:tbl", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["xml-well-formed", "source-preservation"], fixtures: ["synthetic", "real-docx"], knownGaps: ["container text replacement"] },
  { featureId: "shared-media", spec: "multiple drawings referencing one media part", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["opc-integrity", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["instance-level media cloning"] },
  { featureId: "content-control", spec: "w:sdt", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["xml-well-formed", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["sdtContent mutation and lock semantics"] },
  { featureId: "field", spec: "w:fldSimple/w:fldChar", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["xml-well-formed", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["instruction/result operations"] },
  { featureId: "tracked-revision", spec: "w:ins/w:del/w:moveFrom/w:moveTo", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["xml-well-formed", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["accept/reject and native tracked mutation"] },
  { featureId: "signed-package", spec: "OPC digital signature parts/relationships", read: true, preserve: true, agentVisible: true, editable: "guarded", operations: ["read"], validation: ["opc-integrity", "source-preservation"], fixtures: ["synthetic"], knownGaps: ["explicit signature re-issuance"] },
]);

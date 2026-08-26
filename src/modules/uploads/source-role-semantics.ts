import type { SourceRole } from "@/modules/tasks/domain";

export type SourceRegistration = {
  sourceFileId: string;
  role: SourceRole;
  originalName?: string;
  workingDocumentId?: string;
  versionId?: string;
};

export type SourceRegistrationState = {
  template?: SourceRegistration;
  example?: SourceRegistration;
  auxiliary: SourceRegistration[];
  workingTemplateSourceId?: string;
  workingDocumentId?: string;
};

export const emptySourceRegistrationState = (): SourceRegistrationState => ({ auxiliary: [] });

/**
 * Fold a completed upload into task source metadata. The template is the only
 * source allowed to establish the editable Working Document; an example is
 * retained as reference material and never changes the current document.
 */
export const reduceSourceRegistration = (
  state: SourceRegistrationState,
  registration: SourceRegistration,
): SourceRegistrationState => {
  if (registration.role === "template") {
    return {
      ...state,
      template: registration,
      workingTemplateSourceId: registration.versionId ? registration.sourceFileId : state.workingTemplateSourceId,
      workingDocumentId: registration.workingDocumentId ?? state.workingDocumentId,
    };
  }
  if (registration.role === "example") return { ...state, example: registration };
  return { ...state, auxiliary: [...state.auxiliary, registration] };
};

export const isWorkingDocumentUpload = (role: SourceRole, registration: Pick<SourceRegistration, "workingDocumentId" | "versionId">) =>
  role === "template" && Boolean(registration.workingDocumentId && registration.versionId);

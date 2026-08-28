import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { SupabaseWorkingDocumentAccess } from "./working-document-access";
import { assertTaskObjectKey } from "@/modules/storage/object-key";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

describe("SupabaseWorkingDocumentAccess.commit", () => {
  it("uses executor-owned version instead of the database current version", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({ data: { owner_user_id: "user-1", working_document_id: "document-1", lock_version: 999 }, error: null });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "AGENT_RUN_CONFLICT" } });
    const client = { from: vi.fn().mockReturnValue(query), rpc } as unknown as SupabaseClient;
    const storage: PrivateObjectStoragePort = {
      ensureObject: vi.fn().mockResolvedValue({ created: true }),
      put: vi.fn(), get: vi.fn(), remove: vi.fn().mockResolvedValue(undefined),
      createSignedUpload: vi.fn(), createSignedDownload: vi.fn(),
    };
    const access = new SupabaseWorkingDocumentAccess(client, "task-1", "run-1", () => 10, storage);

    await expect(access.commit({
      idempotencyKey: "run-1:stale-call", expectedRevision: "revision-1", bytes: new Uint8Array([1]), revision: "revision-2", changedEntries: [],
      effectReceipt: { idempotencyKey: "run-1:stale-call", callId: "stale-call", toolName: "apply_text_change", output: {}, completedAt: "2026-08-28T00:00:00.000Z", stepId: "stale-call", effect: "apply" },
    })).rejects.toThrow("AGENT_RUN_CONFLICT");
    expect(rpc).toHaveBeenCalledWith("commit_loop_document_version", expect.objectContaining({ p_expected_run_version: 10 }));
    expect(rpc).not.toHaveBeenCalledWith("commit_loop_document_version", expect.objectContaining({ p_expected_run_version: 999 }));
  });

  it("fails before staging objects when executor ownership is unavailable", async () => {
    const from = vi.fn();
    const storage: PrivateObjectStoragePort = {
      ensureObject: vi.fn(), put: vi.fn(), get: vi.fn(), remove: vi.fn(),
      createSignedUpload: vi.fn(), createSignedDownload: vi.fn(),
    };
    const access = new SupabaseWorkingDocumentAccess({ from } as unknown as SupabaseClient, "task-1", "run-1", () => undefined, storage);

    await expect(access.commit({
      idempotencyKey: "run-1:missing-owner", expectedRevision: "revision-1", bytes: new Uint8Array([1]), revision: "revision-2", changedEntries: [],
      effectReceipt: { idempotencyKey: "run-1:missing-owner", callId: "missing-owner", toolName: "apply_text_change", output: {}, completedAt: "2026-08-28T00:00:00.000Z", stepId: "missing-owner", effect: "apply" },
    })).rejects.toThrow("changed while it was being updated");
    expect(from).not.toHaveBeenCalled();
    expect(storage.ensureObject).not.toHaveBeenCalled();
  });

  it("derives safe version and manifest keys before the real commit RPC", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { owner_user_id: "user-1", working_document_id: "document-1", lock_version: 4 },
      error: null,
    });
    const rpc = vi.fn().mockResolvedValue({ data: { kind: "committed", revision: "revision-2" }, error: null });
    const client = { from: vi.fn().mockReturnValue(query), rpc } as unknown as SupabaseClient;
    const uploaded: string[] = [];
    const storage: PrivateObjectStoragePort = {
      put: vi.fn(async (objectKey: string) => { uploaded.push(objectKey); }),
      get: vi.fn(),
      remove: vi.fn(),
      createSignedUpload: vi.fn(),
      createSignedDownload: vi.fn(),
    };
    const access = new SupabaseWorkingDocumentAccess(client, "task-1", "run-1", () => 4, storage);

    const result = await access.commit({
      idempotencyKey: "run:run-1/call:call-1",
      expectedRevision: "revision-1",
      bytes: new Uint8Array([1, 2, 3]),
      revision: "revision-2",
      changedEntries: ["word/document.xml"],
      effectReceipt: {
        idempotencyKey: "run:run-1/call:call-1",
        callId: "call-1",
        toolName: "apply_text_change",
        output: { revision: "revision-2" },
        completedAt: "2026-08-28T00:00:00.000Z",
        stepId: "call-1",
        effect: "apply",
      },
    });

    expect(result).toEqual({ revision: "revision-2" });
    expect(query.select).toHaveBeenCalledWith("owner_user_id, working_document_id");
    expect(uploaded).toHaveLength(2);
    uploaded.forEach(assertTaskObjectKey);
    expect(uploaded[0]).toMatch(/\/versions\/[a-f0-9]{64}\.docx$/);
    expect(uploaded[1]).toMatch(/\/manifests\/[a-f0-9]{64}\.json$/);
    expect(rpc).toHaveBeenCalledWith("commit_loop_document_version", expect.objectContaining({
      p_expected_run_version: 4,
      p_output_ref: expect.stringContaining(uploaded[0]),
      p_receipt: expect.objectContaining({ idempotencyKey: "run:run-1/call:call-1", effect: "apply" }),
    }));
  });

  it("keeps staged objects when the document RPC response is ambiguous", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({ data: { owner_user_id: "user-1", working_document_id: "document-1", lock_version: 4 }, error: null });
    const client = { from: vi.fn().mockReturnValue(query), rpc: vi.fn().mockRejectedValue(new Error("connection reset")) } as unknown as SupabaseClient;
    const removed: string[] = [];
    const storage: PrivateObjectStoragePort = {
      ensureObject: vi.fn().mockResolvedValue({ created: true }),
      put: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(async (objectKey: string) => { removed.push(objectKey); }),
      createSignedUpload: vi.fn(),
      createSignedDownload: vi.fn(),
    };
    const access = new SupabaseWorkingDocumentAccess(client, "task-1", "run-1", () => 4, storage);

    await expect(access.commit({
      idempotencyKey: "run:run-1/call:ambiguous",
      expectedRevision: "revision-1",
      bytes: new Uint8Array([1]),
      revision: "revision-2",
      changedEntries: [],
      effectReceipt: { idempotencyKey: "run:run-1/call:ambiguous", callId: "ambiguous", toolName: "apply_text_change", output: {}, completedAt: "2026-08-28T00:00:00.000Z", stepId: "ambiguous", effect: "apply" },
    })).rejects.toThrow("connection reset");
    expect(removed).toEqual([]);
  });

  it("cleans only objects created by this attempt on an explicit revision conflict", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({ data: { owner_user_id: "user-1", working_document_id: "document-1", lock_version: 4 }, error: null });
    const rpc = vi.fn().mockResolvedValue({ data: { kind: "revision-conflict", actualRevision: "revision-3" }, error: null });
    const client = { from: vi.fn().mockReturnValue(query), rpc } as unknown as SupabaseClient;
    const removed: string[] = [];
    const storage: PrivateObjectStoragePort = {
      ensureObject: vi.fn()
        .mockResolvedValueOnce({ created: true })
        .mockResolvedValueOnce({ created: false }),
      put: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(async (objectKey: string) => { removed.push(objectKey); }),
      createSignedUpload: vi.fn(),
      createSignedDownload: vi.fn(),
    };
    const access = new SupabaseWorkingDocumentAccess(client, "task-1", "run-1", () => 4, storage);

    await expect(access.commit({
      idempotencyKey: "run:run-1/call:conflict",
      expectedRevision: "revision-1",
      bytes: new Uint8Array([1]),
      revision: "revision-2",
      changedEntries: [],
      effectReceipt: { idempotencyKey: "run:run-1/call:conflict", callId: "conflict", toolName: "apply_text_change", output: {}, completedAt: "2026-08-28T00:00:00.000Z", stepId: "conflict", effect: "apply" },
    })).rejects.toThrow("DOCUMENT_REVISION_CONFLICT");
    expect(removed).toHaveLength(1);
  });
});

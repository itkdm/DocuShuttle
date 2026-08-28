import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/202608280019_atomic_document_effect_receipt.sql", "utf8");
const casMigration = readFileSync("supabase/migrations/202608280020_preserve_effect_receipt_cas.sql", "utf8");

describe("atomic document effect migration contract", () => {
  it("uses the forward function signature and returns the durable effect boundary", () => {
    expect(migration).toContain("drop function if exists public.commit_loop_document_version");
    expect(migration).toContain("p_receipt jsonb");
    expect(migration).toContain("'receipt', p_receipt");
    expect(migration).toContain("'lockVersion', v_next_version");
    expect(migration).toContain("insert into public.agent_effect_receipts");
  });

  it("checks an existing exact receipt before cancellation or version conflicts", () => {
    const receiptLookup = migration.indexOf("select * into v_existing_receipt");
    const cancelledGuard = migration.indexOf("if v_run.status = 'cancelled'");
    const versionGuard = migration.indexOf("if v_run.lock_version <> p_expected_run_version");

    expect(receiptLookup).toBeGreaterThan(-1);
    expect(receiptLookup).toBeLessThan(cancelledGuard);
    expect(receiptLookup).toBeLessThan(versionGuard);
    expect(migration).toContain("EFFECT_RECEIPT_CONFLICT");
  });

  it("keeps the idempotency comparison semantic and leaves completedAt out of equality", () => {
    expect(migration).toContain("v_existing_receipt.receipt->>'callId'");
    expect(migration).toContain("v_existing_receipt.receipt->>'toolName'");
    expect(migration).toContain("v_existing_receipt.receipt->'output'");
    expect(migration).not.toContain("v_existing_receipt.receipt->>'completedAt'");
  });
});

describe("effect receipt CAS preservation migration contract", () => {
  it("does not advance the agent run for document effects", () => {
    expect(casMigration).toContain("p_expected_lock_version bigint");
    expect(casMigration).toContain("'lockVersion', p_expected_run_version");
    expect(casMigration).not.toContain("lock_version = v_next_version");
    expect(casMigration).not.toContain("jsonb_build_object('version', v_next_version)");
  });

  it("locks and validates the owned version before saving a receipt", () => {
    expect(casMigration).toContain("save_effect_receipt(");
    expect(casMigration).toContain("p_expected_lock_version bigint");
    expect(casMigration).toContain("for update;");
    expect(casMigration).toContain("if v_run.lock_version <> p_expected_lock_version then");
    expect(casMigration).toContain("'lockVersion', p_expected_lock_version");
    expect(casMigration).toContain("drop function if exists public.save_effect_receipt(uuid, jsonb)");
  });
});

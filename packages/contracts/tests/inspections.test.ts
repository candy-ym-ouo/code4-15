import { describe, expect, it } from "vitest";
import {
  defectSeverities,
  inspectionCreateSchema,
  inspectionDefectCreateSchema,
  inspectionDispositionSchema,
  inspectionSampleCreateSchema,
  inspectionStatuses
} from "@handcraft/contracts";

const materialId = "00000000-0000-0000-0000-000000000001";

describe("incoming inspection contracts", () => {
  it("accepts a valid incoming registration", () => {
    const parsed = inspectionCreateSchema.parse({
      materialId,
      inspectionCode: "IQC-001",
      receivedAt: "2026-09-22",
      deliveredQuantity: "2.5",
      entryUnit: "kg"
    });
    expect(parsed.deliveredQuantity).toBe("2.5");
  });

  it("rejects an expiry date before the delivery date", () => {
    const result = inspectionCreateSchema.safeParse({
      materialId,
      receivedAt: "2026-09-22",
      expiryAt: "2026-09-20",
      deliveredQuantity: "1",
      entryUnit: "kg"
    });
    expect(result.success).toBe(false);
  });

  it("requires a positive delivered quantity", () => {
    const result = inspectionCreateSchema.safeParse({
      materialId,
      receivedAt: "2026-09-22",
      deliveredQuantity: "0",
      entryUnit: "kg"
    });
    expect(result.success).toBe(false);
  });

  it("defaults a sample result to PENDING and records the inspector", () => {
    const parsed = inspectionSampleCreateSchema.parse({ sampleQuantity: "50", unit: "g" });
    expect(parsed.result).toBe("PENDING");
  });

  it("requires a unit when a defect quantity is reported", () => {
    expect(inspectionDefectCreateSchema.safeParse({ defectType: "色差", defectQuantity: "10" }).success).toBe(false);
    expect(inspectionDefectCreateSchema.safeParse({ defectType: "色差", defectQuantity: "0" }).success).toBe(true);
  });

  it("only allows known defect severities and inspection statuses", () => {
    expect(defectSeverities).toEqual(["MINOR", "MAJOR", "CRITICAL"]);
    expect(inspectionStatuses).toEqual(["PENDING", "ACCEPTED", "CONCESSION", "REJECTED"]);
  });

  it("requires an accepted quantity for concession disposition", () => {
    const without = inspectionDispositionSchema.safeParse({ disposition: "CONCESSION", reason: "让步放行用于非关键部位", version: 1 });
    expect(without.success).toBe(false);
    const withQuantity = inspectionDispositionSchema.safeParse({
      disposition: "CONCESSION", acceptedQuantity: "900", reason: "让步放行", version: 1
    });
    expect(withQuantity.success).toBe(true);
  });

  it("does not require an accepted quantity for rejection or full acceptance", () => {
    expect(inspectionDispositionSchema.safeParse({ disposition: "REJECTED", reason: "严重受潮全部驳回", version: 1 }).success).toBe(true);
    expect(inspectionDispositionSchema.safeParse({ disposition: "ACCEPTED", reason: "抽检全部合格", version: 1 }).success).toBe(true);
  });

  it("requires a reason of at least three characters", () => {
    const result = inspectionDispositionSchema.safeParse({ disposition: "REJECTED", reason: "否", version: 1 });
    expect(result.success).toBe(false);
  });
});

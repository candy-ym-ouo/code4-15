import { describe, expect, it } from "vitest";
import {
  batchCreateSchema,
  colorChangeInputSchema,
  consumptionInputSchema,
  convertQuantity,
  inspectionCreateSchema,
  inspectionDefectSchema,
  inspectionDispositionSchema,
  inspectionSampleSchema
} from "@handcraft/contracts";

describe("API business validation contracts", () => {
  it("normalizes a valid batch payload", () => {
    const result = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-13",
      initialQuantity: "1.5",
      entryUnit: "kg"
    });
    expect(result.entryUnit).toBe("kg");
  });

  it("requires at least one consumption quantity", () => {
    const base = {
      projectId: "00000000-0000-0000-0000-000000000001",
      batchId: "00000000-0000-0000-0000-000000000002",
      usedQuantity: "0",
      wasteQuantity: "0",
      unit: "g"
    };
    expect(consumptionInputSchema.safeParse(base).success).toBe(false);
    expect(consumptionInputSchema.safeParse({ ...base, wasteQuantity: "10" }).success).toBe(true);
  });

  it("rejects zero affected quantity for color changes", () => {
    const result = colorChangeInputSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changeType: "OTHER",
      afterColorName: "Test",
      affectedQuantity: "0",
      unit: "g",
      occurredAt: "2026-09-13T10:00:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("keeps inventory units in compatible families", () => {
    expect(convertQuantity("2.5", "l", "ml")).toBe("2500.000000");
    expect(() => convertQuantity("2.5", "l", "kg")).toThrow();
  });

  it("accepts a well-formed incoming inspection", () => {
    const result = inspectionCreateSchema.safeParse({
      inspectionNo: "IQC-01",
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-22",
      deliveredQuantity: "5",
      entryUnit: "kg"
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero or negative delivered quantity", () => {
    expect(inspectionCreateSchema.safeParse({
      inspectionNo: "IQC-02",
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-22",
      deliveredQuantity: "0",
      entryUnit: "g"
    }).success).toBe(false);
  });

  it("records samples with pass/fail/pending results", () => {
    expect(inspectionSampleSchema.safeParse({ sampleNo: "S1", result: "FAIL" }).success).toBe(true);
    expect(inspectionSampleSchema.parse({ sampleNo: "S2" }).result).toBe("PENDING");
    expect(inspectionSampleSchema.safeParse({ sampleNo: "S3", result: "BOGUS" }).success).toBe(false);
  });

  it("records defects with a severity level", () => {
    const parsed = inspectionDefectSchema.parse({ defectType: "色差", severity: "MAJOR" });
    expect(parsed.severity).toBe("MAJOR");
    expect(parsed.defectCount).toBe(1);
    expect(inspectionDefectSchema.safeParse({ defectType: "" }).success).toBe(false);
  });

  it("requires reason and approver for concession acceptance", () => {
    expect(inspectionDispositionSchema.safeParse({ disposition: "CONCESSION" }).success).toBe(false);
    expect(inspectionDispositionSchema.safeParse({
      disposition: "CONCESSION",
      concessionReason: "轻微色差可降级使用",
      concessionApprover: "王工"
    }).success).toBe(true);
  });

  it("requires a note for rejection", () => {
    expect(inspectionDispositionSchema.safeParse({ disposition: "REJECT" }).success).toBe(false);
    expect(inspectionDispositionSchema.safeParse({ disposition: "REJECT", note: "整批破损，退回供应商" }).success).toBe(true);
  });

  it("allows plain acceptance without extra fields", () => {
    const parsed = inspectionDispositionSchema.parse({ disposition: "ACCEPT" });
    expect(parsed.disposition).toBe("ACCEPT");
  });
});

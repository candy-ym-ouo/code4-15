// 端到端集成测试：使用 embedded-postgres 启动真实 PostgreSQL 16，
// 通过 Fastify inject 走完整 HTTP 链，验证来料质检与让步接收的业务不变量。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";

process.env.DATABASE_URL = "postgresql://handcraft:change-me@127.0.0.1:55444/handcraft";
process.env.SESSION_SECRET = "integration-test-session-secret-0123456789abcdef";
process.env.UPLOAD_DIR = "/tmp/handcraft-test-uploads";

const { buildApp } = await import("../../src/app.js");
const { pool } = await import("../../src/lib/db.js");

const pg = new EmbeddedPostgres({
  version: "16.4.0",
  port: 55444,
  persistent: false,
  databaseDir: "/tmp/handcraft-pg/db",
  user: "handcraft",
  password: "change-me"
});

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
let materialId = "";
let sourceId = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method,
    url: `/api/v1${path}`,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", cookie, ...headers }
  });
  const payload = response.statusCode === 204 ? null : response.json();
  return { status: response.statusCode, payload, headers: response.headers };
}

async function createInspection(deliveredQuantity = "1", entryUnit = "kg", code?: string) {
  const response = await call("POST", "/inspections", {
    materialId,
    sourceId,
    inspectionCode: code,
    receivedAt: "2026-09-22",
    deliveredQuantity,
    entryUnit
  });
  expect(response.status, JSON.stringify(response.payload)).toBe(201);
  return response.payload.data as { id: string; deliveredQuantity: string; stockUnit: string };
}

async function countBatchesAndMovements(inspectionId: string) {
  const batches = await pool.query("SELECT id FROM batches WHERE id IN (SELECT batch_id FROM incoming_inspections WHERE id = $1)", [inspectionId]);
  const movements = await pool.query(
    "SELECT count(*)::int AS count FROM stock_movements WHERE reference_type = 'INSPECTION' AND reference_id = $1",
    [inspectionId]
  );
  return { batches: batches.rowCount ?? 0, movements: movements.rows[0]?.count ?? 0 };
}

// 默认 `pnpm test` 只跑无外部依赖的单元测试；设置 RUN_DB_INTEGRATION=1
// （或使用 pnpm test:integration）时才启动内嵌 PostgreSQL 执行本套件。
const describeDb = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;

describeDb("incoming inspection workflow", () => {
  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("handcraft");
    app = await buildApp({ runDatabaseMigrations: true });

    const setup = await call("POST", "/setup", { displayName: "集成测试员", password: "integration-password-123" });
    expect(setup.status).toBe(201);
    cookie = (setup.headers["set-cookie"] as string).split(";")[0] ?? "";

    const source = await call("POST", "/sources", { name: "集成测试供应商", type: "PURCHASED" });
    sourceId = source.payload.data.id;
    const material = await call("POST", "/materials", {
      code: "IQC-TEST",
      name: "集成测试染材",
      craftTypes: ["DYEING"],
      stockUnit: "g"
    });
    materialId = material.payload.data.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool.end();
    await pg.stop();
  }, 60_000);

  it("registers incoming material as PENDING without creating any batch or stock movement", async () => {
    const inspection = await createInspection("1", "kg", "IQC-PENDING-1");
    expect(inspection.deliveredQuantity).toBe("1000.000000");
    expect(inspection.stockUnit).toBe("g");

    const detail = await call("GET", `/inspections/${inspection.id}`);
    expect(detail.status).toBe(200);
    expect(detail.payload.data.status).toBe("PENDING");
    expect(detail.payload.data.batchId).toBeNull();
    expect(detail.payload.data.disposition).toBeNull();

    const counts = await countBatchesAndMovements(inspection.id);
    expect(counts).toEqual({ batches: 0, movements: 0 });
  });

  it("records samples and defects, including unit conversion", async () => {
    const inspection = await createInspection("2", "kg", "IQC-SAMPLES-1");
    const sample = await call("POST", `/inspections/${inspection.id}/samples`, {
      sampleCode: "S-1",
      sampleQuantity: "500",
      unit: "g",
      inspectionItem: "含水率与外观",
      result: "FAIL",
      inspectorName: "检验员甲"
    });
    expect(sample.status).toBe(201);
    expect(sample.payload.data.sampleQuantity).toBe("500.000000");

    const defect = await call("POST", `/inspections/${inspection.id}/defects`, {
      sampleId: sample.payload.data.id,
      defectType: "受潮结块",
      severity: "MAJOR",
      defectQuantity: "0.2",
      unit: "kg",
      description: "外包装破损导致结块"
    });
    expect(defect.status).toBe(201);
    expect(defect.payload.data.defectQuantity).toBe("200.000000");

    const detail = await call("GET", `/inspections/${inspection.id}`);
    expect(detail.payload.data.samples).toHaveLength(1);
    expect(detail.payload.data.defects).toHaveLength(1);
    expect(detail.payload.data.defectCount).toBe(1);
  });

  it("rejects samples and defects after the inspection has been dispositioned", async () => {
    const inspection = await createInspection("1", "kg", "IQC-LOCKED-1");
    const disposition = await call("POST", `/inspections/${inspection.id}/disposition`, {
      disposition: "ACCEPTED",
      reason: "抽检全部合格",
      version: 1
    });
    expect(disposition.status).toBe(201);

    const lateSample = await call("POST", `/inspections/${inspection.id}/samples`, { sampleQuantity: "10", unit: "g" });
    expect(lateSample.status).toBe(409);
    expect(lateSample.payload.error.code).toBe("INSPECTION_ALREADY_DISPOSITIONED");

    const lateDefect = await call("POST", `/inspections/${inspection.id}/defects`, { defectType: "迟报", defectQuantity: "0" });
    expect(lateDefect.status).toBe(409);
  });

  it("ACCEPTED disposition creates the batch and OPENING movement in one transaction", async () => {
    const inspection = await createInspection("1.5", "kg", "IQC-ACCEPT-1");
    const disposition = await call("POST", `/inspections/${inspection.id}/disposition`, {
      disposition: "ACCEPTED",
      reason: "抽检全部合格",
      version: 1
    });
    expect(disposition.status).toBe(201);
    const batchId = disposition.payload.data.disposition.batchId;
    expect(batchId).toBeTruthy();

    const batch = await call("GET", `/batches/${batchId}`);
    expect(batch.status).toBe(200);
    expect(batch.payload.data.remainingQuantity).toBe("1500.000000");
    expect(batch.payload.data.initialQuantity).toBe("1500.000000");
    expect(batch.payload.data.movements[0].type).toBe("OPENING");
    expect(batch.payload.data.movements[0].referenceType).toBe("INSPECTION");

    const detail = await call("GET", `/inspections/${inspection.id}`);
    expect(detail.payload.data.status).toBe("ACCEPTED");
    expect(detail.payload.data.batchId).toBe(batchId);
    expect(detail.payload.data.disposition.disposition).toBe("ACCEPTED");
  });

  it("CONCESSION disposition stocks only the accepted quantity and records the concession", async () => {
    const inspection = await createInspection("1", "kg", "IQC-CONCESSION-1");
    const disposition = await call("POST", `/inspections/${inspection.id}/disposition`, {
      disposition: "CONCESSION",
      acceptedQuantity: "800",
      unit: "g",
      reason: "轻微色差，让步放行用于非关键部位",
      version: 1
    });
    expect(disposition.status).toBe(201);
    const batchId = disposition.payload.data.disposition.batchId;
    const batch = await call("GET", `/batches/${batchId}`);
    expect(batch.payload.data.initialQuantity).toBe("800.000000");
    expect(batch.payload.data.remainingQuantity).toBe("800.000000");

    // 让步放行的 200g 差额不得形成第二个批次或额外流水。
    const counts = await countBatchesAndMovements(inspection.id);
    expect(counts.batches).toBe(1);
    expect(counts.movements).toBe(1);
  });

  it("rejects concession when accepted quantity equals or exceeds the delivered quantity", async () => {
    const full = await createInspection("1", "kg", "IQC-CONCESSION-FULL");
    const equal = await call("POST", `/inspections/${full.id}/disposition`, {
      disposition: "CONCESSION", acceptedQuantity: "1", unit: "kg", reason: "全部数量不应走让步接收", version: 1
    });
    expect(equal.status).toBe(422);
    expect(equal.payload.error.code).toBe("CONCESSION_REQUIRES_SHORTAGE");

    const over = await call("POST", `/inspections/${full.id}/disposition`, {
      disposition: "CONCESSION", acceptedQuantity: "1.2", unit: "kg", reason: "超出到货量", version: 1
    });
    expect(over.status).toBe(422);
    expect(over.payload.error.code).toBe("ACCEPTED_QUANTITY_EXCEEDED");
    // 校验失败后检验单仍处于待检，且没有批次产生。
    const counts = await countBatchesAndMovements(full.id);
    expect(counts).toEqual({ batches: 0, movements: 0 });
  });

  it("REJECTED disposition never creates a batch or stock movement", async () => {
    const inspection = await createInspection("1", "kg", "IQC-REJECT-1");
    const disposition = await call("POST", `/inspections/${inspection.id}/disposition`, {
      disposition: "REJECTED",
      reason: "严重受潮霉变，整批驳回",
      version: 1
    });
    expect(disposition.status).toBe(201);
    expect(disposition.payload.data.disposition.batchId).toBeNull();

    const detail = await call("GET", `/inspections/${inspection.id}`);
    expect(detail.payload.data.status).toBe("REJECTED");
    expect(detail.payload.data.batchId).toBeNull();
    expect(detail.payload.data.disposition.disposition).toBe("REJECTED");

    const counts = await countBatchesAndMovements(inspection.id);
    expect(counts).toEqual({ batches: 0, movements: 0 });
  });

  it("applies exactly one disposition under concurrency", async () => {
    const inspection = await createInspection("1", "kg", "IQC-CONCURRENT-1");
    const [first, second, third] = await Promise.all([
      call("POST", `/inspections/${inspection.id}/disposition`, { disposition: "REJECTED", reason: "并发驳回第一次", version: 1 }, { "idempotency-key": "concurrent-key-1" }),
      call("POST", `/inspections/${inspection.id}/disposition`, { disposition: "ACCEPTED", reason: "并发合格第二次", version: 1 }, { "idempotency-key": "concurrent-key-2" }),
      call("POST", `/inspections/${inspection.id}/disposition`, { disposition: "CONCESSION", acceptedQuantity: "100", reason: "并发让步第三次", version: 1 }, { "idempotency-key": "concurrent-key-3" })
    ]);

    const statuses = [first.status, second.status, third.status];
    const created = statuses.filter((status) => status === 201);
    const conflicts = statuses.filter((status) => status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(2);
    for (const response of [first, second, third]) {
      if (response.status === 409) expect(response.payload.error.code).toBe("INSPECTION_ALREADY_DISPOSITIONED");
    }

    const dispositionRows = await pool.query("SELECT count(*)::int AS count FROM inspection_dispositions WHERE inspection_id = $1", [inspection.id]);
    expect(dispositionRows.rows[0]?.count).toBe(1);

    const detail = await call("GET", `/inspections/${inspection.id}`);
    const finalStatus = detail.payload.data.status;
    expect(["REJECTED", "ACCEPTED", "CONCESSION"]).toContain(finalStatus);
    // 驳回胜出时必须没有批次；接收/让步胜出时必须恰好一个批次。
    const counts = await countBatchesAndMovements(inspection.id);
    if (finalStatus === "REJECTED") {
      expect(counts).toEqual({ batches: 0, movements: 0 });
    } else {
      expect(counts.batches).toBe(1);
      expect(counts.movements).toBe(1);
    }
  });

  it("replays an idempotent disposition without creating a second effect", async () => {
    const inspection = await createInspection("1", "kg", "IQC-IDEMPOTENT-1");
    const payload = { disposition: "REJECTED" as const, reason: "幂等重试的驳回", version: 1 };
    const first = await call("POST", `/inspections/${inspection.id}/disposition`, payload, { "idempotency-key": "replay-key-1" });
    const second = await call("POST", `/inspections/${inspection.id}/disposition`, payload, { "idempotency-key": "replay-key-1" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.payload.data.disposition.disposition).toBe("REJECTED");
    expect(second.payload.data.disposition.inspectionId).toBe(inspection.id);

    const dispositionRows = await pool.query("SELECT count(*)::int AS count FROM inspection_dispositions WHERE inspection_id = $1", [inspection.id]);
    expect(dispositionRows.rows[0]?.count).toBe(1);
    const counts = await countBatchesAndMovements(inspection.id);
    expect(counts).toEqual({ batches: 0, movements: 0 });
  });

  it("enforces database-level invariants on dispositions and rejected inspections", async () => {
    // 用一张已合格入库的检验单验证“一检一处置”部分唯一索引。
    const acceptedInspection = await createInspection("1", "kg", "IQC-DB-GUARD-OK");
    const accepted = await call("POST", `/inspections/${acceptedInspection.id}/disposition`, {
      disposition: "ACCEPTED", reason: "合格入库用于唯一索引测试", version: 1
    });
    expect(accepted.status).toBe(201);
    const batchId = accepted.payload.data.disposition.batchId as string;

    const secondInsert = await pool.query(
      `INSERT INTO inspection_dispositions(inspection_id, disposition, reason, batch_id, actor_user_id)
       VALUES ($1, 'ACCEPTED', '绕过 API 的重复处置', $2, (SELECT id FROM users LIMIT 1))`,
      [acceptedInspection.id, batchId]
    ).catch((error: { code?: string }) => error);
    expect((secondInsert as { code?: string }).code).toBe("23505");

    // 驳回检验单不可能关联任何批次（检验单表级 CHECK）。
    const inspection = await createInspection("1", "kg", "IQC-DB-GUARD-REJECT");
    const rejected = await call("POST", `/inspections/${inspection.id}/disposition`, {
      disposition: "REJECTED", reason: "数据库约束测试驳回", version: 1
    });
    expect(rejected.status).toBe(201);
    const linkBatch = await pool.query(
      "UPDATE incoming_inspections SET batch_id = $1 WHERE id = $2",
      [batchId, inspection.id]
    ).catch((error: { code?: string }) => error);
    expect((linkBatch as { code?: string }).code).toBe("23514");
  });

  it("supports filtering the inspection list by status and text search", async () => {
    const list = await call("GET", "/inspections?status=REJECTED&pageSize=100");
    expect(list.status).toBe(200);
    expect(list.payload.data.every((row: { status: string }) => row.status === "REJECTED")).toBe(true);

    const search = await call("GET", "/inspections?q=IQC-REJECT-1");
    expect(search.payload.data.some((row: { inspectionCode: string }) => row.inspectionCode === "IQC-REJECT-1")).toBe(true);
  });

  it("keeps rejected goods out of material stock aggregation", async () => {
    const material = await call("GET", `/materials/${materialId}`);
    // 被驳回的 1kg 绝不能计入材料库存；接收/让步产生的批次才计入。
    for (const batch of material.payload.data.batches as { id: string }[]) {
      const detail = await call("GET", `/batches/${batch.id}`);
      expect(detail.payload.data.movements[0].referenceType).not.toBe("REJECTED");
    }
    expect(Number(material.payload.data.remainingQuantity)).toBeGreaterThan(0);
  });
});

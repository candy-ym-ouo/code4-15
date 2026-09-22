import type { FastifyInstance } from "fastify";
import {
  convertQuantity,
  inspectionCreateSchema,
  inspectionDefectSchema,
  inspectionDispositionSchema,
  inspectionSampleSchema
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;
type UnitRecord = { stock_unit: string; [key: string]: unknown };

const ZERO_BATCH = "00000000-0000-0000-0000-000000000000";
const OPEN_STATUSES = ["PENDING", "INSPECTING"];
const TERMINAL_LABEL: Record<string, string> = {
  ACCEPTED: "合格接收",
  CONCESSION_ACCEPTED: "让步接收",
  REJECTED: "驳回"
};

const INSPECTION_FROM = `
   FROM inspections i
   JOIN materials m ON m.id = i.material_id
   LEFT JOIN sources s ON s.id = i.source_id
   LEFT JOIN storage_locations l ON l.id = i.location_id`;

const INSPECTION_SELECT = `
  SELECT i.id, i.inspection_no AS "inspectionNo", i.material_id AS "materialId", m.name AS "materialName",
         m.code AS "materialCode", m.craft_types AS "craftTypes", i.batch_code AS "batchCode",
         i.source_id AS "sourceId", s.name AS "sourceName", i.source_note AS "sourceNote",
         i.location_id AS "locationId", l.name AS "locationName", i.received_at AS "receivedAt",
         i.expiry_at AS "expiryAt", i.delivered_quantity::text AS "deliveredQuantity", i.entry_unit AS "entryUnit",
         i.total_cost::text AS "totalCost", i.currency, i.initial_color_name AS "initialColorName",
         i.initial_color_hex AS "initialColorHex", i.notes, i.status, i.disposition,
         i.disposition_note AS "dispositionNote", i.concession_reason AS "concessionReason",
         i.concession_approver AS "concessionApprover", i.batch_id AS "batchId",
         i.disposed_at AS "disposedAt", i.created_at AS "createdAt", i.updated_at AS "updatedAt"`;

export async function inspectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/inspections", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      const i = values.length;
      conditions.push(`(
        i.inspection_no ILIKE $${i} OR i.batch_code ILIKE $${i} OR m.name ILIKE $${i}
        OR m.code ILIKE $${i} OR s.name ILIKE $${i} OR i.notes ILIKE $${i}
      )`);
    }
    for (const [key, column] of [["materialId", "i.material_id"], ["sourceId", "i.source_id"], ["locationId", "i.location_id"]] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.status) {
      if (!["PENDING", "INSPECTING", "ACCEPTED", "CONCESSION_ACCEPTED", "REJECTED"].includes(request.query.status)) {
        throw new AppError(422, "INVALID_STATUS", "质检单状态筛选值无效");
      }
      values.push(request.query.status);
      conditions.push(`i.status = $${values.length}::inspection_status`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${INSPECTION_FROM} ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `${INSPECTION_SELECT} ${INSPECTION_FROM} ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/inspections/:id", async (request) => {
    const result = await pool.query(`${INSPECTION_SELECT} ${INSPECTION_FROM} WHERE i.id = $1`, [request.params.id]);
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "质检单不存在");
    const [samples, defects, batch] = await Promise.all([
      pool.query(
        `SELECT id, sample_no AS "sampleNo", sample_quantity::text AS "sampleQuantity", stock_unit AS "stockUnit",
                result, inspected_at AS "inspectedAt", notes, created_at AS "createdAt"
           FROM inspection_samples WHERE inspection_id = $1 ORDER BY created_at, sample_no`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, defect_type AS "defectType", severity, defect_count AS "defectCount",
                affected_quantity::text AS "affectedQuantity", stock_unit AS "stockUnit", description, created_at AS "createdAt"
           FROM inspection_defects WHERE inspection_id = $1 ORDER BY created_at, defect_type`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, batch_code AS "batchCode", remaining_quantity::text AS "remainingQuantity",
                initial_quantity::text AS "initialQuantity", stock_unit AS "stockUnit", status
           FROM batches WHERE inspection_id = $1`,
        [request.params.id]
      )
    ]);
    return { data: { ...result.rows[0], samples: samples.rows, defects: defects.rows, batch: batch.rows[0] ?? null } };
  });

  app.post("/inspections", async (request, reply) => {
    const input = parseInput(inspectionCreateSchema, request.body);
    if (input.expiryAt && input.expiryAt < input.receivedAt) {
      throw new AppError(422, "INVALID_EXPIRY_DATE", "有效期不能早于到货日期");
    }
    const user = (request as AuthenticatedRequest).authUser;
    const idempotencyKey = getIdempotencyKey(request.headers);
    const created = await withTransaction(async (client) => {
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
        const existing = await client.query(`${INSPECTION_SELECT} ${INSPECTION_FROM} WHERE i.idempotency_key = $1`, [idempotencyKey]);
        if (existing.rows[0]) return { data: existing.rows[0], idempotent: true };
      }
      const materialResult = await client.query<UnitRecord & { id: string }>(
        "SELECT id, stock_unit FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE",
        [input.materialId]
      );
      const material = materialResult.rows[0];
      if (!material) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");
      try {
        convertQuantity(input.deliveredQuantity, input.entryUnit, material.stock_unit as any);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "到货单位与材料库存单位不兼容");
      }
      if (input.sourceId) {
        const source = await client.query("SELECT 1 FROM sources WHERE id = $1 AND archived_at IS NULL", [input.sourceId]);
        if (!source.rowCount) throw new AppError(422, "INVALID_SOURCE", "来源不存在或已归档");
      }
      if (input.locationId) {
        const location = await client.query("SELECT 1 FROM storage_locations WHERE id = $1 AND archived_at IS NULL", [input.locationId]);
        if (!location.rowCount) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      }
      const inspection = await client.query(
        `INSERT INTO inspections(
           inspection_no, material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
           delivered_quantity, entry_unit, total_cost, currency, initial_color_name, initial_color_hex, notes,
           idempotency_key, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::stock_unit,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          input.inspectionNo, input.materialId, input.batchCode || null, input.sourceId || null,
          input.sourceNote || null, input.locationId || null, input.receivedAt, input.expiryAt || null,
          input.deliveredQuantity, input.entryUnit, input.totalCost ?? null, input.currency || null,
          input.initialColorName || null, input.initialColorHex || null, input.notes || null,
          idempotencyKey ?? null, user.id
        ]
      );
      const inspectionId = inspection.rows[0]?.id as string;
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "INSPECTION", entityId: inspectionId,
        afterData: { inspectionNo: input.inspectionNo, materialId: input.materialId, deliveredQuantity: input.deliveredQuantity },
        requestId: request.id
      });
      const row = await client.query(`${INSPECTION_SELECT} ${INSPECTION_FROM} WHERE i.id = $1`, [inspectionId]);
      return { data: row.rows[0], idempotent: false };
    });
    return reply.status(created.idempotent ? 200 : 201).send({ data: created.data });
  });

  app.post<{ Params: { id: string } }>("/inspections/:id/samples", async (request, reply) => {
    const input = parseInput(inspectionSampleSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const sample = await withTransaction(async (client) => {
      const inspection = await client.query<{ status: string; material_id: string; stock_unit: string }>(
        `SELECT i.status, i.material_id, m.stock_unit FROM inspections i
          JOIN materials m ON m.id = i.material_id WHERE i.id = $1 FOR UPDATE`,
        [request.params.id]
      );
      const row = inspection.rows[0];
      if (!row) throw new AppError(404, "NOT_FOUND", "质检单不存在");
      if (!OPEN_STATUSES.includes(row.status)) {
        throw new AppError(409, "INSPECTION_CLOSED", `质检单已${TERMINAL_LABEL[row.status] ?? "处置"}，不能再登记样本`);
      }
      let recordedQuantity: string | null = null;
      if (input.sampleQuantity) {
        const unit = input.unit ?? undefined;
        if (!unit) throw new AppError(422, "UNIT_REQUIRED", "填写样本数量时必须提供单位");
        try {
          convertQuantity(input.sampleQuantity, unit, row.stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "样本单位与材料库存单位不兼容");
        }
        recordedQuantity = input.sampleQuantity;
      }
      if (row.status === "PENDING") {
        await client.query("UPDATE inspections SET status = 'INSPECTING' WHERE id = $1", [request.params.id]);
      }
      const inserted = await client.query(
        `INSERT INTO inspection_samples(inspection_id, sample_no, sample_quantity, stock_unit, result, inspected_at, notes, recorded_by)
         VALUES ($1, $2, $3, $4::stock_unit, $5::inspection_sample_result, COALESCE($6::timestamptz, now()), $7, $8)
         RETURNING id, sample_no AS "sampleNo", sample_quantity::text AS "sampleQuantity", stock_unit AS "stockUnit",
                   result, inspected_at AS "inspectedAt", notes, created_at AS "createdAt"`,
        [
          request.params.id, input.sampleNo, recordedQuantity, input.unit ?? null, input.result,
          input.inspectedAt ?? null, input.notes || null, user.id
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "RECORD_SAMPLE", entityType: "INSPECTION_SAMPLE",
        entityId: inserted.rows[0]?.id as string,
        afterData: { inspectionId: request.params.id, sampleNo: input.sampleNo, result: input.result },
        requestId: request.id
      });
      return inserted.rows[0];
    });
    return reply.status(201).send({ data: sample });
  });

  app.post<{ Params: { id: string } }>("/inspections/:id/defects", async (request, reply) => {
    const input = parseInput(inspectionDefectSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const defect = await withTransaction(async (client) => {
      const inspection = await client.query<{ status: string; stock_unit: string }>(
        `SELECT i.status, m.stock_unit FROM inspections i
          JOIN materials m ON m.id = i.material_id WHERE i.id = $1 FOR UPDATE`,
        [request.params.id]
      );
      const row = inspection.rows[0];
      if (!row) throw new AppError(404, "NOT_FOUND", "质检单不存在");
      if (!OPEN_STATUSES.includes(row.status)) {
        throw new AppError(409, "INSPECTION_CLOSED", `质检单已${TERMINAL_LABEL[row.status] ?? "处置"}，不能再登记缺陷`);
      }
      let recordedQuantity: string | null = null;
      if (input.affectedQuantity) {
        const unit = input.unit ?? undefined;
        if (!unit) throw new AppError(422, "UNIT_REQUIRED", "填写影响数量时必须提供单位");
        try {
          convertQuantity(input.affectedQuantity, unit, row.stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "缺陷数量单位与材料库存单位不兼容");
        }
        recordedQuantity = input.affectedQuantity;
      }
      if (row.status === "PENDING") {
        await client.query("UPDATE inspections SET status = 'INSPECTING' WHERE id = $1", [request.params.id]);
      }
      const inserted = await client.query(
        `INSERT INTO inspection_defects(inspection_id, defect_type, severity, defect_count, affected_quantity, stock_unit, description, recorded_by)
         VALUES ($1, $2, $3::defect_severity, $4, $5, $6::stock_unit, $7, $8)
         RETURNING id, defect_type AS "defectType", severity, defect_count AS "defectCount",
                   affected_quantity::text AS "affectedQuantity", stock_unit AS "stockUnit", description, created_at AS "createdAt"`,
        [
          request.params.id, input.defectType, input.severity, input.defectCount ?? 1,
          recordedQuantity, input.unit ?? null, input.description || null, user.id
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "RECORD_DEFECT", entityType: "INSPECTION_DEFECT",
        entityId: inserted.rows[0]?.id as string,
        afterData: { inspectionId: request.params.id, defectType: input.defectType, severity: input.severity },
        requestId: request.id
      });
      return inserted.rows[0];
    });
    return reply.status(201).send({ data: defect });
  });

  app.post<{ Params: { id: string } }>("/inspections/:id/disposition", async (request, reply) => {
    const input = parseInput(inspectionDispositionSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const idempotencyKey = getIdempotencyKey(request.headers);
    const result = await withTransaction(async (client) => {
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
        const replay = await client.query(`${INSPECTION_SELECT} ${INSPECTION_FROM} WHERE i.disposition_idempotency_key = $1`, [idempotencyKey]);
        if (replay.rows[0]) {
          const batch = await client.query(
            `SELECT id, batch_code AS "batchCode", remaining_quantity::text AS "remainingQuantity", status
               FROM batches WHERE inspection_id = $1`,
            [replay.rows[0].id]
          );
          return { inspection: replay.rows[0], batch: batch.rows[0] ?? null, idempotent: true };
        }
      }

      // 条件 UPDATE 同时完成“存在性检查 + 行锁 + 终态占用”。
      // 并发处置只有一个事务能把开放态改成终态，其余事务拿到 0 行并收到 409。
      const claimed = await client.query<{ status: string }>(
        `UPDATE inspections
            SET status = CASE $2::inspection_disposition
                           WHEN 'ACCEPT' THEN 'ACCEPTED'::inspection_status
                           WHEN 'CONCESSION' THEN 'CONCESSION_ACCEPTED'::inspection_status
                           WHEN 'REJECT' THEN 'REJECTED'::inspection_status
                         END,
                disposition = $2::inspection_disposition,
                disposition_note = $3,
                concession_reason = $4,
                concession_approver = $5,
                batch_id = CASE WHEN $2::inspection_disposition = 'REJECT' THEN NULL ELSE $8::uuid END,
                disposed_at = now(),
                disposed_by = $6,
                disposition_idempotency_key = $7
          WHERE id = $1 AND status IN ('PENDING', 'INSPECTING')
          RETURNING status`,
        [
          request.params.id,
          input.disposition,
          input.note || null,
          input.concessionReason || null,
          input.concessionApprover || null,
          user.id,
          idempotencyKey ?? null,
          ZERO_BATCH
        ]
      );
      if (!claimed.rowCount) {
        const current = await pool.query<{ status: string }>("SELECT status FROM inspections WHERE id = $1", [request.params.id]);
        if (!current.rows[0]) throw new AppError(404, "NOT_FOUND", "质检单不存在");
        throw new AppError(409, "INSPECTION_ALREADY_DISPOSED", `质检单已${TERMINAL_LABEL[current.rows[0].status] ?? "处置"}，处置只能执行一次`);
      }

      const counts = await client.query<{ failed: number; defects: number; critical: number; samples: number }>(
        `SELECT
           (SELECT count(*) FROM inspection_samples s WHERE s.inspection_id = $1 AND s.result = 'FAIL')::int AS failed,
           (SELECT count(*) FROM inspection_defects d WHERE d.inspection_id = $1)::int AS defects,
           (SELECT count(*) FROM inspection_defects d WHERE d.inspection_id = $1 AND d.severity = 'CRITICAL')::int AS critical,
           (SELECT count(*) FROM inspection_samples s WHERE s.inspection_id = $1)::int AS samples`,
        [request.params.id]
      );
      const stats = counts.rows[0]!;
      if (input.disposition === "ACCEPT") {
        if (stats.samples === 0) throw new AppError(409, "SAMPLES_REQUIRED", "合格接收前必须至少登记一个检验样本");
        if (stats.failed > 0) throw new AppError(409, "FAILED_SAMPLES_PRESENT", "存在不合格样本，不能合格接收，请改为让步接收或驳回");
        if (stats.defects > 0) throw new AppError(409, "DEFECTS_PRESENT", "存在缺陷记录，不能合格接收，请改为让步接收或驳回");
      }
      if (input.disposition === "CONCESSION") {
        if (stats.samples === 0) throw new AppError(409, "SAMPLES_REQUIRED", "让步接收前必须至少登记一个检验样本");
        if (stats.critical > 0) throw new AppError(409, "CRITICAL_DEFECTS_PRESENT", "存在严重缺陷，不能让步接收，只能驳回");
      }

      let batchRow: Record<string, unknown> | null = null;
      if (input.disposition === "ACCEPT" || input.disposition === "CONCESSION") {
        const materialResult = await client.query<UnitRecord & { id: string; default_color_name: string | null; default_color_hex: string | null }>(
          "SELECT id, stock_unit, default_color_name, default_color_hex FROM materials WHERE id = (SELECT material_id FROM inspections WHERE id = $1) AND archived_at IS NULL FOR SHARE",
          [request.params.id]
        );
        const material = materialResult.rows[0];
        if (!material) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能完成入库");
        const inspectionRow = await client.query(
          `SELECT batch_code, source_id, source_note, location_id, received_at, expiry_at, delivered_quantity,
                  entry_unit, total_cost, currency, initial_color_name, initial_color_hex, notes
             FROM inspections WHERE id = $1`,
          [request.params.id]
        );
        const head = inspectionRow.rows[0]!;
        let normalizedQuantity: string;
        try {
          normalizedQuantity = convertQuantity(head.delivered_quantity as string, head.entry_unit as any, material.stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "到货单位与材料库存单位不兼容");
        }
        const initialColorName = head.initial_color_name || material.default_color_name;
        const initialColorHex = head.initial_color_hex || material.default_color_hex;
        const batch = await client.query(
          `INSERT INTO batches(material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
             initial_quantity, remaining_quantity, stock_unit, entry_unit, total_cost, currency,
             initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at,
             notes, inspection_id)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $8, $9::stock_unit, $10::stock_unit, $11, $12,
                   $13::varchar(80), $14::char(7), $13::varchar(80), $14::char(7),
                   CASE WHEN $13 IS NULL AND $14 IS NULL THEN NULL ELSE now() END, $15, $16)
           RETURNING id`,
          [
            material.id, head.batch_code, head.source_id, head.source_note, head.location_id,
            head.received_at, head.expiry_at, normalizedQuantity, material.stock_unit, head.entry_unit,
            head.total_cost, head.currency, initialColorName, initialColorHex, head.notes, request.params.id
          ]
        );
        const batchId = batch.rows[0]?.id as string;
        await client.query(
          `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
             reference_type, reference_id, reason, actor_user_id, idempotency_key)
           VALUES ($1, 'OPENING', $2, $3::stock_unit, 0, $2, 'INSPECTION', $4, $5, $6, $7)`,
          [
            batchId, normalizedQuantity, material.stock_unit, request.params.id,
            input.disposition === "CONCESSION" ? `让步接收入库：${input.concessionReason ?? ""}` : "来料质检合格接收入库",
            user.id, idempotencyKey ?? null
          ]
        );
        // 占位 UUID 换成真实批次：触发器只放行持锁事务的这一次替换。
        const bound = await client.query(
          "UPDATE inspections SET batch_id = $2 WHERE id = $1 AND batch_id = $3 RETURNING id",
          [request.params.id, batchId, ZERO_BATCH]
        );
        if (bound.rowCount !== 1) {
          throw new AppError(409, "INSPECTION_ALREADY_DISPOSED", "质检单已被其他处置占用");
        }
        await writeAudit(client, {
          actorUserId: user.id, action: "CREATE", entityType: "BATCH", entityId: batchId,
          afterData: { inspectionId: request.params.id, initialQuantity: normalizedQuantity },
          requestId: request.id
        });
        batchRow = { id: batchId };
      }

      const detail = await client.query(`${INSPECTION_SELECT} ${INSPECTION_FROM} WHERE i.id = $1`, [request.params.id]);
      await writeAudit(client, {
        actorUserId: user.id,
        action: input.disposition === "REJECT" ? "REJECT" : input.disposition === "CONCESSION" ? "CONCESSION_ACCEPT" : "ACCEPT",
        entityType: "INSPECTION",
        entityId: request.params.id,
        afterData: {
          disposition: input.disposition,
          note: input.note ?? null,
          concessionReason: input.concessionReason ?? null,
          concessionApprover: input.concessionApprover ?? null,
          batchId: batchRow?.id ?? null
        },
        requestId: request.id
      });
      return { inspection: detail.rows[0], batch: batchRow, idempotent: false };
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: { inspection: result.inspection, batch: result.batch } });
  });
}

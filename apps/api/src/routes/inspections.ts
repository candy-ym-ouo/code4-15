import type { FastifyInstance } from "fastify";
import {
  compareQuantities,
  convertQuantity,
  inspectionCreateSchema,
  inspectionDefectCreateSchema,
  inspectionDispositionSchema,
  inspectionPatchSchema,
  inspectionSampleCreateSchema,
  type StockUnit
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;

type InspectionRow = {
  id: string;
  material_id: string;
  status: string;
  version: number;
  delivered_quantity: string;
  entry_unit: string;
  stock_unit: string;
  source_id: string | null;
  location_id: string | null;
  batch_id: string | null;
  initial_color_name: string | null;
  initial_color_hex: string | null;
  total_cost: string | null;
  currency: string | null;
  batch_code: string | null;
  source_note: string | null;
  received_at: string;
  expiry_at: string | null;
  notes: string | null;
};

const INSPECTION_SELECT = `
  SELECT i.id, i.inspection_code AS "inspectionCode", i.material_id AS "materialId", m.name AS "materialName",
         m.code AS "materialCode", m.craft_types AS "craftTypes", i.source_id AS "sourceId", s.name AS "sourceName",
         i.source_note AS "sourceNote", i.location_id AS "locationId", l.name AS "locationName",
         i.received_at AS "receivedAt", i.expiry_at AS "expiryAt",
         i.delivered_quantity::text AS "deliveredQuantity", i.entry_unit AS "entryUnit", i.stock_unit AS "stockUnit",
         i.total_cost::text AS "totalCost", i.currency, i.initial_color_name AS "initialColorName",
         i.initial_color_hex AS "initialColorHex", i.batch_code AS "batchCode", i.notes, i.status,
         i.dispositioned_at AS "dispositionedAt", i.batch_id AS "batchId",
         i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.version,
         (SELECT count(*)::int FROM inspection_samples sp WHERE sp.inspection_id = i.id) AS "sampleCount",
         (SELECT count(*)::int FROM inspection_defects d WHERE d.inspection_id = i.id) AS "defectCount",
         (SELECT coalesce(sum(d.defect_quantity), 0)::text FROM inspection_defects d
           WHERE d.inspection_id = i.id AND d.stock_unit = i.stock_unit) AS "defectQuantity"`;

async function lockInspection(client: DbClient, id: string): Promise<InspectionRow> {
  const result = await client.query<InspectionRow>("SELECT * FROM incoming_inspections WHERE id = $1 FOR UPDATE", [id]);
  const inspection = result.rows[0];
  if (!inspection) throw new AppError(404, "NOT_FOUND", "来料检验单不存在");
  return inspection;
}

function assertPending(inspection: InspectionRow): void {
  if (inspection.status !== "PENDING") {
    throw new AppError(409, "INSPECTION_ALREADY_DISPOSITIONED", "检验单已完成处置，样本、缺陷和处置不能再变更");
  }
}

// 处置通过后生成入库批次，与“批次入库 + OPENING 流水”在同一事务内完成。
async function createBatchFromInspection(
  client: DbClient,
  inspection: InspectionRow,
  acceptedQuantity: string,
  actorUserId: string
): Promise<{ id: string } & Record<string, unknown>> {
  const batch = await client.query(
    `INSERT INTO batches(material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
      initial_quantity, remaining_quantity, stock_unit, entry_unit, total_cost, currency,
      initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $8, $9::stock_unit, $10::stock_unit, $11, $12,
            $13::varchar(80), $14::char(7), $13::varchar(80), $14::char(7),
            CASE WHEN $13 IS NULL AND $14 IS NULL THEN NULL ELSE now() END, $15)
     RETURNING *`,
    [
      inspection.material_id, inspection.batch_code, inspection.source_id, inspection.source_note,
      inspection.location_id, inspection.received_at, inspection.expiry_at, acceptedQuantity,
      inspection.stock_unit, inspection.entry_unit, inspection.total_cost, inspection.currency,
      inspection.initial_color_name, inspection.initial_color_hex, inspection.notes
    ]
  );
  const batchId = batch.rows[0]?.id as string;
  await client.query(
    `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
      reference_type, reference_id, actor_user_id)
     VALUES ($1, 'OPENING', $2, $3::stock_unit, 0, $2, 'INSPECTION', $4, $5)`,
    [batchId, acceptedQuantity, inspection.stock_unit, inspection.id, actorUserId]
  );
  await writeAudit(client, {
    actorUserId, action: "CREATE", entityType: "BATCH", entityId: batchId,
    afterData: { ...batch.rows[0], inspectionId: inspection.id }, requestId: undefined
  });
  return batch.rows[0] as { id: string } & Record<string, unknown>;
}

export async function inspectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/inspections", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      const i = values.length;
      conditions.push(`(
        m.name ILIKE $${i} OR m.code ILIKE $${i} OR i.inspection_code ILIKE $${i}
        OR i.batch_code ILIKE $${i} OR s.name ILIKE $${i} OR i.notes ILIKE $${i}
      )`);
    }
    for (const [key, column] of [["materialId", "i.material_id"], ["sourceId", "i.source_id"], ["locationId", "i.location_id"]] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.status) {
      if (!["PENDING", "ACCEPTED", "CONCESSION", "REJECTED"].includes(request.query.status)) {
        throw new AppError(422, "INVALID_INSPECTION_STATUS", "检验单状态筛选值无效");
      }
      values.push(request.query.status);
      conditions.push(`i.status = $${values.length}::inspection_status`);
    }
    if (request.query.from) {
      values.push(request.query.from);
      conditions.push(`i.received_at >= $${values.length}::date`);
    }
    if (request.query.to) {
      values.push(request.query.to);
      conditions.push(`i.received_at <= $${values.length}::date`);
    }
    const where = conditions.length ? conditions.join(" AND ") : "1 = 1";
    const base = `FROM incoming_inspections i
      JOIN materials m ON m.id = i.material_id
      LEFT JOIN sources s ON s.id = i.source_id
      LEFT JOIN storage_locations l ON l.id = i.location_id
      WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `${INSPECTION_SELECT}
       ${base} ORDER BY i.created_at DESC, i.received_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/inspections/:id", async (request) => {
    const result = await pool.query(`${INSPECTION_SELECT} FROM incoming_inspections i
      JOIN materials m ON m.id = i.material_id
      LEFT JOIN sources s ON s.id = i.source_id
      LEFT JOIN storage_locations l ON l.id = i.location_id
      WHERE i.id = $1`, [request.params.id]);
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "来料检验单不存在");
    const [samples, defects, disposition, attachments] = await Promise.all([
      pool.query(
        `SELECT id, sample_code AS "sampleCode", sample_quantity::text AS "sampleQuantity",
                stock_unit AS "stockUnit", inspection_item AS "inspectionItem", result,
                inspected_at AS "inspectedAt", inspector_name AS "inspectorName", notes, created_at AS "createdAt"
           FROM inspection_samples WHERE inspection_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT d.id, d.sample_id AS "sampleId", d.defect_type AS "defectType", d.severity,
                d.defect_quantity::text AS "defectQuantity", d.stock_unit AS "stockUnit",
                d.description, d.created_at AS "createdAt"
           FROM inspection_defects d WHERE d.inspection_id = $1 ORDER BY d.created_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, disposition, accepted_quantity::text AS "acceptedQuantity", stock_unit AS "stockUnit",
                reason, batch_id AS "batchId", created_at AS "createdAt"
           FROM inspection_dispositions WHERE inspection_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size::text AS "byteSize", created_at AS "createdAt"
           FROM attachments WHERE owner_type = 'INSPECTION' AND owner_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      )
    ]);
    return {
      data: {
        ...result.rows[0],
        samples: samples.rows,
        defects: defects.rows,
        disposition: disposition.rows[0] ?? null,
        attachments: attachments.rows
      }
    };
  });

  app.post("/inspections", async (request, reply) => {
    const input = parseInput(inspectionCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const materialResult = await client.query<{ id: string; stock_unit: StockUnit; default_color_name: string | null; default_color_hex: string | null; archived_at: string | null }>(
        "SELECT id, stock_unit, default_color_name, default_color_hex, archived_at FROM materials WHERE id = $1 FOR UPDATE",
        [input.materialId]
      );
      const material = materialResult.rows[0];
      if (!material) throw new AppError(422, "INVALID_MATERIAL", "材料不存在");
      if (material.archived_at) throw new AppError(422, "MATERIAL_ARCHIVED", "材料已归档，不能登记来料");
      let deliveredQuantity: string;
      try {
        deliveredQuantity = convertQuantity(input.deliveredQuantity, input.entryUnit, material.stock_unit);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "到货单位与材料库存单位不兼容");
      }
      if (input.sourceId) {
        const source = await client.query("SELECT id FROM sources WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.sourceId]);
        if (!source.rowCount) throw new AppError(422, "INVALID_SOURCE", "来源不存在或已归档");
      }
      if (input.locationId) {
        const location = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.locationId]);
        if (!location.rowCount) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      }
      if (input.inspectionCode) {
        const duplicate = await client.query(
          "SELECT 1 FROM incoming_inspections WHERE lower(inspection_code) = lower($1) LIMIT 1",
          [input.inspectionCode]
        );
        if (duplicate.rowCount) throw new AppError(409, "DUPLICATE_INSPECTION_CODE", "检验单号已存在");
      }
      const initialColorName = input.initialColorName || material.default_color_name;
      const initialColorHex = input.initialColorHex || material.default_color_hex;
      const inspection = await client.query(
        `INSERT INTO incoming_inspections(inspection_code, material_id, source_id, source_note, location_id, received_at,
          expiry_at, delivered_quantity, entry_unit, stock_unit, total_cost, currency,
          initial_color_name, initial_color_hex, batch_code, notes)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::stock_unit, $10::stock_unit, $11, $12,
                 $13::varchar(80), $14::char(7), $15, $16)
         RETURNING id`,
        [
          input.inspectionCode || null, input.materialId, input.sourceId || null, input.sourceNote || null,
          input.locationId || null, input.receivedAt, input.expiryAt || null, deliveredQuantity,
          input.entryUnit, material.stock_unit, input.totalCost ?? null, input.currency || null,
          initialColorName, initialColorHex, input.batchCode || null, input.notes || null
        ]
      );
      const inspectionId = inspection.rows[0]?.id as string;
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "INSPECTION", entityId: inspectionId,
        afterData: { materialId: input.materialId, deliveredQuantity, stockUnit: material.stock_unit, status: "PENDING" },
        requestId: request.id
      });
      const full = await client.query(`${INSPECTION_SELECT} FROM incoming_inspections i
        JOIN materials m ON m.id = i.material_id
        LEFT JOIN sources s ON s.id = i.source_id
        LEFT JOIN storage_locations l ON l.id = i.location_id
        WHERE i.id = $1`, [inspectionId]);
      return full.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/inspections/:id", async (request) => {
    const input = parseInput(inspectionPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const old = await lockInspection(client, request.params.id);
      assertPending(old);
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "检验单已被其他操作修改，请刷新后重试");
      if (input.sourceId) {
        const source = await client.query("SELECT id FROM sources WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.sourceId]);
        if (!source.rowCount) throw new AppError(422, "INVALID_SOURCE", "来源不存在或已归档");
      }
      if (input.locationId) {
        const location = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.locationId]);
        if (!location.rowCount) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      }
      if (input.expiryAt && input.expiryAt < old.received_at) {
        throw new AppError(422, "INVALID_EXPIRY_DATE", "有效期不能早于到货日期");
      }
      const result = await client.query(
        `UPDATE incoming_inspections SET
          source_id = CASE WHEN $1::boolean THEN $2 ELSE source_id END,
          source_note = CASE WHEN $3::boolean THEN $4 ELSE source_note END,
          location_id = CASE WHEN $5::boolean THEN $6 ELSE location_id END,
          expiry_at = CASE WHEN $7::boolean THEN $8::date ELSE expiry_at END,
          total_cost = CASE WHEN $9::boolean THEN $10 ELSE total_cost END,
          currency = CASE WHEN $11::boolean THEN $12 ELSE currency END,
          batch_code = CASE WHEN $13::boolean THEN $14 ELSE batch_code END,
          notes = CASE WHEN $15::boolean THEN $16 ELSE notes END,
          version = version + 1
         WHERE id = $17 RETURNING id`,
        [
          "sourceId" in input, input.sourceId || null,
          "sourceNote" in input, input.sourceNote || null,
          "locationId" in input, input.locationId || null,
          "expiryAt" in input, input.expiryAt || null,
          "totalCost" in input, input.totalCost ?? null,
          "currency" in input, input.currency || null,
          "batchCode" in input, input.batchCode || null,
          "notes" in input, input.notes || null,
          request.params.id
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "UPDATE", entityType: "INSPECTION", entityId: request.params.id,
        beforeData: { version: old.version }, afterData: result.rows[0], requestId: request.id
      });
      const full = await client.query(`${INSPECTION_SELECT} FROM incoming_inspections i
        JOIN materials m ON m.id = i.material_id
        LEFT JOIN sources s ON s.id = i.source_id
        LEFT JOIN storage_locations l ON l.id = i.location_id
        WHERE i.id = $1`, [request.params.id]);
      return { data: full.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/inspections/:id/samples", async (request, reply) => {
    const input = parseInput(inspectionSampleCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const created = await withTransaction(async (client) => {
      if (key) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const existing = await client.query(
          "SELECT * FROM inspection_samples WHERE idempotency_key = $1 LIMIT 1",
          [key]
        );
        if (existing.rows[0]) return { data: existing.rows[0], idempotent: true };
      }
      const inspection = await lockInspection(client, request.params.id);
      assertPending(inspection);
      let sampleQuantity: string;
      try {
        sampleQuantity = convertQuantity(input.sampleQuantity, input.unit, inspection.stock_unit as StockUnit);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "样本单位与检验单库存单位不兼容");
      }
      const sample = await client.query(
        `INSERT INTO inspection_samples(inspection_id, sample_code, sample_quantity, stock_unit, inspection_item,
          result, inspected_at, inspector_name, notes, idempotency_key)
         VALUES ($1, $2::varchar(64), $3::numeric, $4::stock_unit, $5::varchar(160),
                 $6::inspection_sample_result, coalesce($7::timestamptz, now()), $8::varchar(80), $9, $10)
         RETURNING id, sample_code AS "sampleCode", sample_quantity::text AS "sampleQuantity",
                   stock_unit AS "stockUnit", inspection_item AS "inspectionItem", result,
                   inspected_at AS "inspectedAt", inspector_name AS "inspectorName", notes, created_at AS "createdAt"`,
        [
          inspection.id, input.sampleCode || null, sampleQuantity, inspection.stock_unit,
          input.inspectionItem || null, input.result, input.inspectedAt || null,
          input.inspectorName || user.displayName, input.notes || null, key ?? null
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "RECORD_SAMPLE", entityType: "INSPECTION", entityId: inspection.id,
        afterData: sample.rows[0], requestId: request.id
      });
      return { data: sample.rows[0], idempotent: false };
    });
    return reply.status(created.idempotent ? 200 : 201).send({ data: created.data });
  });

  app.post<{ Params: { id: string } }>("/inspections/:id/defects", async (request, reply) => {
    const input = parseInput(inspectionDefectCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const created = await withTransaction(async (client) => {
      if (key) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const existing = await client.query(
          "SELECT * FROM inspection_defects WHERE idempotency_key = $1 LIMIT 1",
          [key]
        );
        if (existing.rows[0]) return { data: existing.rows[0], idempotent: true };
      }
      const inspection = await lockInspection(client, request.params.id);
      assertPending(inspection);
      if (input.sampleId) {
        const sample = await client.query(
          "SELECT id FROM inspection_samples WHERE id = $1 AND inspection_id = $2 FOR SHARE",
          [input.sampleId, inspection.id]
        );
        if (!sample.rowCount) throw new AppError(422, "INVALID_SAMPLE", "样本不属于该检验单");
      }
      let defectQuantity = "0";
      if (compareQuantities(input.defectQuantity, "0") > 0) {
        if (!input.unit) throw new AppError(422, "UNIT_REQUIRED", "记录缺陷数量时必须提供单位");
        try {
          defectQuantity = convertQuantity(input.defectQuantity, input.unit, inspection.stock_unit as StockUnit);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "缺陷单位与检验单库存单位不兼容");
        }
        if (compareQuantities(defectQuantity, inspection.delivered_quantity) > 0) {
          throw new AppError(422, "DEFECT_QUANTITY_EXCEEDED", "缺陷数量不能超过到货数量");
        }
      }
      const defect = await client.query(
        `INSERT INTO inspection_defects(inspection_id, sample_id, defect_type, severity, defect_quantity,
          stock_unit, description, idempotency_key)
         VALUES ($1, $2, $3::varchar(80), $4::defect_severity, $5::numeric,
                 CASE WHEN $5::numeric = 0 THEN NULL ELSE $6::stock_unit END, $7, $8)
         RETURNING id, sample_id AS "sampleId", defect_type AS "defectType", severity,
                   defect_quantity::text AS "defectQuantity",
                   CASE WHEN defect_quantity = 0 THEN NULL ELSE stock_unit END AS "stockUnit",
                   description, created_at AS "createdAt"`,
        [inspection.id, input.sampleId || null, input.defectType, input.severity, defectQuantity,
         inspection.stock_unit, input.description || null, key ?? null]
    );
      await writeAudit(client, {
        actorUserId: user.id, action: "RECORD_DEFECT", entityType: "INSPECTION", entityId: inspection.id,
        afterData: defect.rows[0], requestId: request.id
      });
      return { data: defect.rows[0], idempotent: false };
    });
    return reply.status(created.idempotent ? 200 : 201).send({ data: created.data });
  });

  // 处置是终态动作：行锁 + 状态判断 + 部分唯一索引三重保证，并发调用仅一次生效。
  app.post<{ Params: { id: string } }>("/inspections/:id/disposition", async (request, reply) => {
    const input = parseInput(inspectionDispositionSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const result = await withTransaction(async (client) => {
      if (key) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const replayed = await client.query(
          `SELECT id, inspection_id AS "inspectionId", disposition,
                  accepted_quantity::text AS "acceptedQuantity", stock_unit AS "stockUnit",
                  reason, batch_id AS "batchId", created_at AS "createdAt"
             FROM inspection_dispositions WHERE idempotency_key = $1 LIMIT 1`,
          [key]
        );
        if (replayed.rows[0]) return { disposition: replayed.rows[0], batch: null, idempotent: true };
      }

      // SELECT ... FOR UPDATE 让并发处置排队：第二个事务读到的必然已是终态。
      const inspection = await lockInspection(client, request.params.id);
      if (inspection.status !== "PENDING") {
        throw new AppError(409, "INSPECTION_ALREADY_DISPOSITIONED", "该检验单已经处置，处置不可重复执行");
      }
      if (inspection.version !== input.version) {
        throw new AppError(409, "VERSION_CONFLICT", "检验单已被其他操作修改，请刷新后重试");
      }

      let acceptedQuantity: string | null = null;
      if (input.disposition === "CONCESSION") {
        if (!input.acceptedQuantity) {
          throw new AppError(422, "ACCEPTED_QUANTITY_REQUIRED", "让步接收必须填写让步接收入库数量");
        }
        try {
          acceptedQuantity = convertQuantity(
            input.acceptedQuantity,
            (input.unit ?? inspection.entry_unit) as StockUnit,
            inspection.stock_unit as StockUnit
          );
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "让步数量单位与材料库存单位不兼容");
        }
        if (compareQuantities(acceptedQuantity, "0") <= 0) {
          throw new AppError(422, "INVALID_ACCEPTED_QUANTITY", "让步接收入库数量必须大于 0");
        }
        // 让步接收意味着存在缺陷并被放行；全部数量按合格接收应使用“合格接收”。
        if (compareQuantities(acceptedQuantity, inspection.delivered_quantity) === 0) {
          throw new AppError(422, "CONCESSION_REQUIRES_SHORTAGE", "让步接收数量必须小于到货数量，全部合格请使用合格接收");
        }
        if (compareQuantities(acceptedQuantity, inspection.delivered_quantity) > 0) {
          throw new AppError(422, "ACCEPTED_QUANTITY_EXCEEDED", "让步接收入库数量不能超过到货数量");
        }
      }

      let batch: Record<string, unknown> | null = null;
      if (input.disposition === "REJECTED") {
        // 驳回：只更新检验单状态并留痕，绝不创建批次、不写库存流水。
        await client.query(
          `INSERT INTO inspection_dispositions(inspection_id, disposition, reason, actor_user_id, idempotency_key)
           VALUES ($1, 'REJECTED', $2, $3, $4)`,
          [inspection.id, input.reason, user.id, key ?? null]
        );
        const updated = await client.query(
          `UPDATE incoming_inspections SET status = 'REJECTED', dispositioned_at = now(), version = version + 1
            WHERE id = $1 RETURNING id, status, batch_id AS "batchId", version, dispositioned_at AS "dispositionedAt"`,
          [inspection.id]
        );
        await writeAudit(client, {
          actorUserId: user.id, action: "DISPOSITION_REJECT", entityType: "INSPECTION", entityId: inspection.id,
          beforeData: { status: "PENDING" }, afterData: updated.rows[0], requestId: request.id
        });
        return {
          disposition: {
            inspectionId: inspection.id,
            disposition: "REJECTED",
            acceptedQuantity: null,
            batchId: null,
            reason: input.reason
          },
          batch: null,
          idempotent: false
        };
      }

      const quantity = input.disposition === "CONCESSION"
        ? (acceptedQuantity as string)
        : inspection.delivered_quantity;
      batch = await createBatchFromInspection(client, inspection, quantity, user.id);
      const batchId = batch.id;

      await client.query(
        `INSERT INTO inspection_dispositions(inspection_id, disposition, accepted_quantity, stock_unit,
          reason, batch_id, actor_user_id, idempotency_key)
         VALUES ($1, $2::inspection_disposition, $3::numeric,
                 CASE WHEN $3::numeric IS NULL THEN NULL ELSE $4::stock_unit END,
                 $5, $6, $7, $8)`,
        [inspection.id, input.disposition, input.disposition === "CONCESSION" ? quantity : null,
         inspection.stock_unit, input.reason, batchId, user.id, key ?? null]
      );
      const status = input.disposition === "ACCEPTED" ? "ACCEPTED" : "CONCESSION";
      const updated = await client.query(
        `UPDATE incoming_inspections
           SET status = $1::inspection_status, dispositioned_at = now(), batch_id = $2, version = version + 1
         WHERE id = $3
         RETURNING id, status, batch_id AS "batchId", version, dispositioned_at AS "dispositionedAt"`,
        [status, batchId, inspection.id]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: input.disposition === "ACCEPTED" ? "DISPOSITION_ACCEPT" : "DISPOSITION_CONCESSION",
        entityType: "INSPECTION", entityId: inspection.id,
        beforeData: { status: "PENDING" },
        afterData: { ...updated.rows[0], acceptedQuantity: quantity, reason: input.reason },
        requestId: request.id
      });
      return {
        disposition: {
          inspectionId: inspection.id,
          disposition: input.disposition,
          acceptedQuantity: input.disposition === "CONCESSION" ? quantity : null,
          stockUnit: inspection.stock_unit,
          batchId,
          reason: input.reason
        },
        batch,
        idempotent: false
      };
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: result });
  });
}

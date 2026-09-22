-- 来料质检与让步接收流程
-- 检验单是来料阶段的核算对象；只有处置为 ACCEPTED（合格接收）或
-- CONCESSION（让步接收）时，才会在同一事务中生成 batches 与 OPENING 流水。
-- REJECTED（驳回）绝不产生批次。处置一旦进入终态即不可更改，并发处置仅一次生效。

CREATE TYPE inspection_status AS ENUM ('PENDING', 'ACCEPTED', 'CONCESSION', 'REJECTED');
CREATE TYPE inspection_disposition AS ENUM ('ACCEPTED', 'CONCESSION', 'REJECTED');
CREATE TYPE defect_severity AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');
CREATE TYPE inspection_sample_result AS ENUM ('PENDING', 'PASS', 'FAIL');

CREATE TABLE incoming_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_code varchar(64),
  material_id uuid NOT NULL REFERENCES materials(id),
  source_id uuid REFERENCES sources(id),
  source_note varchar(200),
  location_id uuid REFERENCES storage_locations(id),
  received_at date NOT NULL,
  expiry_at date,
  delivered_quantity numeric(18,6) NOT NULL CHECK (delivered_quantity > 0),
  entry_unit stock_unit NOT NULL,
  stock_unit stock_unit NOT NULL,
  total_cost numeric(18,2) CHECK (total_cost IS NULL OR total_cost >= 0),
  currency char(3),
  initial_color_name varchar(80),
  initial_color_hex char(7) CHECK (initial_color_hex IS NULL OR initial_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  batch_code varchar(64),
  notes text,
  status inspection_status NOT NULL DEFAULT 'PENDING',
  dispositioned_at timestamptz,
  batch_id uuid REFERENCES batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (expiry_at IS NULL OR expiry_at >= received_at),
  -- 只有合格接收 / 让步接收才能关联入库批次；驳回永远没有批次。
  CHECK (
    (status IN ('ACCEPTED', 'CONCESSION') AND batch_id IS NOT NULL)
    OR (status IN ('PENDING', 'REJECTED') AND batch_id IS NULL)
  ),
  CHECK (
    (status = 'PENDING' AND dispositioned_at IS NULL)
    OR (status <> 'PENDING' AND dispositioned_at IS NOT NULL)
  ),
  CONSTRAINT incoming_inspections_material_stock_unit_fk
    FOREIGN KEY (material_id, stock_unit) REFERENCES materials(id, stock_unit)
);
CREATE UNIQUE INDEX inspections_code_uq ON incoming_inspections(lower(inspection_code)) WHERE inspection_code IS NOT NULL;
ALTER TABLE incoming_inspections
  ADD CONSTRAINT incoming_inspections_id_stock_unit_uq UNIQUE (id, stock_unit);
CREATE INDEX inspections_material_idx ON incoming_inspections(material_id, status);
CREATE INDEX inspections_source_idx ON incoming_inspections(source_id);
CREATE INDEX inspections_status_received_idx ON incoming_inspections(status, received_at DESC);
CREATE INDEX inspections_batch_idx ON incoming_inspections(batch_id);
CREATE INDEX inspections_code_trgm_idx ON incoming_inspections USING gin (lower(inspection_code) gin_trgm_ops);

-- 检验样本（抽样记录）：一次检验可登记多个样本。
CREATE TABLE inspection_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES incoming_inspections(id) ON DELETE CASCADE,
  sample_code varchar(64),
  sample_quantity numeric(18,6) NOT NULL CHECK (sample_quantity > 0),
  stock_unit stock_unit NOT NULL,
  inspection_item varchar(160),
  result inspection_sample_result NOT NULL DEFAULT 'PENDING',
  inspected_at timestamptz NOT NULL DEFAULT now(),
  inspector_name varchar(80),
  notes text,
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_samples_inspection_unit_fk
    FOREIGN KEY (inspection_id, stock_unit) REFERENCES incoming_inspections(id, stock_unit)
);
CREATE UNIQUE INDEX inspection_samples_idempotency_uq ON inspection_samples(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inspection_samples_inspection_idx ON inspection_samples(inspection_id, created_at DESC);

-- 缺陷记录：样本检验发现的缺陷；缺陷数量按材料库存单位记录。
CREATE TABLE inspection_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES incoming_inspections(id) ON DELETE CASCADE,
  sample_id uuid REFERENCES inspection_samples(id) ON DELETE SET NULL,
  defect_type varchar(80) NOT NULL,
  severity defect_severity NOT NULL DEFAULT 'MINOR',
  defect_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (defect_quantity >= 0),
  stock_unit stock_unit,
  description text,
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 记录了缺陷数量时必须同时给出单位，且与检验单库存单位一致。
  CHECK (
    (defect_quantity > 0 AND stock_unit IS NOT NULL)
    OR (defect_quantity = 0 AND stock_unit IS NULL)
  ),
  CONSTRAINT inspection_defects_inspection_unit_fk
    FOREIGN KEY (inspection_id, stock_unit) REFERENCES incoming_inspections(id, stock_unit)
);
CREATE UNIQUE INDEX inspection_defects_idempotency_uq ON inspection_defects(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inspection_defects_inspection_idx ON inspection_defects(inspection_id, created_at DESC);
CREATE INDEX inspection_defects_sample_idx ON inspection_defects(sample_id);

-- 处置记录：每张检验单最多只有一条处置（部分唯一索引）。
-- 终态由 incoming_inspections.status 行锁保证，唯一索引在数据库层兜底并发。
CREATE TABLE inspection_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES incoming_inspections(id),
  disposition inspection_disposition NOT NULL,
  accepted_quantity numeric(18,6) CHECK (accepted_quantity IS NULL OR accepted_quantity >= 0),
  stock_unit stock_unit,
  reason text NOT NULL,
  batch_id uuid REFERENCES batches(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 让步接收必须给出让步后入库数量（大于 0）；合格/驳回不携带入库数量。
  CHECK (
    (disposition = 'CONCESSION' AND accepted_quantity IS NOT NULL AND accepted_quantity > 0)
    OR (disposition IN ('ACCEPTED', 'REJECTED') AND accepted_quantity IS NULL)
  ),
  -- 只有让步 / 合格接收能关联批次。
  CHECK (
    (disposition IN ('ACCEPTED', 'CONCESSION') AND batch_id IS NOT NULL)
    OR (disposition = 'REJECTED' AND batch_id IS NULL)
  )
);
-- 并发处置仅生效一次：每张检验单至多一条处置记录。
CREATE UNIQUE INDEX inspection_dispositions_one_per_inspection_uq
  ON inspection_dispositions(inspection_id);
-- 幂等重试（同一 Idempotency-Key）返回已有处置，而不是重复处置。
CREATE UNIQUE INDEX inspection_dispositions_idempotency_uq
  ON inspection_dispositions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inspection_dispositions_batch_idx ON inspection_dispositions(batch_id);

CREATE TRIGGER incoming_inspections_updated_at
  BEFORE UPDATE ON incoming_inspections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 检验单同样可以挂载受保护图片附件（缺陷照片、随货单据等）。
ALTER TYPE attachment_owner_type ADD VALUE 'INSPECTION';

-- 来料质检与让步接收
-- 批次只能由质检处置（合格接收 / 让步接收）产生；驳回不产生批次。
-- 处置状态与批次关联在数据库层只能落定一次，并发处置只有一个事务生效。

CREATE TYPE inspection_status AS ENUM ('PENDING', 'INSPECTING', 'ACCEPTED', 'CONCESSION_ACCEPTED', 'REJECTED');
CREATE TYPE inspection_sample_result AS ENUM ('PENDING', 'PASS', 'FAIL');
CREATE TYPE defect_severity AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');
CREATE TYPE inspection_disposition AS ENUM ('ACCEPT', 'CONCESSION', 'REJECT');

-- 事务内“占用质检单等待绑定批次”使用的占位批次号（不可能是真实批次 UUID）。
-- 用法：UPDATE inspections SET status='ACCEPTED', batch_id=ZERO_UUID, ...
--       INSERT INTO batches(...)
--       UPDATE inspections SET batch_id=<真实批次>

CREATE TABLE inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_no varchar(40) NOT NULL,
  material_id uuid NOT NULL REFERENCES materials(id),
  batch_code varchar(64),
  source_id uuid REFERENCES sources(id),
  source_note varchar(200),
  location_id uuid REFERENCES storage_locations(id),
  received_at date NOT NULL,
  expiry_at date,
  delivered_quantity numeric(18,6) NOT NULL CHECK (delivered_quantity > 0),
  entry_unit stock_unit NOT NULL,
  total_cost numeric(18,2) CHECK (total_cost IS NULL OR total_cost >= 0),
  currency char(3),
  initial_color_name varchar(80),
  initial_color_hex char(7) CHECK (initial_color_hex IS NULL OR initial_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  notes text,
  status inspection_status NOT NULL DEFAULT 'PENDING',
  disposition inspection_disposition,
  disposition_note text,
  concession_reason text,
  concession_approver varchar(80),
  -- 不加外键：占用质检单时先写入占位 UUID；真实批次的存在性由触发器保证。
  batch_id uuid,
  disposed_at timestamptz,
  disposed_by uuid REFERENCES users(id),
  idempotency_key varchar(100),
  disposition_idempotency_key varchar(100),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expiry_at IS NULL OR expiry_at >= received_at),
  CHECK (
    status NOT IN ('ACCEPTED', 'CONCESSION_ACCEPTED')
    OR (disposition IS NOT NULL AND disposed_at IS NOT NULL AND disposed_by IS NOT NULL AND batch_id IS NOT NULL)
  ),
  CHECK (
    status <> 'REJECTED'
    OR (disposition = 'REJECT' AND disposed_at IS NOT NULL AND disposed_by IS NOT NULL AND batch_id IS NULL)
  ),
  CHECK (disposition <> 'CONCESSION' OR (concession_reason IS NOT NULL AND concession_approver IS NOT NULL))
);
CREATE UNIQUE INDEX inspections_no_uq ON inspections(lower(inspection_no));
CREATE UNIQUE INDEX inspections_idempotency_uq ON inspections(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX inspections_disposition_idempotency_uq ON inspections(disposition_idempotency_key) WHERE disposition_idempotency_key IS NOT NULL;
CREATE INDEX inspections_material_status_idx ON inspections(material_id, status, created_at DESC);
CREATE INDEX inspections_source_idx ON inspections(source_id);
CREATE INDEX inspections_status_idx ON inspections(status, created_at DESC);
CREATE INDEX inspections_no_trgm_idx ON inspections USING gin (lower(inspection_no) gin_trgm_ops);

CREATE TABLE inspection_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id),
  sample_no varchar(40) NOT NULL,
  sample_quantity numeric(18,6) CHECK (sample_quantity IS NULL OR sample_quantity > 0),
  stock_unit stock_unit,
  result inspection_sample_result NOT NULL DEFAULT 'PENDING',
  inspected_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX samples_inspection_no_uq ON inspection_samples(inspection_id, lower(sample_no));
CREATE INDEX samples_inspection_idx ON inspection_samples(inspection_id, created_at);

CREATE TABLE inspection_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id),
  defect_type varchar(80) NOT NULL,
  severity defect_severity NOT NULL DEFAULT 'MINOR',
  defect_count integer NOT NULL DEFAULT 1 CHECK (defect_count > 0),
  affected_quantity numeric(18,6) CHECK (affected_quantity IS NULL OR affected_quantity > 0),
  stock_unit stock_unit,
  description text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX defects_inspection_idx ON inspection_defects(inspection_id, created_at);
CREATE INDEX defects_severity_idx ON inspection_defects(severity);

ALTER TABLE batches ADD COLUMN inspection_id uuid REFERENCES inspections(id);
CREATE UNIQUE INDEX batches_inspection_uq ON batches(inspection_id) WHERE inspection_id IS NOT NULL;

CREATE TRIGGER inspections_updated_at BEFORE UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 处置状态机：
-- 1. PENDING/INSPECTING 是开放态；终态（接收/让步接收/驳回）落定后所有处置字段冻结。
-- 2. batch_id 只能绑定一次（开放态绑定占位 UUID，随后替换为真实批次）。
-- 3. 只有接收类终态可以持有 batch_id；驳回终态永远为 NULL。
CREATE OR REPLACE FUNCTION inspection_terminal_guard() RETURNS trigger AS $inspection_guard$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('ACCEPTED', 'CONCESSION_ACCEPTED', 'REJECTED') THEN
    -- 唯一例外：占用质检单后，把占位批次 UUID 换成刚创建好的真实批次。
    -- 行锁由“条件 UPDATE 占用”取得，并发处置中只有一个事务能进入该分支。
    IF OLD.batch_id = '00000000-0000-0000-0000-000000000000'::uuid
       AND NEW.batch_id <> '00000000-0000-0000-0000-000000000000'::uuid
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.disposition IS NOT DISTINCT FROM NEW.disposition
       AND OLD.disposition_note IS NOT DISTINCT FROM NEW.disposition_note
       AND OLD.concession_reason IS NOT DISTINCT FROM NEW.concession_reason
       AND OLD.concession_approver IS NOT DISTINCT FROM NEW.concession_approver
       AND OLD.disposed_at IS NOT DISTINCT FROM NEW.disposed_at
       AND OLD.disposed_by IS NOT DISTINCT FROM NEW.disposed_by THEN
      IF NOT EXISTS (
        SELECT 1 FROM batches b
         WHERE b.id = NEW.batch_id AND b.status IN ('ACTIVE', 'DEPLETED')
      ) THEN
        RAISE EXCEPTION 'inspection batch_id must reference an existing in-stock batch';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.batch_id IS DISTINCT FROM NEW.batch_id
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.disposition IS DISTINCT FROM NEW.disposition
       OR OLD.disposition_note IS NOT DISTINCT FROM NEW.disposition_note
       OR OLD.concession_reason IS NOT DISTINCT FROM NEW.concession_reason
       OR OLD.concession_approver IS NOT DISTINCT FROM NEW.concession_approver
       OR OLD.disposed_at IS NOT DISTINCT FROM NEW.disposed_at
       OR OLD.disposed_by IS NOT DISTINCT FROM NEW.disposed_by THEN
      RAISE EXCEPTION 'inspection already disposed: result is frozen';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.batch_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.batch_id IS NOT NULL AND OLD.batch_id IS DISTINCT FROM NEW.batch_id THEN
      RAISE EXCEPTION 'inspection batch can only be bound once';
    END IF;
    IF NEW.status NOT IN ('ACCEPTED', 'CONCESSION_ACCEPTED') THEN
      RAISE EXCEPTION 'only accepted inspections may be bound to a batch';
    END IF;
    -- 占位 UUID 允许暂存；真实 UUID 必须引用已存在的在库批次。
    IF NEW.batch_id <> '00000000-0000-0000-0000-000000000000'::uuid
       AND NOT EXISTS (
         SELECT 1 FROM batches b
          WHERE b.id = NEW.batch_id AND b.status IN ('ACTIVE', 'DEPLETED')
       ) THEN
      RAISE EXCEPTION 'inspection batch_id must reference an existing in-stock batch';
    END IF;
  END IF;
  RETURN NEW;
END;
$inspection_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inspections_terminal_guard ON inspections;
CREATE TRIGGER inspections_terminal_guard
  BEFORE INSERT OR UPDATE OF batch_id, status, disposition, disposition_note,
    concession_reason, concession_approver, disposed_at, disposed_by
  ON inspections
  FOR EACH ROW EXECUTE FUNCTION inspection_terminal_guard();

-- 批次必须挂在“接收/让步接收”的质检单上；被驳回的质检单不可能有批次。
CREATE OR REPLACE FUNCTION batch_inspection_guard() RETURNS trigger AS $batch_guard$
DECLARE
  bound inspection_status;
  linked boolean;
BEGIN
  IF NEW.inspection_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO bound FROM inspections WHERE id = NEW.inspection_id;
  IF bound IS NULL THEN
    RAISE EXCEPTION 'batch inspection does not exist';
  END IF;
  IF bound NOT IN ('ACCEPTED', 'CONCESSION_ACCEPTED') THEN
    RAISE EXCEPTION 'batch can only be created from an accepted inspection';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM inspections WHERE batch_id = NEW.id AND id <> NEW.inspection_id
  ) INTO linked;
  IF linked THEN
    RAISE EXCEPTION 'batch already linked to another inspection';
  END IF;
  RETURN NEW;
END;
$batch_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS batches_inspection_guard ON batches;
CREATE TRIGGER batches_inspection_guard
  BEFORE INSERT OR UPDATE OF inspection_id
  ON batches
  FOR EACH ROW EXECUTE FUNCTION batch_inspection_guard();

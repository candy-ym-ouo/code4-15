export type ApiMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Material = {
  id: string;
  code: string | null;
  name: string;
  craftTypes: string[];
  subtype: string | null;
  stockUnit: string;
  lowStockThreshold: string | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  tags: string[];
  notes: string | null;
  remainingQuantity: string;
  batchCount: number;
  stockState: string;
  archivedAt: string | null;
  updatedAt: string;
  version: number;
};

export type Batch = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  initialQuantity: string;
  remainingQuantity: string;
  stockUnit: string;
  currentColorName: string | null;
  currentColorHex: string | null;
  status: string;
  notes: string | null;
  inspectionId: string | null;
  version: number;
  updatedAt: string;
};

export type Source = {
  id: string;
  name: string;
  type: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: string | null;
  batchCount: number;
  activeBatchCount: number;
};

export type Location = {
  id: string;
  name: string;
  parentId: string | null;
  notes: string | null;
  batchCount: number;
  archivedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  craftType: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  description: string | null;
  targetColorName: string | null;
  targetColorHex: string | null;
  tags: string[];
  requirementCount: number;
  consumptionCount: number;
  version: number;
  updatedAt: string;
};

export type Consumption = {
  id: string;
  projectId: string;
  projectName: string;
  projectRequirementId: string | null;
  batchId: string;
  batchCode: string | null;
  materialId: string;
  materialName: string;
  sourceName: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  stockUnit: string;
  consumedAt: string;
  purpose: string | null;
  notes: string | null;
  status: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

export type Inspection = {
  id: string;
  inspectionNo: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  craftTypes: string[];
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceNote: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  deliveredQuantity: string;
  entryUnit: string;
  totalCost: string | null;
  currency: string | null;
  initialColorName: string | null;
  initialColorHex: string | null;
  notes: string | null;
  status: string;
  disposition: string | null;
  dispositionNote: string | null;
  concessionReason: string | null;
  concessionApprover: string | null;
  batchId: string | null;
  disposedAt: string | null;
  createdAt: string;
  updatedAt: string;
  samples?: InspectionSample[];
  defects?: InspectionDefect[];
  batch?: {
    id: string;
    batchCode: string | null;
    remainingQuantity: string;
    initialQuantity: string;
    stockUnit: string;
    status: string;
  } | null;
};

export type InspectionSample = {
  id: string;
  sampleNo: string;
  sampleQuantity: string | null;
  stockUnit: string | null;
  result: string;
  inspectedAt: string;
  notes: string | null;
  createdAt: string;
};

export type InspectionDefect = {
  id: string;
  defectType: string;
  severity: string;
  defectCount: number;
  affectedQuantity: string | null;
  stockUnit: string | null;
  description: string | null;
  createdAt: string;
};

export const craftTypeLabels: Record<string, string> = {
  DYEING: "染布",
  WOODWORKING: "木工",
  POTTERY: "陶艺",
  METALWORKING: "金工",
  GENERAL: "通用",
  OTHER: "其他"
};

export const statusLabels: Record<string, string> = {
  ACTIVE: "有库存",
  DEPLETED: "已耗尽",
  ARCHIVED: "已归档",
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  REVERSED: "已撤销"
};

export const movementLabels: Record<string, string> = {
  OPENING: "初始入库",
  PURCHASE: "采购入库",
  CONSUMPTION: "材料消耗",
  ADJUSTMENT_IN: "盘增",
  ADJUSTMENT_OUT: "盘减",
  REVERSAL: "撤销恢复"
};

export const inspectionStatusLabels: Record<string, string> = {
  PENDING: "待检验",
  INSPECTING: "检验中",
  ACCEPTED: "合格接收",
  CONCESSION_ACCEPTED: "让步接收",
  REJECTED: "已驳回"
};

export const inspectionSampleResultLabels: Record<string, string> = {
  PENDING: "待判定",
  PASS: "合格",
  FAIL: "不合格"
};

export const defectSeverityLabels: Record<string, string> = {
  MINOR: "轻微",
  MAJOR: "主要",
  CRITICAL: "严重"
};

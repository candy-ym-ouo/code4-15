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

export type Inspection = {
  id: string;
  inspectionCode: string | null;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  craftTypes: string[];
  sourceId: string | null;
  sourceName: string | null;
  sourceNote: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  deliveredQuantity: string;
  entryUnit: string;
  stockUnit: string;
  totalCost: string | null;
  currency: string | null;
  initialColorName: string | null;
  initialColorHex: string | null;
  batchCode: string | null;
  notes: string | null;
  status: "PENDING" | "ACCEPTED" | "CONCESSION" | "REJECTED";
  dispositionedAt: string | null;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  sampleCount?: number;
  defectCount?: number;
  defectQuantity?: string;
};

export type InspectionSample = {
  id: string;
  sampleCode: string | null;
  sampleQuantity: string;
  stockUnit: string;
  inspectionItem: string | null;
  result: "PENDING" | "PASS" | "FAIL";
  inspectedAt: string;
  inspectorName: string | null;
  notes: string | null;
  createdAt: string;
};

export type InspectionDefect = {
  id: string;
  sampleId: string | null;
  defectType: string;
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  defectQuantity: string;
  stockUnit: string | null;
  description: string | null;
  createdAt: string;
};

export type InspectionDisposition = {
  id?: string;
  inspectionId?: string;
  disposition: "ACCEPTED" | "CONCESSION" | "REJECTED";
  acceptedQuantity: string | null;
  stockUnit?: string | null;
  reason: string;
  batchId: string | null;
  createdAt?: string;
};

export type InspectionDetail = Inspection & {
  samples: InspectionSample[];
  defects: InspectionDefect[];
  disposition: InspectionDisposition | null;
  attachments: Attachment[];
};

export type Attachment = {
  id: string;
  originalName: string;
  mimeType: string;
  byteSize: string;
  createdAt: string;
};

export const inspectionStatusLabels: Record<string, string> = {
  PENDING: "待检验",
  ACCEPTED: "合格接收",
  CONCESSION: "让步接收",
  REJECTED: "驳回"
};

export const defectSeverityLabels: Record<string, string> = {
  MINOR: "轻微",
  MAJOR: "主要",
  CRITICAL: "严重"
};

export const sampleResultLabels: Record<string, string> = {
  PENDING: "待判定",
  PASS: "合格",
  FAIL: "不合格"
};

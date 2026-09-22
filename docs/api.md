# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整、材料消耗，以及来料检验的样本、缺陷和处置支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

> 来料正常入库必须先经过“来料质检”流程（见第 5a 节）：只有 `ACCEPTED`（合格接收）或
> `CONCESSION`（让步接收）才会生成批次；`REJECTED`（驳回）不产生批次。

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 5a. 来料质检与让步接收

到货先创建检验单（`PENDING`），再登记样本与缺陷，最后做一次性处置：

- `ACCEPTED`：合格接收，按到货全部数量生成批次与 `OPENING` 流水（`referenceType=INSPECTION`）。
- `CONCESSION`：让步接收，按 `acceptedQuantity`（必须小于到货数量）生成批次入库。
- `REJECTED`：驳回，**不生成批次、不写库存流水**。

处置是终态动作，仅可执行一次。接口通过 `SELECT ... FOR UPDATE` 行锁与状态判断串行化并发处置，
数据库层还有“一检一处置”部分唯一索引兜底；并发调用时第一个生效，其余返回
`409 INSPECTION_ALREADY_DISPOSITIONED`。处置、样本和缺陷接口均支持 `Idempotency-Key`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/inspections` | 检验单查询或来料登记（不产生批次） |
| GET/PATCH | `/inspections/:id` | 检验详情（含样本、缺陷、处置、附件）或补充非业务字段 |
| POST | `/inspections/:id/samples` | 登记检验样本（仅 `PENDING`） |
| POST | `/inspections/:id/defects` | 登记缺陷（仅 `PENDING`） |
| POST | `/inspections/:id/disposition` | 终态处置（仅一次） |

检验列表查询参数：`q`、`status=PENDING|ACCEPTED|CONCESSION|REJECTED`、`materialId`、`sourceId`、
`locationId`、`from`、`to`。

来料登记（数量按材料库存单位换算存储）：

```json
{
  "materialId": "uuid",
  "inspectionCode": "IQC-20260922-01",
  "sourceId": "uuid",
  "locationId": "uuid",
  "receivedAt": "2026-09-22",
  "deliveredQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY",
  "batchCode": "B-20260922-01"
}
```

样本：

```json
{ "sampleCode": "S-1", "sampleQuantity": "200", "unit": "g", "inspectionItem": "含水率", "result": "FAIL" }
```

缺陷（`defectQuantity` 为 0 时可省略 `unit`；严重度 `MINOR|MAJOR|CRITICAL`）：

```json
{ "sampleId": "uuid", "defectType": "受潮结块", "severity": "MAJOR", "defectQuantity": "100", "unit": "g" }
```

合格接收 / 驳回：

```json
{ "disposition": "ACCEPTED", "reason": "抽检全部合格", "version": 1 }
```

```json
{ "disposition": "REJECTED", "reason": "严重受潮霉变，整批驳回", "version": 1 }
```

让步接收（`acceptedQuantity` 使用 `unit` 计量，服务端换算为库存单位；必须大于 0 且小于到货量）：

```json
{ "disposition": "CONCESSION", "acceptedQuantity": "900", "unit": "g", "reason": "轻微色差，让步放行用于非关键部位", "version": 1 }
```

成功处置响应：

```json
{
  "data": {
    "disposition": { "inspectionId": "uuid", "disposition": "CONCESSION", "acceptedQuantity": "900.000000", "stockUnit": "g", "batchId": "uuid" },
    "batch": { "id": "uuid" }
  }
}
```

驳回时 `disposition.batchId` 为 `null`，且 `batch` 为 `null`。检验单支持 `INSPECTION` 类型图片附件。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT`、`CONSUMPTION` 或 `INSPECTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。

# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：来料报检、质检处置、库存调整和材料消耗支持 `Idempotency-Key`。
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

## 5. 来料质检与让步接收

来料必须先报检；只有“合格接收”或“让步接收”才会创建批次并入库，驳回不产生批次。处置只能执行一次。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/inspections` | 质检单查询或来料报检 |
| GET | `/inspections/:id` | 质检单详情（含样本、缺陷、批次） |
| POST | `/inspections/:id/samples` | 登记检验样本 |
| POST | `/inspections/:id/defects` | 登记缺陷 |
| POST | `/inspections/:id/disposition` | 处置：ACCEPT/CONCESSION/REJECT |

报检：

```json
{
  "inspectionNo": "IQC-20260922-01",
  "materialId": "uuid",
  "batchCode": "供应商批号（可选）",
  "sourceId": "uuid",
  "receivedAt": "2026-09-22",
  "deliveredQuantity": "1",
  "entryUnit": "kg"
}
```

登记样本：`{ "sampleNo": "S1", "sampleQuantity": "10", "unit": "g", "result": "PASS" }`，`result` 为 `PASS`/`FAIL`/`PENDING`。
登记缺陷：`{ "defectType": "色差", "severity": "MINOR", "defectCount": 2 }`，严重度为 `MINOR`/`MAJOR`/`CRITICAL`。

处置：

```json
{
  "disposition": "CONCESSION",
  "concessionReason": "轻微色差，降级使用",
  "concessionApprover": "王工",
  "note": "限定非外露部件使用"
}
```

处置规则：

- `ACCEPT`：至少一个样本，且无不合格样本、无缺陷；按到货数量创建批次并生成 `OPENING` 流水。
- `CONCESSION`：至少一个样本且无 `CRITICAL` 缺陷，必须提供 `concessionReason`、`concessionApprover`；同样按到货数量入库，流水原因标注让步接收。
- `REJECT`：必须提供 `note`；不创建批次、不产生流水，质检单保留为驳回记录。
- 处置使用条件更新在数据库层占用质检单，并发处置只有一个事务生效；终态后处置字段冻结，重复处置返回 `409 INSPECTION_ALREADY_DISPOSED`。
- 支持 `Idempotency-Key`：同一键并发/重试返回同一批次，不会二次入库。

质检单状态：`PENDING`（待检验）、`INSPECTING`（已登记样本或缺陷）、`ACCEPTED`、`CONCESSION_ACCEPTED`、`REJECTED`。

## 6. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/batches` | 批次查询（入库只能通过质检处置） |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

`POST /batches` 已关闭并返回 `405 INSPECTION_REQUIRED`；批次的 `inspectionId` 指向来源质检单。批次与质检单由数据库触发器双向校验：批次只能挂在接收类质检单上，一张质检单最多产生一个批次，驳回质检单永远没有批次。

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

## 7. 项目与需求

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

## 8. 消耗与撤销

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

## 9. 颜色变化

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

## 10. 附件和导出

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

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。

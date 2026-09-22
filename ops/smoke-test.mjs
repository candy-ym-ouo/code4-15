const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const configuredPassword = process.env.SMOKE_PASSWORD;
if (!configuredPassword) {
  throw new Error("SMOKE_PASSWORD is required");
}
let cookie = "";

async function callWithStatus(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers,
    body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload };
}

async function call(path, options = {}) {
  return (await callWithStatus(path, options)).data;
}

// 并发竞态测试需要同时保留 2xx 与 4xx 响应，不能抛错。
async function callAllowConflict(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers,
    body: JSON.stringify(options.body)
  });
  const payload = response.status === 204 ? null : await response.json();
  return { status: response.status, data: payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const status = await call("/setup/status");
if (!status.data.initialized) {
  await call("/setup", { method: "POST", body: { displayName: "Smoke Test Operator", password: configuredPassword } });
  console.log("Initialized a new empty workspace.");
} else {
  await call("/auth/login", { method: "POST", body: { password: configuredPassword } });
}

const suffix = Date.now().toString(36);
const source = await call("/sources", { method: "POST", body: { name: `Smoke Source ${suffix}`, type: "PURCHASED" } });
const material = await call("/materials", {
  method: "POST",
  body: {
    code: `SMOKE-${suffix}`,
    name: `Smoke Material ${suffix}`,
    craftTypes: ["GENERAL"],
    stockUnit: "g",
    lowStockThreshold: "100",
    defaultColorName: "Original",
    defaultColorHex: "#8B5A2B",
    tags: ["smoke"]
  }
});
const batchPayload = {
  materialId: material.data.id,
  batchCode: `B-${suffix}`,
  sourceId: source.data.id,
  receivedAt: new Date().toISOString().slice(0, 10),
  initialQuantity: "1",
  entryUnit: "kg"
};
const [batchResult, repeatedBatchResult] = await Promise.all([
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  }),
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  })
]);
assert([200, 201].includes(batchResult.status) && [200, 201].includes(repeatedBatchResult.status), "Concurrent batch idempotency returned an unexpected status");
const batch = batchResult.status === 201 ? batchResult.data.data : repeatedBatchResult.data.data;
const repeatedBatch = batchResult.status === 201 ? repeatedBatchResult.data.data : batchResult.data.data;
assert(repeatedBatch.id === batch.id, "Batch idempotency returned a different batch");
const project = await call("/projects", {
  method: "POST",
  body: { name: `Smoke Project ${suffix}`, craftType: "GENERAL", status: "PLANNED" }
});
const requirement = await call(`/projects/${project.data.id}/requirements`, {
  method: "POST",
  body: { materialId: material.data.id, requiredQuantity: "500", unit: "g", purpose: "Smoke verification" }
});
const consumptionPayload = {
  projectId: project.data.id,
  projectRequirementId: requirement.data.id,
  batchId: batch.id,
  usedQuantity: "450",
  wasteQuantity: "50",
  unit: "g",
  purpose: "Smoke verification"
};
const [consumptionResult, repeatedConsumptionResult] = await Promise.all([
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  }),
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  })
]);
assert([200, 201].includes(consumptionResult.status) && [200, 201].includes(repeatedConsumptionResult.status), "Concurrent consumption idempotency returned an unexpected status");
const consumption = consumptionResult.status === 201 ? consumptionResult.data.data : repeatedConsumptionResult.data.data;
const repeatedConsumption = consumptionResult.status === 201 ? repeatedConsumptionResult.data.data : consumptionResult.data.data;
assert(repeatedConsumption.id === consumption.id, "Consumption idempotency returned a different row");
assert(consumption.totalQuantity === "500.000000", "Consumption total is incorrect");

const latestOccurredAt = new Date();
await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Smoke Brown",
    afterColorHex: "#6B2F1F",
    affectedQuantity: "450",
    unit: "g",
    occurredAt: latestOccurredAt.toISOString()
  }
});
const backdatedColor = await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Backdated Blue",
    afterColorHex: "#0000FF",
    occurredAt: new Date(latestOccurredAt.getTime() - 60_000).toISOString()
  }
});
assert(backdatedColor.data.isCurrent === false, "Backdated color was treated as current");

const afterConsumption = await call(`/batches/${batch.id}`);
assert(afterConsumption.data.remainingQuantity === "500.000000", "Batch balance after consumption is incorrect");
assert(afterConsumption.data.currentColorName === "Smoke Brown", "Current color was not updated");
const projectAfterConsumption = await call(`/projects/${project.data.id}`);
assert(projectAfterConsumption.data.requirements[0].actualQuantity === "500.000000", "Project actual quantity is incorrect");
assert(projectAfterConsumption.data.status === "IN_PROGRESS", "First consumption did not start the planned project");

await call(`/consumptions/${consumption.id}/reverse`, { method: "POST", body: { reason: "Automated smoke test reversal" } });
const afterReversal = await call(`/batches/${batch.id}`);
assert(afterReversal.data.remainingQuantity === "1000.000000", "Batch balance after reversal is incorrect");
assert(afterReversal.data.movements[0].type === "REVERSAL", "Reversal movement was not created");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

// ---- 来料质检与让步接收链 ----
// 1) 待检登记不产生批次、不产生库存流水。
const inspectionPending = await call("/inspections", {
  method: "POST",
  body: { materialId: material.data.id, inspectionCode: `IQC-PENDING-${suffix}`, sourceId: source.data.id, receivedAt: new Date().toISOString().slice(0, 10), deliveredQuantity: "1", entryUnit: "kg" }
});
assert(inspectionPending.data.status === "PENDING", "New inspection must be PENDING");
assert(inspectionPending.data.deliveredQuantity === "1000.000000", "Inspection delivered quantity was not converted to stock unit");
assert(inspectionPending.data.batchId === null, "Pending inspection must not reference a batch");
const pendingDetail = await call(`/inspections/${inspectionPending.data.id}`);
assert(pendingDetail.data.disposition === null && pendingDetail.data.samples.length === 0, "Pending inspection should have no disposition");

// 2) 记录样本与缺陷。
const sample = await call(`/inspections/${inspectionPending.data.id}/samples`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-iqc-sample-${suffix}` },
  body: { sampleCode: `S-${suffix}`, sampleQuantity: "200", unit: "g", inspectionItem: "外观与含水率", result: "FAIL" }
});
assert(sample.data.sampleQuantity === "200.000000", "Sample quantity was not normalized");
const defect = await call(`/inspections/${inspectionPending.data.id}/defects`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-iqc-defect-${suffix}` },
  body: { sampleId: sample.data.id, defectType: "受潮结块", severity: "MAJOR", defectQuantity: "0.1", unit: "kg", description: "Smoke defect" }
});
assert(defect.data.defectQuantity === "100.000000", "Defect quantity was not converted to stock unit");

// 3) 并发处置仅一次生效：合格与驳回同时提交，必有且仅有一个 201。
const [raceAccept, raceReject] = await Promise.all([
  callAllowConflict(`/inspections/${inspectionPending.data.id}/disposition`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-iqc-race-accept-${suffix}` },
    body: { disposition: "ACCEPTED", reason: "Smoke concurrent accept", version: 1 }
  }),
  callAllowConflict(`/inspections/${inspectionPending.data.id}/disposition`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-iqc-race-reject-${suffix}` },
    body: { disposition: "REJECTED", reason: "Smoke concurrent reject", version: 1 }
  })
]);
const raceCreated = [raceAccept, raceReject].filter((response) => response.status === 201);
const raceConflict = [raceAccept, raceReject].filter((response) => response.status === 409);
assert(raceCreated.length === 1 && raceConflict.length === 1, "Concurrent dispositions must apply exactly once");
assert(raceConflict[0].data.error.code === "INSPECTION_ALREADY_DISPOSITIONED", "Losing disposition must report already-dispositioned");
const racedDetail = await call(`/inspections/${inspectionPending.data.id}`);
assert(["ACCEPTED", "REJECTED"].includes(racedDetail.data.status), "Raced inspection must reach a final state");
assert(
  racedDetail.data.status === "REJECTED" ? racedDetail.data.batchId === null : racedDetail.data.batchId !== null,
  "Raced inspection batch linkage must match its final state"
);
// 终态后再登记样本必须被拒绝。
const lateSample = await callAllowConflict(`/inspections/${inspectionPending.data.id}/samples`, {
  method: "POST",
  body: { sampleQuantity: "10", unit: "g" }
});
assert(lateSample.status === 409, "Samples must be rejected after disposition");

// 4) 确定路径：驳回不产生批次。
const rejectedInspection = await call("/inspections", {
  method: "POST",
  body: { materialId: material.data.id, inspectionCode: `IQC-REJECT-${suffix}`, receivedAt: new Date().toISOString().slice(0, 10), deliveredQuantity: "1", entryUnit: "kg" }
});
const rejected = await call(`/inspections/${rejectedInspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-iqc-reject-${suffix}` },
  body: { disposition: "REJECTED", reason: "Smoke full rejection", version: 1 }
});
assert(rejected.data.disposition.batchId === null, "Rejected disposition must not create a batch");
const rejectedDetail = await call(`/inspections/${rejectedInspection.data.id}`);
assert(rejectedDetail.data.status === "REJECTED" && rejectedDetail.data.batchId === null, "Rejected inspection must have no batch");

// 5) 确定路径：让步接收仅让步数量入库。
const concessionInspection = await call("/inspections", {
  method: "POST",
  body: { materialId: material.data.id, inspectionCode: `IQC-CONCESSION-${suffix}`, receivedAt: new Date().toISOString().slice(0, 10), deliveredQuantity: "1", entryUnit: "kg" }
});
const concession = await call(`/inspections/${concessionInspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-iqc-concession-${suffix}` },
  body: { disposition: "CONCESSION", acceptedQuantity: "900", unit: "g", reason: "Smoke concession for minor defect", version: 1 }
});
assert(concession.data.disposition.batchId !== null, "Concession disposition must create a batch");
const concessionBatch = await call(`/batches/${concession.data.disposition.batchId}`);
assert(concessionBatch.data.initialQuantity === "900.000000" && concessionBatch.data.remainingQuantity === "900.000000", "Concession batch must hold only the accepted quantity");
assert(concessionBatch.data.movements[0].type === "OPENING" && concessionBatch.data.movements[0].referenceType === "INSPECTION", "Concession opening movement must reference the inspection");

// 6) 确定路径：合格接收全部入库。
const acceptedInspection = await call("/inspections", {
  method: "POST",
  body: { materialId: material.data.id, inspectionCode: `IQC-ACCEPT-${suffix}`, receivedAt: new Date().toISOString().slice(0, 10), deliveredQuantity: "1", entryUnit: "kg" }
});
const accepted = await call(`/inspections/${acceptedInspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-iqc-accept-${suffix}` },
  body: { disposition: "ACCEPTED", reason: "Smoke full acceptance", version: 1 }
});
const acceptedBatch = await call(`/batches/${accepted.data.disposition.batchId}`);
assert(acceptedBatch.data.initialQuantity === "1000.000000", "Accepted batch must hold the full delivered quantity");

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id,
  pendingInspectionId: inspectionPending.data.id,
  rejectedInspectionId: rejectedInspection.data.id,
  concessionInspectionId: concessionInspection.data.id,
  concessionBatchId: concession.data.disposition.batchId,
  acceptedInspectionId: acceptedInspection.data.id
}, null, 2));

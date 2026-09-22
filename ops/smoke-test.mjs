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
const inspectionPayload = {
  inspectionNo: `IQC-${suffix}`,
  materialId: material.data.id,
  batchCode: `B-${suffix}`,
  sourceId: source.data.id,
  receivedAt: new Date().toISOString().slice(0, 10),
  deliveredQuantity: "1",
  entryUnit: "kg"
};
const inspection = await call("/inspections", {
  method: "POST",
  headers: { "idempotency-key": `smoke-inspection-${suffix}` },
  body: inspectionPayload
});
assert(inspection.data.status === "PENDING", "New inspection should be PENDING");
assert(!inspection.data.batchId, "Pending inspection must not have a batch");

await call(`/inspections/${inspection.data.id}/samples`, {
  method: "POST",
  body: { sampleNo: "S1", sampleQuantity: "10", unit: "g", result: "PASS", notes: "外观与重量抽检合格" }
});
const inspectionAfterSample = await call(`/inspections/${inspection.data.id}`);
assert(inspectionAfterSample.data.status === "INSPECTING", "Recording a sample should move the inspection to INSPECTING");
assert(inspectionAfterSample.data.samples.length === 1, "Sample was not recorded");

// 并发处置只有一个生效；同一 Idempotency-Key 的并发请求必须返回同一批次。
const dispositionPayload = { disposition: "ACCEPT" };
const [acceptResult, repeatedAcceptResult] = await Promise.all([
  callWithStatus(`/inspections/${inspection.data.id}/disposition`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-accept-${suffix}` },
    body: dispositionPayload
  }),
  callWithStatus(`/inspections/${inspection.data.id}/disposition`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-accept-${suffix}` },
    body: dispositionPayload
  })
]);
assert([200, 201].includes(acceptResult.status) && [200, 201].includes(repeatedAcceptResult.status), "Concurrent disposition returned an unexpected status");
const accepted = acceptResult.status === 201 ? acceptResult.data : repeatedAcceptResult.data;
const repeatedAccepted = acceptResult.status === 201 ? repeatedAcceptResult.data : acceptResult.data;
assert(accepted.batch?.id, "Accepted disposition must create a batch");
assert(repeatedAccepted.batch?.id === accepted.batch.id, "Concurrent disposition did not apply exactly once");
const batchResponse = await call(`/batches/${accepted.batch.id}`);
const batch = batchResponse.data;
assert(batch.remainingQuantity === "1000.000000", "Inspection batch opening quantity is incorrect");
assert(batch.inspectionId === inspection.data.id, "Batch is not linked to the inspection");

// 第二次处置（不同 key）必须被拒绝：处置只能执行一次。
const secondDisposition = await callWithStatus(`/inspections/${inspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-accept-again-${suffix}` },
  body: { disposition: "REJECT", note: "should not happen" }
});
assert(secondDisposition.status === 409, "A second disposition must be rejected with 409");

// 驳回流程：不合格样本 + 驳回处置，永远不产生批次。
const rejectedInspection = await call("/inspections", {
  method: "POST",
  headers: { "idempotency-key": `smoke-inspection-reject-${suffix}` },
  body: {
    inspectionNo: `IQC-R-${suffix}`,
    materialId: material.data.id,
    sourceId: source.data.id,
    receivedAt: new Date().toISOString().slice(0, 10),
    deliveredQuantity: "200",
    entryUnit: "g"
  }
});
await call(`/inspections/${rejectedInspection.data.id}/samples`, {
  method: "POST",
  body: { sampleNo: "S1", sampleQuantity: "20", unit: "g", result: "FAIL", notes: "样本破损" }
});
const rejected = await call(`/inspections/${rejectedInspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-reject-${suffix}` },
  body: { disposition: "REJECT", note: "整批包装破损，退回供应商" }
});
assert(rejected.data.inspection.status === "REJECTED", "Disposition should be REJECTED");
assert(rejected.data.batch === null, "Rejected inspection must not create a batch");
const rejectedDetail = await call(`/inspections/${rejectedInspection.data.id}`);
assert(rejectedDetail.data.batchId === null, "Rejected inspection must keep batchId null");
assert(rejectedDetail.data.batch === null, "Rejected inspection detail must not expose a batch");

// 直接 POST /batches 已被关闭，来料必须走质检。
const directBatch = await callWithStatus("/batches", { method: "POST", body: {} });
assert(directBatch.status === 405, "Direct batch creation must be blocked");

// 让步接收流程：轻微缺陷 + 让步原因/批准人，按到货数量入库。
const concessionInspection = await call("/inspections", {
  method: "POST",
  headers: { "idempotency-key": `smoke-inspection-concession-${suffix}` },
  body: {
    inspectionNo: `IQC-C-${suffix}`,
    materialId: material.data.id,
    sourceId: source.data.id,
    receivedAt: new Date().toISOString().slice(0, 10),
    deliveredQuantity: "300",
    entryUnit: "g"
  }
});
await call(`/inspections/${concessionInspection.data.id}/samples`, {
  method: "POST",
  body: { sampleNo: "S1", sampleQuantity: "30", unit: "g", result: "PASS", notes: "功能性合格" }
});
await call(`/inspections/${concessionInspection.data.id}/defects`, {
  method: "POST",
  body: { defectType: "色差", severity: "MINOR", defectCount: 2, affectedQuantity: "50", unit: "g", description: "轻微色差，可降级使用" }
});
const concession = await call(`/inspections/${concessionInspection.data.id}/disposition`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-concession-${suffix}` },
  body: { disposition: "CONCESSION", concessionReason: "轻微色差，降级使用", concessionApprover: "Smoke Lead", note: "限定用于非外露部件" }
});
assert(concession.data.inspection.status === "CONCESSION_ACCEPTED", "Concession disposition status mismatch");
assert(concession.data.batch?.id, "Concession acceptance must create a batch");
const concessionBatch = await call(`/batches/${concession.data.batch.id}`);
assert(concessionBatch.data.remainingQuantity === "300.000000", "Concession batch opening quantity is incorrect");
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

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id
}, null, 2));

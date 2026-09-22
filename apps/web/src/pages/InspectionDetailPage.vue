<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { createIdempotencyKey } from "@/lib/idempotency";
import { localDateTimeValue } from "@/lib/dates";
import { defectSeverityLabels, inspectionStatusLabels, sampleResultLabels, type InspectionDetail } from "@/types";
import AttachmentPanel from "@/components/AttachmentPanel.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const inspection = ref<InspectionDetail | null>(null);

const sampleDialog = reactive({ visible: false, form: { sampleCode: "", sampleQuantity: "", unit: "", inspectionItem: "", result: "PENDING", inspectedAt: localDateTimeValue(), inspectorName: "", notes: "" } });
const defectDialog = reactive({ visible: false, form: { sampleId: "", defectType: "", severity: "MINOR", defectQuantity: "", unit: "", description: "" } });
const dispositionDialog = reactive({ visible: false, form: { disposition: "ACCEPTED", acceptedQuantity: "", unit: "", reason: "" } });

const isPending = computed(() => inspection.value?.status === "PENDING");
const severityTagType: Record<string, string> = { MINOR: "info", MAJOR: "warning", CRITICAL: "danger" };
const sampleTagType: Record<string, string> = { PENDING: "info", PASS: "success", FAIL: "danger" };

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: InspectionDetail }>(`/inspections/${route.params.id}`);
    inspection.value = response.data;
    sampleDialog.form.unit = response.data.entryUnit;
    defectDialog.form.unit = response.data.entryUnit;
    dispositionDialog.form.unit = response.data.entryUnit;
    dispositionDialog.form.acceptedQuantity = response.data.deliveredQuantity;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "检验单加载失败");
  } finally {
    loading.value = false;
  }
}

function openSampleDialog() {
  Object.assign(sampleDialog.form, {
    sampleCode: "", sampleQuantity: "", unit: inspection.value?.entryUnit || "", inspectionItem: "",
    result: "PENDING", inspectedAt: localDateTimeValue(), inspectorName: "", notes: ""
  });
  sampleDialog.visible = true;
}

async function submitSample() {
  if (!sampleDialog.form.sampleQuantity || Number(sampleDialog.form.sampleQuantity) <= 0) {
    ElMessage.error("请填写大于 0 的样本数量");
    return;
  }
  saving.value = true;
  try {
    await request(`/inspections/${inspection.value!.id}/samples`, {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        sampleCode: sampleDialog.form.sampleCode || null,
        sampleQuantity: sampleDialog.form.sampleQuantity,
        unit: sampleDialog.form.unit,
        inspectionItem: sampleDialog.form.inspectionItem || null,
        result: sampleDialog.form.result,
        inspectedAt: new Date(sampleDialog.form.inspectedAt).toISOString(),
        inspectorName: sampleDialog.form.inspectorName || null,
        notes: sampleDialog.form.notes || null
      }
    });
    ElMessage.success("样本已记录");
    sampleDialog.visible = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "样本记录失败");
  } finally {
    saving.value = false;
  }
}

function openDefectDialog() {
  Object.assign(defectDialog.form, { sampleId: "", defectType: "", severity: "MINOR", defectQuantity: "", unit: inspection.value?.entryUnit || "", description: "" });
  defectDialog.visible = true;
}

async function submitDefect() {
  if (!defectDialog.form.defectType.trim()) {
    ElMessage.error("请填写缺陷类型");
    return;
  }
  saving.value = true;
  try {
    const hasQuantity = Number(defectDialog.form.defectQuantity) > 0;
    await request(`/inspections/${inspection.value!.id}/defects`, {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        sampleId: defectDialog.form.sampleId || null,
        defectType: defectDialog.form.defectType,
        severity: defectDialog.form.severity,
        defectQuantity: defectDialog.form.defectQuantity || "0",
        unit: hasQuantity ? defectDialog.form.unit : null,
        description: defectDialog.form.description || null
      }
    });
    ElMessage.success("缺陷已记录");
    defectDialog.visible = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "缺陷记录失败");
  } finally {
    saving.value = false;
  }
}

function openDisposition(disposition: "ACCEPTED" | "CONCESSION" | "REJECTED") {
  Object.assign(dispositionDialog.form, {
    disposition,
    acceptedQuantity: inspection.value?.deliveredQuantity ?? "",
    unit: inspection.value?.entryUnit ?? "",
    reason: ""
  });
  dispositionDialog.visible = true;
}

const dispositionConfirmText = computed(() => {
  if (dispositionDialog.form.disposition === "ACCEPTED") return "确认合格接收入库？批次与初始库存流水将立即生成。";
  if (dispositionDialog.form.disposition === "CONCESSION") return "确认让步接收？仅让步数量入库，差额不入库。";
  return "确认驳回本批来料？驳回后不会生成任何批次或库存流水。";
});

async function submitDisposition() {
  const value = inspection.value!;
  if (dispositionDialog.form.reason.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的处置说明");
    return;
  }
  if (dispositionDialog.form.disposition === "CONCESSION") {
    if (!dispositionDialog.form.acceptedQuantity || Number(dispositionDialog.form.acceptedQuantity) <= 0) {
      ElMessage.error("让步接收必须填写大于 0 的入库数量");
      return;
    }
  }
  try {
    await ElMessageBox.confirm(dispositionConfirmText.value, "处置确认", { type: "warning" });
  } catch {
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { disposition: { batchId: string | null; disposition: string } } }>(
      `/inspections/${value.id}/disposition`,
      {
        method: "POST",
        headers: { "Idempotency-Key": createIdempotencyKey() },
        body: {
          disposition: dispositionDialog.form.disposition,
          acceptedQuantity: dispositionDialog.form.disposition === "CONCESSION" ? dispositionDialog.form.acceptedQuantity : null,
          unit: dispositionDialog.form.disposition === "CONCESSION" ? dispositionDialog.form.unit : null,
          reason: dispositionDialog.form.reason,
          version: value.version
        }
      }
    );
    const outcome = response.data.disposition.disposition;
    if (outcome === "REJECTED") ElMessage.success("已驳回，未产生批次");
    else ElMessage.success(outcome === "CONCESSION" ? "让步接收完成，批次已按让步数量入库" : "合格接收完成，批次已入库");
    dispositionDialog.visible = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "处置失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="inspection">
      <header class="page-header">
        <div>
          <h1>{{ inspection.materialName }}</h1>
          <p>{{ inspection.inspectionCode || "无检验单号" }} · {{ inspection.sourceName || inspection.sourceNote || "来源不明" }}</p>
        </div>
        <div>
          <el-button @click="router.push('/inspections')">返回列表</el-button>
          <el-button v-if="isPending" @click="openSampleDialog">登记样本</el-button>
          <el-button v-if="isPending" @click="openDefectDialog">登记缺陷</el-button>
        </div>
      </header>

      <section class="stat-grid">
        <article class="stat-card"><small>到货数量</small><strong>{{ inspection.deliveredQuantity }} {{ inspection.stockUnit }}</strong></article>
        <article class="stat-card"><small>样本 / 缺陷</small><strong>{{ inspection.samples.length }} / {{ inspection.defects.length }}</strong></article>
        <article class="stat-card"><small>缺陷数量</small><strong>{{ inspection.defectQuantity || "0" }} {{ inspection.stockUnit }}</strong></article>
        <article class="stat-card">
          <small>检验状态</small>
          <strong>
            <el-tag :type="inspection.status === 'PENDING' ? 'warning' : inspection.status === 'REJECTED' ? 'danger' : inspection.status === 'CONCESSION' ? 'primary' : 'success'">
              {{ inspectionStatusLabels[inspection.status] }}
            </el-tag>
          </strong>
        </article>
      </section>

      <section class="panel" style="margin-top:16px">
        <h2>来料信息</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="材料"><router-link :to="`/materials/${inspection.materialId}`">{{ inspection.materialName }}</router-link></el-descriptions-item>
          <el-descriptions-item label="到货日期">{{ inspection.receivedAt }}</el-descriptions-item>
          <el-descriptions-item label="有效期">{{ inspection.expiryAt || "无" }}</el-descriptions-item>
          <el-descriptions-item label="到货数量">{{ inspection.deliveredQuantity }} {{ inspection.stockUnit }}（输入单位 {{ inspection.entryUnit }}）</el-descriptions-item>
          <el-descriptions-item label="拟用批次号">{{ inspection.batchCode || "无" }}</el-descriptions-item>
          <el-descriptions-item label="预定位置">{{ inspection.locationName || "未指定" }}</el-descriptions-item>
          <el-descriptions-item label="成本">{{ inspection.totalCost ? `${inspection.totalCost} ${inspection.currency || ""}` : "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="处置时间">{{ inspection.dispositionedAt ? new Date(inspection.dispositionedAt).toLocaleString() : "未处置" }}</el-descriptions-item>
          <el-descriptions-item label="入库批次">
            <router-link v-if="inspection.batchId" :to="`/batches/${inspection.batchId}`">查看批次</router-link>
            <span v-else-if="inspection.status === 'REJECTED'" class="rejected-text">驳回，无批次</span>
            <span v-else>待处置</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ inspection.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <el-alert
        v-if="isPending"
        title="处置是终态操作，仅可执行一次。并发提交时只有一个处置生效。"
        type="warning"
        :closable="false"
        style="margin-top:16px"
      />

      <section v-if="inspection.disposition" class="panel" style="margin-top:16px">
        <h2>处置结果</h2>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="处置方式">{{ inspectionStatusLabels[inspection.disposition.disposition] }}</el-descriptions-item>
          <el-descriptions-item v-if="inspection.disposition.acceptedQuantity" label="入库数量">
            {{ inspection.disposition.acceptedQuantity }} {{ inspection.disposition.stockUnit }}
          </el-descriptions-item>
          <el-descriptions-item label="处置说明" :span="2">{{ inspection.disposition.reason }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section v-if="isPending" class="panel disposition-panel">
        <h2>质检处置</h2>
        <p class="muted">完成样本与缺陷登记后选择处置结果。处置一经确认即锁定。</p>
        <div class="disposition-actions">
          <el-button type="success" size="large" :loading="saving" @click="openDisposition('ACCEPTED')">合格接收（全部入库）</el-button>
          <el-button type="primary" size="large" :loading="saving" @click="openDisposition('CONCESSION')">让步接收（部分入库）</el-button>
          <el-button type="danger" size="large" plain :loading="saving" @click="openDisposition('REJECTED')">驳回（不产生批次）</el-button>
        </div>
      </section>

      <AttachmentPanel owner-type="INSPECTION" :owner-id="inspection.id" :attachments="inspection.attachments" @changed="load" />

      <div class="two-column">
        <section class="panel">
          <h2>检验样本</h2>
          <el-table :data="inspection.samples" size="small">
            <el-table-column label="样本号" prop="sampleCode" width="100" />
            <el-table-column label="数量" width="110"><template #default="{ row }">{{ row.sampleQuantity }} {{ row.stockUnit }}</template></el-table-column>
            <el-table-column label="检验项" prop="inspectionItem" min-width="120" />
            <el-table-column label="结果" width="90">
              <template #default="{ row }"><el-tag size="small" :type="(sampleTagType[row.result] as any) ?? 'info'">{{ sampleResultLabels[row.result] }}</el-tag></template>
            </el-table-column>
            <el-table-column label="检验人" prop="inspectorName" width="90" />
          </el-table>
          <el-empty v-if="inspection.samples.length === 0" description="还没有样本记录" :image-size="60" />
        </section>
        <section class="panel">
          <h2>缺陷记录</h2>
          <el-table :data="inspection.defects" size="small">
            <el-table-column label="类型" prop="defectType" width="100" />
            <el-table-column label="严重度" width="80">
              <template #default="{ row }"><el-tag size="small" :type="(severityTagType[row.severity] as any) ?? 'info'">{{ defectSeverityLabels[row.severity] }}</el-tag></template>
            </el-table-column>
            <el-table-column label="数量" width="110"><template #default="{ row }">{{ row.defectQuantity === "0" || !row.stockUnit ? "—" : `${row.defectQuantity} ${row.stockUnit}` }}</template></el-table-column>
            <el-table-column label="描述" prop="description" min-width="140" />
          </el-table>
          <el-empty v-if="inspection.defects.length === 0" description="还没有缺陷记录" :image-size="60" />
        </section>
      </div>
    </template>

    <el-dialog v-model="sampleDialog.visible" title="登记检验样本" width="560px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="样本号"><el-input v-model="sampleDialog.form.sampleCode" maxlength="64" /></el-form-item>
          <el-form-item label="抽样数量" required><el-input v-model="sampleDialog.form.sampleQuantity" /></el-form-item>
          <el-form-item label="单位"><el-select v-model="sampleDialog.form.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
          <el-form-item label="判定结果">
            <el-select v-model="sampleDialog.form.result" style="width:100%">
              <el-option value="PENDING" label="待判定" /><el-option value="PASS" label="合格" /><el-option value="FAIL" label="不合格" />
            </el-select>
          </el-form-item>
          <el-form-item label="检验项"><el-input v-model="sampleDialog.form.inspectionItem" maxlength="160" placeholder="如：含水率、色差、尺寸" /></el-form-item>
          <el-form-item label="检验人"><el-input v-model="sampleDialog.form.inspectorName" maxlength="80" /></el-form-item>
          <el-form-item label="抽样时间"><el-date-picker v-model="sampleDialog.form.inspectedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" /></el-form-item>
          <el-form-item label="备注" class="full"><el-input v-model="sampleDialog.form.notes" type="textarea" :rows="2" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="sampleDialog.visible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitSample">保存样本</el-button></template>
    </el-dialog>

    <el-dialog v-model="defectDialog.visible" title="登记缺陷" width="560px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="关联样本（可选）">
            <el-select v-model="defectDialog.form.sampleId" clearable filterable style="width:100%">
              <el-option v-for="sample in inspection?.samples ?? []" :key="sample.id" :value="sample.id" :label="sample.sampleCode || sample.inspectionItem || sample.id.slice(0, 8)" />
            </el-select>
          </el-form-item>
          <el-form-item label="缺陷类型" required><el-input v-model="defectDialog.form.defectType" maxlength="80" placeholder="如：受潮、色差、破损" /></el-form-item>
          <el-form-item label="严重程度">
            <el-select v-model="defectDialog.form.severity" style="width:100%">
              <el-option value="MINOR" label="轻微" /><el-option value="MAJOR" label="主要" /><el-option value="CRITICAL" label="严重" />
            </el-select>
          </el-form-item>
          <el-form-item label="缺陷数量（可留空为 0）"><el-input v-model="defectDialog.form.defectQuantity" placeholder="0" /></el-form-item>
          <el-form-item label="单位"><el-select v-model="defectDialog.form.unit" clearable style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
          <el-form-item label="描述" class="full"><el-input v-model="defectDialog.form.description" type="textarea" :rows="2" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="defectDialog.visible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitDefect">保存缺陷</el-button></template>
    </el-dialog>

    <el-dialog v-model="dispositionDialog.visible" :title="`处置确认 · ${inspectionStatusLabels[dispositionDialog.form.disposition]}`" width="520px">
      <el-alert :title="dispositionConfirmText" :type="dispositionDialog.form.disposition === 'REJECTED' ? 'error' : dispositionDialog.form.disposition === 'CONCESSION' ? 'warning' : 'success'" show-icon :closable="false" style="margin-bottom:16px" />
      <el-form label-position="top">
        <el-form-item v-if="dispositionDialog.form.disposition === 'CONCESSION'" label="让步接收入库数量（小于到货数量）" required>
          <div style="display:flex;gap:10px;width:100%">
            <el-input v-model="dispositionDialog.form.acceptedQuantity" style="flex:1" />
            <el-select v-model="dispositionDialog.form.unit" style="width:110px"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select>
          </div>
          <div class="muted">到货 {{ inspection?.deliveredQuantity }} {{ inspection?.stockUnit }}，差额不入库</div>
        </el-form-item>
        <el-form-item label="处置说明" required><el-input v-model="dispositionDialog.form.reason" type="textarea" :rows="3" :placeholder="dispositionDialog.form.disposition === 'REJECTED' ? '驳回原因，如：严重受潮霉变' : '如：抽检合格 / 轻微色差让步放行'" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dispositionDialog.visible = false">取消</el-button><el-button :type="dispositionDialog.form.disposition === 'REJECTED' ? 'danger' : 'primary'" :loading="saving" @click="submitDisposition">确认处置（仅一次）</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.disposition-panel {
  border-left: 4px solid var(--el-color-warning);
}
.disposition-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.rejected-text {
  color: var(--el-color-danger);
}
</style>

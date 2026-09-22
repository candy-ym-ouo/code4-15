<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import {
  defectSeverityLabels,
  inspectionSampleResultLabels,
  inspectionStatusLabels,
  type Inspection,
  type InspectionDefect,
  type InspectionSample
} from "@/types";
import { localDateTimeValue } from "@/lib/dates";
import { createIdempotencyKey } from "@/lib/idempotency";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const inspection = ref<Inspection | null>(null);

const sampleVisible = ref(false);
const defectVisible = ref(false);
const dispositionVisible = ref(false);

const sampleForm = reactive({
  sampleNo: "",
  sampleQuantity: "",
  unit: "",
  result: "PASS",
  inspectedAt: localDateTimeValue(),
  notes: ""
});
const defectForm = reactive({
  defectType: "",
  severity: "MINOR",
  defectCount: 1,
  affectedQuantity: "",
  unit: "",
  description: ""
});
const dispositionForm = reactive({
  disposition: "ACCEPT",
  note: "",
  concessionReason: "",
  concessionApprover: ""
});

const open = computed(() => inspection.value !== null && ["PENDING", "INSPECTING"].includes(inspection.value.status));
const failedSampleCount = computed(() => inspection.value?.samples?.filter((item) => item.result === "FAIL").length ?? 0);
const defectCount = computed(() => inspection.value?.defects?.length ?? 0);
const criticalCount = computed(() => inspection.value?.defects?.filter((item) => item.severity === "CRITICAL").length ?? 0);

function tagType(status: string): "success" | "warning" | "danger" | "info" | "primary" {
  if (status === "ACCEPTED") return "success";
  if (status === "CONCESSION_ACCEPTED") return "warning";
  if (status === "REJECTED") return "danger";
  if (status === "INSPECTING") return "primary";
  return "info";
}

function sampleTagType(result: string): "success" | "danger" | "info" {
  if (result === "PASS") return "success";
  if (result === "FAIL") return "danger";
  return "info";
}

function severityTagType(severity: string): "info" | "warning" | "danger" {
  if (severity === "CRITICAL") return "danger";
  if (severity === "MAJOR") return "warning";
  return "info";
}

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: Inspection }>(`/inspections/${route.params.id}`);
    inspection.value = response.data;
    sampleForm.unit = response.data.entryUnit;
    defectForm.unit = response.data.entryUnit;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "质检单加载失败");
  } finally {
    loading.value = false;
  }
}

function openSampleDialog() {
  Object.assign(sampleForm, {
    sampleNo: `S${(inspection.value?.samples?.length ?? 0) + 1}`,
    sampleQuantity: "",
    unit: inspection.value?.entryUnit ?? "",
    result: "PASS",
    inspectedAt: localDateTimeValue(),
    notes: ""
  });
  sampleVisible.value = true;
}

async function submitSample() {
  if (!sampleForm.sampleNo.trim()) {
    ElMessage.error("请填写样本编号");
    return;
  }
  saving.value = true;
  try {
    await request<{ data: InspectionSample }>(`/inspections/${inspection.value!.id}/samples`, {
      method: "POST",
      body: {
        sampleNo: sampleForm.sampleNo,
        sampleQuantity: sampleForm.sampleQuantity || null,
        unit: sampleForm.sampleQuantity ? sampleForm.unit : null,
        result: sampleForm.result,
        inspectedAt: new Date(sampleForm.inspectedAt).toISOString(),
        notes: sampleForm.notes || null
      }
    });
    ElMessage.success("检验样本已登记");
    sampleVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "样本登记失败");
  } finally {
    saving.value = false;
  }
}

function openDefectDialog() {
  Object.assign(defectForm, {
    defectType: "",
    severity: "MINOR",
    defectCount: 1,
    affectedQuantity: "",
    unit: inspection.value?.entryUnit ?? "",
    description: ""
  });
  defectVisible.value = true;
}

async function submitDefect() {
  if (!defectForm.defectType.trim()) {
    ElMessage.error("请填写缺陷类型");
    return;
  }
  saving.value = true;
  try {
    await request<{ data: InspectionDefect }>(`/inspections/${inspection.value!.id}/defects`, {
      method: "POST",
      body: {
        defectType: defectForm.defectType,
        severity: defectForm.severity,
        defectCount: defectForm.defectCount,
        affectedQuantity: defectForm.affectedQuantity || null,
        unit: defectForm.affectedQuantity ? defectForm.unit : null,
        description: defectForm.description || null
      }
    });
    ElMessage.success("缺陷已登记");
    defectVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "缺陷登记失败");
  } finally {
    saving.value = false;
  }
}

function openDispositionDialog(disposition: "ACCEPT" | "CONCESSION" | "REJECT") {
  Object.assign(dispositionForm, { disposition, note: "", concessionReason: "", concessionApprover: "" });
  dispositionVisible.value = true;
}

async function submitDisposition() {
  if (!inspection.value) return;
  if (dispositionForm.disposition === "CONCESSION" && (!dispositionForm.concessionReason.trim() || !dispositionForm.concessionApprover.trim())) {
    ElMessage.error("让步接收必须填写让步原因和批准人");
    return;
  }
  if (dispositionForm.disposition === "REJECT" && !dispositionForm.note.trim()) {
    ElMessage.error("驳回必须填写处置说明");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { inspection: Inspection; batch: { id: string } | null } }>(
      `/inspections/${inspection.value.id}/disposition`,
      {
        method: "POST",
        headers: { "Idempotency-Key": createIdempotencyKey() },
        body: {
          disposition: dispositionForm.disposition,
          note: dispositionForm.note || null,
          concessionReason: dispositionForm.concessionReason || null,
          concessionApprover: dispositionForm.concessionApprover || null
        }
      }
    );
    dispositionVisible.value = false;
    if (response.data.batch) {
      ElMessage.success(dispositionForm.disposition === "CONCESSION" ? "让步接收完成，批次已入库" : "质检合格，批次已入库");
      await router.push(`/batches/${response.data.batch.id}`);
    } else {
      ElMessage.success("已驳回，该来料不产生批次");
      await load();
    }
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
          <h1>{{ inspection.inspectionNo }} <el-tag :type="tagType(inspection.status)" size="small">{{ inspectionStatusLabels[inspection.status] || inspection.status }}</el-tag></h1>
          <p>{{ inspection.materialName }} · {{ inspection.batchCode || "无批号" }} · {{ inspection.sourceName || inspection.sourceNote || "来源不明" }}</p>
        </div>
        <div v-if="open">
          <el-button @click="openSampleDialog">登记样本</el-button>
          <el-button @click="openDefectDialog">登记缺陷</el-button>
          <el-button type="danger" plain @click="openDispositionDialog('REJECT')">驳回</el-button>
          <el-button type="warning" :disabled="criticalCount > 0" @click="openDispositionDialog('CONCESSION')">让步接收</el-button>
          <el-button type="primary" :disabled="failedSampleCount > 0 || defectCount > 0" @click="openDispositionDialog('ACCEPT')">合格接收入库</el-button>
        </div>
      </header>

      <el-alert
        v-if="open && (failedSampleCount > 0 || defectCount > 0)"
        title="存在不合格样本或缺陷：不能合格接收。轻微/主要缺陷可申请让步接收（需原因与批准人），严重缺陷只能驳回。"
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom:16px"
      />
      <el-alert
        v-if="inspection.status === 'CONCESSION_ACCEPTED'"
        :title="`让步接收入库：${inspection.concessionReason || ''}（批准人：${inspection.concessionApprover || ''}）`"
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom:16px"
      />
      <el-alert
        v-if="inspection.status === 'REJECTED'"
        :title="`已驳回，未产生批次。说明：${inspection.dispositionNote || '无'}`"
        type="error"
        show-icon
        :closable="false"
        style="margin-bottom:16px"
      />

      <section class="stat-grid">
        <article class="stat-card"><small>到货数量</small><strong>{{ inspection.deliveredQuantity }} {{ inspection.entryUnit }}</strong></article>
        <article class="stat-card"><small>检验样本</small><strong>{{ inspection.samples?.length ?? 0 }}（不合格 {{ failedSampleCount }}）</strong></article>
        <article class="stat-card"><small>缺陷记录</small><strong>{{ defectCount }}（严重 {{ criticalCount }}）</strong></article>
        <article class="stat-card">
          <small>入库批次</small>
          <strong><router-link v-if="inspection.batchId" :to="`/batches/${inspection.batchId}`">查看批次</router-link><span v-else-if="inspection.status === 'REJECTED'">无（驳回）</span><span v-else>未处置</span></strong>
        </article>
      </section>

      <section class="panel" style="margin-top:16px">
        <h2>来料信息</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="材料"><router-link :to="`/materials/${inspection.materialId}`">{{ inspection.materialName }}</router-link></el-descriptions-item>
          <el-descriptions-item label="供应批号">{{ inspection.batchCode || "无" }}</el-descriptions-item>
          <el-descriptions-item label="到货日期">{{ inspection.receivedAt }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ inspection.sourceName || inspection.sourceNote || "未指定" }}</el-descriptions-item>
          <el-descriptions-item label="拟存放位置">{{ inspection.locationName || "未指定" }}</el-descriptions-item>
          <el-descriptions-item label="有效期">{{ inspection.expiryAt || "无" }}</el-descriptions-item>
          <el-descriptions-item label="成本">{{ inspection.totalCost ? `${inspection.totalCost} ${inspection.currency || ""}` : "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ new Date(inspection.createdAt).toLocaleString() }}</el-descriptions-item>
          <el-descriptions-item label="处置时间">{{ inspection.disposedAt ? new Date(inspection.disposedAt).toLocaleString() : "未处置" }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ inspection.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <div class="two-column">
        <section class="panel">
          <h2>检验样本</h2>
          <el-table :data="inspection.samples ?? []" size="small">
            <el-table-column label="样本号" prop="sampleNo" width="90" />
            <el-table-column label="数量" width="120"><template #default="{ row }">{{ row.sampleQuantity ? `${row.sampleQuantity} ${row.stockUnit || ""}` : "—" }}</template></el-table-column>
            <el-table-column label="结果" width="90"><template #default="{ row }"><el-tag :type="sampleTagType(row.result)" size="small">{{ inspectionSampleResultLabels[row.result] || row.result }}</el-tag></template></el-table-column>
            <el-table-column label="检验时间" width="165"><template #default="{ row }">{{ new Date(row.inspectedAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="备注" prop="notes" min-width="120" />
          </el-table>
          <el-empty v-if="(inspection.samples?.length ?? 0) === 0" description="还没有检验样本" />
        </section>
        <section class="panel">
          <h2>缺陷记录</h2>
          <el-table :data="inspection.defects ?? []" size="small">
            <el-table-column label="缺陷类型" prop="defectType" width="120" />
            <el-table-column label="严重度" width="80"><template #default="{ row }"><el-tag :type="severityTagType(row.severity)" size="small">{{ defectSeverityLabels[row.severity] || row.severity }}</el-tag></template></el-table-column>
            <el-table-column label="数量" width="80"><template #default="{ row }">{{ row.defectCount }}</template></el-table-column>
            <el-table-column label="影响量" width="120"><template #default="{ row }">{{ row.affectedQuantity ? `${row.affectedQuantity} ${row.stockUnit || ""}` : "—" }}</template></el-table-column>
            <el-table-column label="描述" prop="description" min-width="120" />
          </el-table>
          <el-empty v-if="(inspection.defects?.length ?? 0) === 0" description="没有缺陷记录" />
        </section>
      </div>

      <el-dialog v-model="sampleVisible" title="登记检验样本" width="520px">
        <el-form label-position="top">
          <el-form-item label="样本编号" required><el-input v-model="sampleForm.sampleNo" maxlength="40" /></el-form-item>
          <el-form-item label="样本数量（可选）"><el-input v-model="sampleForm.sampleQuantity" placeholder="抽样数量，留空表示仅计数" /></el-form-item>
          <el-form-item label="单位"><el-select v-model="sampleForm.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
          <el-form-item label="检验结果" required>
            <el-radio-group v-model="sampleForm.result">
              <el-radio value="PASS">合格</el-radio>
              <el-radio value="FAIL">不合格</el-radio>
              <el-radio value="PENDING">待判定</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="检验时间"><el-date-picker v-model="sampleForm.inspectedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" /></el-form-item>
          <el-form-item label="备注"><el-input v-model="sampleForm.notes" type="textarea" :rows="2" /></el-form-item>
        </el-form>
        <template #footer><el-button @click="sampleVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitSample">保存样本</el-button></template>
      </el-dialog>

      <el-dialog v-model="defectVisible" title="登记缺陷" width="520px">
        <el-form label-position="top">
          <el-form-item label="缺陷类型" required><el-input v-model="defectForm.defectType" maxlength="80" placeholder="例如：色差、破损、杂质、尺寸偏差" /></el-form-item>
          <el-form-item label="严重度" required>
            <el-radio-group v-model="defectForm.severity">
              <el-radio value="MINOR">轻微</el-radio>
              <el-radio value="MAJOR">主要</el-radio>
              <el-radio value="CRITICAL">严重</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="缺陷数量"><el-input-number v-model="defectForm.defectCount" :min="1" :max="1000000" /></el-form-item>
          <el-form-item label="影响数量（可选）"><el-input v-model="defectForm.affectedQuantity" placeholder="受缺陷影响的材料数量" /></el-form-item>
          <el-form-item label="单位"><el-select v-model="defectForm.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
          <el-form-item label="描述"><el-input v-model="defectForm.description" type="textarea" :rows="3" /></el-form-item>
        </el-form>
        <template #footer><el-button @click="defectVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitDefect">保存缺陷</el-button></template>
      </el-dialog>

      <el-dialog v-model="dispositionVisible" :title="dispositionForm.disposition === 'REJECT' ? '驳回来料' : dispositionForm.disposition === 'CONCESSION' ? '让步接收入库' : '合格接收入库'" width="560px">
        <el-alert
          v-if="dispositionForm.disposition === 'ACCEPT'"
          title="合格接收将按到货数量创建批次并生成 OPENING 库存流水。处置只能执行一次。"
          type="success"
          show-icon
          :closable="false"
          style="margin-bottom:16px"
        />
        <el-alert
          v-if="dispositionForm.disposition === 'CONCESSION'"
          title="让步接收同样按到货数量入库，但必须记录让步原因和批准人；存在严重缺陷时禁止让步接收。"
          type="warning"
          show-icon
          :closable="false"
          style="margin-bottom:16px"
        />
        <el-alert
          v-if="dispositionForm.disposition === 'REJECT'"
          title="驳回后该来料不会产生任何批次或库存流水，质检单永久保留为驳回记录。"
          type="error"
          show-icon
          :closable="false"
          style="margin-bottom:16px"
        />
        <el-form label-position="top">
          <template v-if="dispositionForm.disposition === 'CONCESSION'">
            <el-form-item label="让步原因" required><el-input v-model="dispositionForm.concessionReason" type="textarea" :rows="3" maxlength="2000" placeholder="例如：不影响使用的轻微色差，经评估可降级使用" /></el-form-item>
            <el-form-item label="批准人" required><el-input v-model="dispositionForm.concessionApprover" maxlength="80" /></el-form-item>
          </template>
          <el-form-item :label="dispositionForm.disposition === 'REJECT' ? '驳回说明（必填）' : '处置说明（可选）'">
            <el-input v-model="dispositionForm.note" type="textarea" :rows="3" maxlength="5000" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dispositionVisible = false">取消</el-button>
          <el-button :type="dispositionForm.disposition === 'REJECT' ? 'danger' : dispositionForm.disposition === 'CONCESSION' ? 'warning' : 'primary'" :loading="saving" @click="submitDisposition">
            确认{{ dispositionForm.disposition === "REJECT" ? "驳回" : dispositionForm.disposition === "CONCESSION" ? "让步接收" : "合格接收" }}
          </el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

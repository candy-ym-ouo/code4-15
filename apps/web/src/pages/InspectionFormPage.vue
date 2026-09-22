<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { Location, Material, Source } from "@/types";
import { localDateValue } from "@/lib/dates";
import { createIdempotencyKey } from "@/lib/idempotency";

const route = useRoute();
const router = useRouter();
const saving = ref(false);
const materials = ref<Material[]>([]);
const sources = ref<Source[]>([]);
const locations = ref<Location[]>([]);
const selectedMaterial = computed(() => materials.value.find((item) => item.id === form.materialId));
const form = reactive({
  inspectionNo: `IQC-${localDateValue().replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
  materialId: String(route.query.materialId || ""),
  batchCode: "",
  sourceId: "",
  sourceNote: "",
  locationId: "",
  receivedAt: localDateValue(),
  expiryAt: "",
  deliveredQuantity: "",
  entryUnit: "g",
  totalCost: "",
  currency: "CNY",
  initialColorName: "",
  initialColorHex: "",
  notes: ""
});

watch(selectedMaterial, (material) => {
  if (!material) return;
  form.entryUnit = material.stockUnit;
  if (!form.initialColorName) form.initialColorName = material.defaultColorName || "";
  if (!form.initialColorHex) form.initialColorHex = material.defaultColorHex || "";
});

async function loadOptions() {
  try {
    const [materialResponse, sourceResponse, locationResponse] = await Promise.all([
      request<{ data: Material[] }>("/materials?pageSize=100"),
      request<{ data: Source[] }>("/sources?pageSize=100"),
      request<{ data: Location[] }>("/locations")
    ]);
    materials.value = materialResponse.data;
    sources.value = sourceResponse.data;
    locations.value = locationResponse.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "选项加载失败");
  }
}

async function submit() {
  if (!form.inspectionNo.trim()) {
    ElMessage.error("请填写质检单号");
    return;
  }
  if (!form.materialId || !form.deliveredQuantity || Number(form.deliveredQuantity) <= 0) {
    ElMessage.error("请选择材料并填写大于 0 的到货数量");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { id: string } }>("/inspections", {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        ...form,
        batchCode: form.batchCode || null,
        sourceId: form.sourceId || null,
        sourceNote: form.sourceNote || null,
        locationId: form.locationId || null,
        expiryAt: form.expiryAt || null,
        totalCost: form.totalCost || null,
        initialColorName: form.initialColorName || null,
        initialColorHex: form.initialColorHex || null,
        notes: form.notes || null
      }
    });
    ElMessage.success("来料质检单已创建，请登记样本与缺陷后处置");
    await router.push(`/inspections/${response.data.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "创建质检单失败");
  } finally {
    saving.value = false;
  }
}

onMounted(loadOptions);
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>来料报检</h1><p>先建立质检单并登记样本、缺陷；质检通过或让步接收后系统才会创建批次入库，驳回不产生批次。</p></div>
      <el-button @click="router.back()">返回</el-button>
    </header>
    <section class="panel">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="质检单号" required><el-input v-model="form.inspectionNo" maxlength="40" placeholder="例如 IQC-20260922-01" /></el-form-item>
          <el-form-item label="材料" required>
            <el-select v-model="form.materialId" filterable style="width:100%" placeholder="选择材料"><el-option v-for="material in materials" :key="material.id" :value="material.id" :label="`${material.name}（${material.stockUnit}）`" /></el-select>
          </el-form-item>
          <el-form-item label="供应批号"><el-input v-model="form.batchCode" maxlength="64" placeholder="供应商提供的批次号（可选）" /></el-form-item>
          <el-form-item label="来源">
            <el-select v-model="form.sourceId" clearable filterable style="width:100%"><el-option v-for="source in sources" :key="source.id" :value="source.id" :label="source.name" /></el-select>
          </el-form-item>
          <el-form-item label="来源补充"><el-input v-model="form.sourceNote" maxlength="200" placeholder="来源不明或临时来源说明" /></el-form-item>
          <el-form-item label="拟存放位置">
            <el-select v-model="form.locationId" clearable filterable style="width:100%"><el-option v-for="location in locations" :key="location.id" :value="location.id" :label="location.name" /></el-select>
          </el-form-item>
          <el-form-item label="到货日期" required><el-date-picker v-model="form.receivedAt" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
          <el-form-item label="有效期"><el-date-picker v-model="form.expiryAt" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" /></el-form-item>
          <el-form-item label="到货数量" required><el-input v-model="form.deliveredQuantity" placeholder="例如 1.5" /></el-form-item>
          <el-form-item label="输入单位" required><el-select v-model="form.entryUnit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select><div class="muted" v-if="selectedMaterial">入库时换算为 {{ selectedMaterial.stockUnit }} 入账</div></el-form-item>
          <el-form-item label="总成本"><el-input v-model="form.totalCost" placeholder="可选十进制金额" /></el-form-item>
          <el-form-item label="币种"><el-input v-model="form.currency" maxlength="3" /></el-form-item>
          <el-form-item label="来料颜色名称"><el-input v-model="form.initialColorName" maxlength="80" /></el-form-item>
          <el-form-item label="来料颜色值"><div style="display:flex;gap:10px;width:100%"><el-color-picker v-model="form.initialColorHex" /><el-input v-model="form.initialColorHex" placeholder="#RRGGBB" /></div></el-form-item>
          <el-form-item label="备注" class="full"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
        </div>
        <el-button type="primary" size="large" :loading="saving" @click="submit">创建质检单</el-button>
      </el-form>
    </section>
  </div>
</template>

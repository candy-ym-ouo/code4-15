<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { inspectionStatusLabels, type ApiMeta, type Inspection } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<Inspection[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", status: "PENDING", from: "", to: "" });

const statusTagType: Record<string, string> = {
  PENDING: "warning",
  ACCEPTED: "success",
  CONCESSION: "primary",
  REJECTED: "danger"
};

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Inspection[]; meta: ApiMeta }>(`/inspections?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "检验单加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { q: "", status: "", from: "", to: "" });
  void load(1);
}

onMounted(() => {
  Object.assign(filters, {
    q: String(route.query.q || ""),
    status: String(route.query.status ?? "PENDING"),
    from: String(route.query.from || ""),
    to: String(route.query.to || "")
  });
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>来料质检</h1>
        <p>到货先登记待检，记录样本与缺陷；只有合格或让步接收后才会生成入库批次，驳回不产生批次。</p>
      </div>
      <el-button type="primary" @click="router.push('/inspections/new')">来料登记</el-button>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="关键词"><el-input v-model="filters.q" clearable placeholder="检验单号、材料、批次号、来源" @keyup.enter="load(1)" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable style="width: 140px">
            <el-option value="PENDING" label="待检验" />
            <el-option value="ACCEPTED" label="合格接收" />
            <el-option value="CONCESSION" label="让步接收" />
            <el-option value="REJECTED" label="驳回" />
          </el-select>
        </el-form-item>
        <el-form-item label="到货起"><el-date-picker v-model="filters.from" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="到货止"><el-date-picker v-model="filters.to" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="材料/检验单" min-width="220">
          <template #default="{ row }">
            <router-link :to="`/inspections/${row.id}`"><strong>{{ row.materialName }}</strong></router-link>
            <div class="muted">{{ row.inspectionCode || "无检验单号" }} · {{ row.sourceName || row.sourceNote || "来源不明" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="到货数量" width="170">
          <template #default="{ row }"><span class="amount">{{ row.deliveredQuantity }} {{ row.stockUnit }}</span><div class="muted">输入：{{ row.entryUnit }}</div></template>
        </el-table-column>
        <el-table-column label="样本/缺陷" width="120">
          <template #default="{ row }">
            <span>{{ row.sampleCount ?? 0 }} 个样本</span>
            <div class="muted" :class="{ 'defect-warning': (row.defectCount ?? 0) > 0 }">{{ row.defectCount ?? 0 }} 条缺陷<template v-if="row.defectQuantity && Number(row.defectQuantity) > 0"> · {{ row.defectQuantity }} {{ row.stockUnit }}</template></div>
          </template>
        </el-table-column>
        <el-table-column label="到货日期" width="130" prop="receivedAt" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="(statusTagType[row.status] as any) ?? 'info'">{{ inspectionStatusLabels[row.status] || row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="入库批次" min-width="140">
          <template #default="{ row }">
            <router-link v-if="row.batchId" :to="`/batches/${row.batchId}`">查看批次</router-link>
            <span v-else-if="row.status === 'REJECTED'" class="muted">已驳回，无批次</span>
            <span v-else class="muted">待处置</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }"><el-button link type="primary" @click="router.push(`/inspections/${row.id}`)">{{ row.status === "PENDING" ? "检验处置" : "查看" }}</el-button></template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有符合条件的来料检验单" />
      <el-pagination v-if="meta.total > 0" style="margin-top:16px; justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>

<style scoped>
.defect-warning {
  color: var(--el-color-danger);
}
</style>

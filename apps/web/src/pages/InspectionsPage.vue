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
const filters = reactive({ q: "", status: "" });

function tagType(status: string): "success" | "warning" | "danger" | "info" | "primary" {
  if (status === "ACCEPTED") return "success";
  if (status === "CONCESSION_ACCEPTED") return "warning";
  if (status === "REJECTED") return "danger";
  if (status === "INSPECTING") return "primary";
  return "info";
}

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
    ElMessage.error(error instanceof ApiError ? error.message : "质检单加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { q: "", status: "" });
  void load(1);
}
onMounted(() => {
  Object.assign(filters, { q: String(route.query.q || ""), status: String(route.query.status || "") });
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>来料质检</h1><p>所有来料先报检；只有合格接收或让步接收才会产生批次，驳回的来料不会入库。</p></div>
      <el-button type="primary" @click="router.push('/inspections/new')">来料报检</el-button>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="关键词"><el-input v-model="filters.q" clearable placeholder="质检单号、批号、材料、来源" @keyup.enter="load(1)" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable style="width: 150px">
            <el-option value="PENDING" label="待检验" />
            <el-option value="INSPECTING" label="检验中" />
            <el-option value="ACCEPTED" label="合格接收" />
            <el-option value="CONCESSION_ACCEPTED" label="让步接收" />
            <el-option value="REJECTED" label="已驳回" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="质检单/材料" min-width="220">
          <template #default="{ row }"><router-link :to="`/inspections/${row.id}`"><strong>{{ row.inspectionNo }}</strong></router-link><div class="muted">{{ row.materialName }} · {{ row.batchCode || "无批号" }}</div></template>
        </el-table-column>
        <el-table-column label="来源" min-width="130"><template #default="{ row }">{{ row.sourceName || row.sourceNote || "来源不明" }}</template></el-table-column>
        <el-table-column label="到货数量" width="150"><template #default="{ row }"><span class="amount">{{ row.deliveredQuantity }} {{ row.entryUnit }}</span></template></el-table-column>
        <el-table-column label="到货日期" width="130"><template #default="{ row }">{{ row.receivedAt }}</template></el-table-column>
        <el-table-column label="处置结果" width="130">
          <template #default="{ row }">
            <el-tag :type="tagType(row.status)">{{ inspectionStatusLabels[row.status] || row.status }}</el-tag>
            <div class="muted" v-if="row.disposedAt">{{ new Date(row.disposedAt).toLocaleDateString() }}</div>
          </template>
        </el-table-column>
        <el-table-column label="入库批次" min-width="140">
          <template #default="{ row }">
            <router-link v-if="row.batchId" :to="`/batches/${row.batchId}`">查看批次</router-link>
            <span v-else-if="row.status === 'REJECTED'" class="muted">驳回，未入库</span>
            <span v-else class="muted">待处置</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="router.push(`/inspections/${row.id}`)">处置</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有符合条件的质检单" />
      <el-pagination v-if="meta.total > 0" style="margin-top:16px; justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>

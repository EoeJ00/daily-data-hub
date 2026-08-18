import { latestSuccessfulResultsByConfiguration } from "./spend-history.js";

const state = {
  scenarios: {
    "scenario-1": { sources: [], runs: [] },
    "scenario-2": { pairs: [], runs: [] }
  },
  connection: {},
  page: "overview",
  shooterDate: "",
  shooterDatePickerCleanup: null,
  logFilters: { scenario: "scenario-1", date: "", status: "all", type: "all" }
};
const content = document.querySelector("#pageContent");
const alertRegion = document.querySelector("#alertRegion");
const dateInput = document.querySelector("#businessDate");
const datePicker = document.querySelector("#businessDatePicker");
const dateTrigger = document.querySelector("#businessDateTrigger");
const dateValueLabel = document.querySelector("#businessDateValue");
const datePopover = document.querySelector("#businessDatePopover");
const calendarMonthLabel = document.querySelector("#calendarMonthLabel");
const calendarGrid = document.querySelector("#calendarGrid");
const pageTitle = document.querySelector("#pageTitle");
const previewButton = document.querySelector("#previewButton");
const runButton = document.querySelector("#runButton");
const rulesButton = document.querySelector("#rulesButton");
const safetyRulesDialog = document.querySelector("#safetyRulesDialog");
const safetyRulesClose = document.querySelector("#safetyRulesClose");
const runDialog = document.querySelector("#runDialog");
const runDialogText = document.querySelector("#runDialogText");
const pageAuxActions = document.querySelector("#pageAuxActions");
const runDetailDrawer = document.querySelector("#runDetailDrawer");
const runDetailDrawerClose = document.querySelector("#runDetailDrawerClose");
const runDetailDrawerKicker = document.querySelector("#runDetailDrawerKicker");
const runDetailDrawerTitle = document.querySelector("#runDetailDrawerTitle");
const runDetailDrawerMeta = document.querySelector("#runDetailDrawerMeta");
const runDetailDrawerBody = document.querySelector("#runDetailDrawerBody");
const collapseSidebar = document.querySelector("#collapseSidebar");
const topDateLabel = document.querySelector("#topDateLabel");
const topWorkspaceLabel = document.querySelector("#topWorkspaceLabel");
const sidebarScroll = document.querySelector(".sidebar-scroll");
const accordionStorageKey = "miulx.scenarioAccordion";

function scenarioData(scenario = "scenario-1") {
  return state.scenarios[scenario] || (scenario === "scenario-2" ? { pairs: [], runs: [] } : { sources: [], runs: [] });
}

function scenarioApi(scenario, path) {
  return `/api/scenarios/${scenario}${path}`;
}

function setScenarioAccordion(scenario, open) {
  const toggle = document.querySelector(`[data-scenario-toggle="${scenario}"]`);
  const panel = document.querySelector(`#${scenario}-panel`);
  if (!toggle || !panel) return;
  toggle.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", String(!open));
}

function readScenarioAccordion(scenario, fallback) {
  const value = localStorage.getItem(`${accordionStorageKey}.${scenario}`);
  return value === null ? fallback : value === "1";
}

function toggleScenarioAccordion(event) {
  const toggle = event.currentTarget;
  const scenario = toggle.dataset.scenarioToggle;
  const open = toggle.getAttribute("aria-expanded") !== "true";
  setScenarioAccordion(scenario, open);
  localStorage.setItem(`${accordionStorageKey}.${scenario}`, open ? "1" : "0");
}

dateInput.value = formatDate(new Date(Date.now() - 86_400_000));
topDateLabel.textContent = formatDateLabel(new Date());

if (localStorage.getItem("miulx.sidebarCollapsed") === "1") {
  document.body.classList.add("sidebar-collapsed");
  collapseSidebar.setAttribute("aria-expanded", "false");
  collapseSidebar.setAttribute("aria-label", "展开侧边栏");
}

function icon(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

const icons = {
  sheet: icon('<path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5M9 12h7M9 16h7M9 8h2"/>'),
  check: icon('<path d="m5 12 4 4L19 6"/>'),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  lock: icon('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  empty: icon('<path d="M4 6h16M7 3h10l1 3H6l1-3ZM6 6l1 15h10l1-15M10 10v7M14 10v7"/>')
};

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateValue(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function isSameDate(left, right) {
  return Boolean(left && right) && left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function formatPickerDate(value) {
  const date = parseDateValue(value);
  return date ? `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月${String(date.getDate()).padStart(2, "0")}日` : "选择日期";
}

function renderCalendarDays({ view, input, trigger, valueLabel, monthLabel, grid, ariaLabel }) {
  if (!grid || !monthLabel || !valueLabel || !trigger) return;
  const year = view.getFullYear();
  const month = view.getMonth();
  const selected = parseDateValue(input.value);
  const today = new Date();
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  monthLabel.textContent = `${year}年${String(month + 1).padStart(2, "0")}月`;
  grid.innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const value = formatDate(date);
    const classes = [
      "date-day",
      date.getMonth() !== month ? "is-outside" : "",
      isSameDate(date, selected) ? "is-selected" : "",
      isSameDate(date, today) ? "is-today" : ""
    ].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-calendar-date="${value}" aria-label="${value}"${isSameDate(date, selected) ? " aria-current=\"date\"" : ""}>${date.getDate()}</button>`;
  }).join("");
  valueLabel.textContent = formatPickerDate(input.value);
  trigger.setAttribute("aria-label", input.value ? `${ariaLabel} ${formatPickerDate(input.value)}` : `选择${ariaLabel}`);
}

function initCalendarPicker({ picker, input, trigger, valueLabel, popover, monthLabel, grid, ariaLabel = "业务日期", onValueChange = null }) {
  if (!picker || !input || !trigger || !valueLabel || !popover || !monthLabel || !grid) return () => {};
  let view = parseDateValue(input.value) || new Date();
  const render = () => renderCalendarDays({ view, input, trigger, valueLabel, monthLabel, grid, ariaLabel });
  const close = ({ restoreFocus = false } = {}) => {
    if (popover.hidden) return;
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    picker.classList.remove("is-open");
    if (restoreFocus) trigger.focus();
  };
  const open = () => {
    view = parseDateValue(input.value) || new Date();
    render();
    popover.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    picker.classList.add("is-open");
    popover.querySelector(".date-day.is-selected, .date-day")?.focus();
  };
  const setValue = (value) => {
    input.value = value;
    view = parseDateValue(value) || new Date();
    render();
    close({ restoreFocus: true });
    onValueChange?.(value);
  };
  const onTrigger = () => { if (popover.hidden) open(); else close(); };
  const onPopover = (event) => {
    const day = event.target.closest("[data-calendar-date]");
    if (day) {
      setValue(day.dataset.calendarDate);
      return;
    }
    const nav = event.target.closest("[data-calendar-nav]");
    if (nav) {
      view = new Date(view.getFullYear(), view.getMonth() + (nav.dataset.calendarNav === "next" ? 1 : -1), 1);
      render();
      popover.querySelector(`[data-calendar-nav="${nav.dataset.calendarNav}"]`)?.focus();
      return;
    }
    if (event.target.closest("[data-calendar-today]")) {
      setValue(formatDate(new Date()));
      return;
    }
    if (event.target.closest("[data-calendar-clear]")) setValue("");
  };
  const onOutside = (event) => { if (!picker.contains(event.target)) close(); };
  const onKeyDown = (event) => { if (event.key === "Escape" && !popover.hidden) close({ restoreFocus: true }); };
  const onInputChange = () => { render(); onValueChange?.(input.value); };
  input.hidden = true;
  trigger.addEventListener("click", onTrigger);
  popover.addEventListener("click", onPopover);
  document.addEventListener("click", onOutside);
  document.addEventListener("keydown", onKeyDown);
  input.addEventListener("change", onInputChange);
  render();
  return () => {
    trigger.removeEventListener("click", onTrigger);
    popover.removeEventListener("click", onPopover);
    document.removeEventListener("click", onOutside);
    document.removeEventListener("keydown", onKeyDown);
    input.removeEventListener("change", onInputChange);
  };
}

function initDatePicker() {
  if (!datePicker || !dateTrigger || !datePopover) return;
  initCalendarPicker({
    picker: datePicker,
    input: dateInput,
    trigger: dateTrigger,
    valueLabel: dateValueLabel,
    popover: datePopover,
    monthLabel: calendarMonthLabel,
    grid: calendarGrid
  });
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number) : escapeHtml(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function notify(message, type = "info") {
  alertRegion.innerHTML = `<div class="alert ${type === "error" ? "error" : ""}">${type === "error" ? icons.info : icons.check}<p>${escapeHtml(message)}</p></div>`;
  window.setTimeout(() => { alertRegion.innerHTML = ""; }, 6000);
}

function setLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("loading", loading);
}

function metric(label, value, contextText) {
  return `<article class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${formatNumber(value)}</strong><span class="metric-context">${contextText}</span></article>`;
}

function badge(status) {
  const labels = {
    ready: ["待写入", "warning"], written: ["已写入", ""], blank: ["空值跳过", "neutral"],
    same: ["已一致", "neutral"], conflict: ["数值冲突", "error"], error: ["异常", "error"], failed: ["读取失败", "error"]
  };
  const [label, className] = labels[status] || [status || "未知", "neutral"];
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function renderOverview() {
  const primary = scenarioData("scenario-1");
  const latest = primary.runs[0];
  const summary = latest?.summary || {};
  content.innerHTML = `
    <div class="metric-grid">
      ${metric("已启用工作簿", primary.sources.filter((source) => source.enabled).length, `共导入 ${primary.sources.length} 个链接`)}
      ${metric("待写入 / 已写入", (summary.ready || 0) + (summary.written || 0), "仅处理非空源数值")}
      ${metric("空值跳过", summary.blankSkipped || 0, "不会写 0，也不会清空目标")}
      ${metric("冲突与异常", (summary.conflicts || 0) + (summary.errors || 0), "安全模式不覆盖已有值")}
    </div>
    ${!state.connection.configured ? `<div class="alert">${icons.info}<p>${escapeHtml(state.connection.message)}。先完成链接导入；需要实际预览时再配置凭据。</p></div>` : ""}
    <section class="panel">
      <div class="panel-header"><div><h2>最近一次处理结果</h2><p>${latest ? `${latest.businessDate} · ${latest.type === "run" ? "正式写入" : "预览"}` : "尚未执行任务"}</p></div>${latest ? `<span class="badge neutral">${new Date(latest.createdAt).toLocaleString("zh-CN")}</span>` : ""}</div>
      ${latest ? renderRunDetails(latest) : `<div class="empty-state">${icons.sheet}<h3>等待首次预览</h3><p>导入工作簿后选择业务日期，先运行预览核对渠道映射和空值跳过结果。</p></div>`}
    </section>
    <section class="panel safety-rules-panel" hidden>
      <div class="panel-header"><div><h2>固定安全规则</h2><p>第一版采用保守写入策略</p></div></div>
      <div class="panel-body"><ul class="rule-list">
        <li>${icons.check}<span><strong>源值为空：</strong>跳过该指标，不写入数值，不清空总表现有值。</span></li>
        <li>${icons.check}<span><strong>源值为数字 0：</strong>作为有效数据正常写入。</span></li>
        <li>${icons.check}<span><strong>目标已有不同值：</strong>标记冲突，不自动覆盖。</span></li>
        <li>${icons.check}<span><strong>重复执行：</strong>相同值直接跳过，避免重复写入。</span></li>
      </ul></div>
    </section>`;
  content.querySelectorAll("[data-run-detail]").forEach((row) => row.addEventListener("click", () => { const run = primary.runs.find((item) => item.id === row.dataset.runDetail); if (run) openRunDetail("scenario-1", run); }));
}

function renderSources() {
  const primary = scenarioData("scenario-1");
  content.innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><h2>工作簿配置</h2></div><button class="button primary" type="button" data-open-source-import>${icons.sheet}添加工作簿</button></div>
      <div class="panel-body config-toolbar"><label class="search-field" for="sourceSearch"><span class="sr-only">搜索工作簿</span><input id="sourceSearch" type="search" placeholder="搜索名称、表格 ID 或目标页签" autocomplete="off"></label><span class="config-count">${primary.sources.length} 个配置</span></div>
    </section>
    <section class="panel">
      <div class="panel-header"><div><h2>情景一工作簿</h2></div></div>
      ${renderSourceTable()}
    </section>
    <dialog id="sourceImportDrawer" class="detail-drawer-dialog config-drawer" aria-labelledby="sourceImportTitle"><div class="detail-drawer-card"><button class="detail-close" type="button" data-close-source-import aria-label="关闭添加工作簿">×</button><div class="detail-kicker">情景一</div><h2 id="sourceImportTitle">添加工作簿</h2><p>支持批量粘贴链接，每行一个。</p><div class="drawer-form"><label for="linkInput">Google 表格链接<textarea id="linkInput" placeholder="渠道名 | https://docs.google.com/spreadsheets/d/.../edit#gid=0&#10;https://docs.google.com/spreadsheets/d/.../edit?gid=123"></textarea></label><div id="linkPreview" class="paste-preview" aria-live="polite">等待粘贴链接</div><div class="drawer-actions"><button class="button secondary" type="button" data-close-source-import>取消</button><button class="button primary" id="importButton" type="button">${icons.sheet}导入配置</button></div></div></div></dialog>`;
  const drawer = content.querySelector("#sourceImportDrawer");
  content.querySelector("[data-open-source-import]")?.addEventListener("click", () => drawer?.showModal());
  content.querySelectorAll("[data-close-source-import]").forEach((button) => button.addEventListener("click", () => drawer?.close()));
  content.querySelector("#importButton")?.addEventListener("click", importSources);
  content.querySelector("#linkInput")?.addEventListener("input", (event) => {
    const lines = event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const preview = content.querySelector("#linkPreview");
    if (preview) preview.textContent = lines.length ? `已识别 ${lines.length} 行链接，提交后自动解析名称与表格 ID。` : "等待粘贴链接";
  });
  content.querySelector("#sourceSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    content.querySelectorAll("[data-search-row]").forEach((row) => { row.hidden = query && !row.dataset.searchRow.includes(query); });
  });
  content.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", toggleSource));
  content.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", deleteSource));
  content.querySelectorAll("[data-edit-name]").forEach((button) => button.addEventListener("click", beginEditSource));
  content.querySelectorAll("[data-name-input]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") cancelInlineEdit(input);
    });
    input.addEventListener("blur", () => saveInlineName(input));
  });
}

function renderSourceTable(scenario = "scenario-1") {
  const sources = scenarioData(scenario).sources;
  const scenarioLabel = "投放统计";
  const secondColumn = "目标页签";
  if (!sources.length) return `<div class="empty-state">${icons.sheet}<h3>尚未导入工作簿</h3><p>可一次粘贴多个 Google 表格链接，系统会分别建立独立配置。</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>工作簿</th><th>${secondColumn}</th><th>情景</th><th>启用</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${sources.map((source) => `
    <tr data-search-row="${escapeHtml(`${source.name} ${source.spreadsheetId || ""} ${source.targetSheet || ""}`.toLowerCase())}"><td class="name-cell source-row" data-source-row="${source.id}"><div class="name-display"><strong>${escapeHtml(source.name)}</strong><button class="icon-button" data-edit-name="${source.id}" type="button" aria-label="编辑${escapeHtml(source.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.7 4.7L8 20l11-11a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg></button></div><input class="inline-input" data-name-input="${source.id}" value="${escapeHtml(source.name)}" aria-label="编辑工作簿名"><small class="name-url">${escapeHtml(source.spreadsheetId || source.url)}</small></td><td>${escapeHtml(source.targetSheet || "—")}</td><td><span class="badge neutral">${scenarioLabel}</span></td><td><button class="toggle ${source.enabled ? "on" : ""}" data-toggle="${source.id}" role="switch" aria-checked="${source.enabled}" aria-label="${source.enabled ? "停用" : "启用"}${escapeHtml(source.name)}"></button></td><td><div class="actions"><a class="button small secondary" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">打开</a><button class="button small danger" data-delete="${source.id}">移除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function shooterBusinessDates() {
  return [...new Set(["scenario-1", "scenario-2"].flatMap((scenario) => scenarioData(scenario).runs
    .filter((run) => run.businessDate && run.results?.some((result) => result.status === "success" && result.rows?.some(spendEntry)))
    .map((run) => String(run.businessDate))))].sort((a, b) => b.localeCompare(a));
}

function shooterDatePickerMarkup(value) {
  return `<div class="date-field shooter-date-field" id="shooterBusinessDatePicker">
    <span class="date-caption">查看日期</span>
    <button class="date-trigger" id="shooterBusinessDateTrigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="shooterBusinessDatePopover">
      <span id="shooterBusinessDateValue">${escapeHtml(formatPickerDate(value))}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
    </button>
    <input id="shooterBusinessDate" type="date" value="${escapeHtml(value)}" tabindex="-1" aria-hidden="true">
    <div class="date-popover" id="shooterBusinessDatePopover" role="dialog" aria-label="选择投手消耗日期" hidden>
      <div class="date-picker-head"><button class="date-nav-button" type="button" data-calendar-nav="prev" aria-label="上个月">‹</button><strong id="shooterCalendarMonthLabel"></strong><button class="date-nav-button" type="button" data-calendar-nav="next" aria-label="下个月">›</button></div>
      <div class="date-weekdays" aria-hidden="true"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div class="date-grid" id="shooterCalendarGrid" role="grid" aria-label="投手消耗日期"></div>
      <div class="date-picker-footer"><button class="date-text-button" type="button" data-calendar-clear>清除</button><button class="date-text-button" type="button" data-calendar-today>今天</button></div>
    </div>
  </div>`;
}

function selectedShooterDate() {
  const availableDates = shooterBusinessDates();
  const selected = state.shooterDate || availableDates[0] || formatDate(new Date(Date.now() - 86_400_000));
  state.shooterDate = selected;
  return selected;
}

function recentDateRange(endDate, count = 5) {
  const end = parseDateValue(endDate);
  if (!end) return [];
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (count - 1 - index));
    return formatDate(date);
  });
}

function initStandaloneDatePicker() {
  if (!pageAuxActions || !pageAuxActions.querySelector("#shooterBusinessDatePicker")) return;
  state.shooterDatePickerCleanup?.();
  state.shooterDatePickerCleanup = initCalendarPicker({
    picker: pageAuxActions.querySelector("#shooterBusinessDatePicker"),
    input: pageAuxActions.querySelector("#shooterBusinessDate"),
    trigger: pageAuxActions.querySelector("#shooterBusinessDateTrigger"),
    valueLabel: pageAuxActions.querySelector("#shooterBusinessDateValue"),
    popover: pageAuxActions.querySelector("#shooterBusinessDatePopover"),
    monthLabel: pageAuxActions.querySelector("#shooterCalendarMonthLabel"),
    grid: pageAuxActions.querySelector("#shooterCalendarGrid"),
    ariaLabel: "统计日期",
    onValueChange: (value) => { state.shooterDate = value; render(); }
  });
}

function spendEntry(row) {
  const metricName = String(row.metric || "");
  const metric = /回流/.test(metricName) ? "returnSpend" : /消耗/.test(metricName) ? "spend" : "";
  if (!metric || row.status === "error" || row.status === "blank" || row.sourceValue === undefined || row.sourceValue === null || row.sourceValue === "") return null;
  const value = Number(row.sourceValue);
  return Number.isFinite(value) ? { metric, value } : null;
}

function displayShooter(row) {
  const target = String(row.targetSheet || "").match(/\(([^()]*)\)\s*$/);
  const channel = String(row.channel || "").match(/\(([^()]*)\)\s*$/);
  const value = row.shooter || target?.[1] || channel?.[1] || "未标注";
  return String(value).trim().toUpperCase();
}

function displayChain(row) {
  const channel = String(row.channel || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
  return row.routeKey || row.targetChannel || channel || row.routeCode || "未识别";
}

function displayChannelGroup(result, scenario) {
  const scenario2 = scenario === "scenario-2";
  const configurations = scenario2 ? scenarioData(scenario).pairs : scenarioData(scenario).sources;
  const configurationId = scenario2 ? result.pairId : result.sourceId;
  const snapshotName = scenario2 ? result.pairName : result.sourceName;
  const configured = configurationId
    ? configurations.find((item) => item.id === configurationId)
    : configurations.find((item) => String(item.name).trim() === String(snapshotName || "").trim());
  return String(configured?.name || "").trim();
}

function latestDataResults(scenario, businessDate = "") {
  const scenario2 = scenario === "scenario-2";
  return latestSuccessfulResultsByConfiguration(scenarioData(scenario).runs, {
    businessDate,
    configurationKey: (result) => (scenario2 ? result.pairId : result.sourceId) || displayChannelGroup(result, scenario),
    hasSpendData: (result) => result.rows?.some(spendEntry)
  });
}

function shooterSpendRows(businessDate = "") {
  const snapshots = ["scenario-1", "scenario-2"].flatMap((scenario) =>
    latestDataResults(scenario, businessDate).map(({ run, result }) => ({ scenario, run, result }))
  );
  const runs = [...new Map(snapshots.map(({ run }) => [run.id, run])).values()];
  const groups = new Map();
  for (const { scenario, result } of snapshots) {
    const channelGroup = displayChannelGroup(result, scenario);
    if (!channelGroup) continue;
    for (const row of result.rows || []) {
      const entry = spendEntry(row);
      if (!entry) continue;
      const chain = displayChain(row);
      if (!chain || chain === "未识别") continue;
      const shooter = displayShooter(row);
      const key = `${channelGroup}\u0000${shooter}\u0000${chain}`;
      const current = groups.get(key) || { channelGroup, shooter, chain, spend: 0, returnSpend: 0 };
      current[entry.metric] += entry.value;
      groups.set(key, current);
    }
  }
  return { runs, rows: [...groups.values()].sort((a, b) => a.shooter.localeCompare(b.shooter, "zh-CN") || a.chain.localeCompare(b.chain, "zh-CN", { numeric: true })) };
}

function summarizeSpendRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const groupKey = row[key];
    const current = groups.get(groupKey) || { [key]: groupKey, spend: 0, returnSpend: 0, details: [] };
    current.spend += row.spend;
    current.returnSpend += row.returnSpend;
    current.details.push(row);
    groups.set(groupKey, current);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, total: group.spend + group.returnSpend }))
    .sort((a, b) => b.total - a.total || String(a[key]).localeCompare(String(b[key]), "zh-CN", { numeric: true }));
}

function spendMetricData(rows, runs) {
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const returnSpend = rows.reduce((sum, row) => sum + row.returnSpend, 0);
  return { spend, returnSpend, total: spend + returnSpend, rows, runs };
}

function spendSummaryMarkup(entityLabel, entityCount, data) {
  return `<section class="spend-summary" aria-label="所选日期消耗概览">
    <div class="spend-summary-lead"><span>${escapeHtml(entityLabel)}</span><strong>${entityCount}</strong></div>
    <dl class="spend-summary-values">
      <div><dt>消耗</dt><dd>${formatNumber(data.spend)}</dd></div>
      <div><dt>回流消耗</dt><dd>${formatNumber(data.returnSpend)}</dd></div>
      <div class="is-total"><dt>总消耗</dt><dd>${formatNumber(data.total)}</dd></div>
    </dl>
  </section>`;
}

function spendDetailDialogMarkup(kind) {
  const titleId = `${kind}DetailTitle`;
  const subtitleId = `${kind}DetailSubtitle`;
  const metricsId = `${kind}DetailMetrics`;
  const bodyId = `${kind}DetailBody`;
  const label = kind === "shooter" ? "投手" : "渠道";
  return `<dialog id="${kind}DetailDialog" class="shooter-detail-dialog" aria-labelledby="${titleId}"><div class="shooter-detail-card"><button class="detail-close" type="button" data-${kind}-close aria-label="关闭${label}明细">×</button><div class="detail-kicker">${label}链名明细</div><h2 id="${titleId}">${label}</h2><p id="${subtitleId}"></p><div class="detail-metrics" id="${metricsId}"></div><div class="table-wrap"><table><thead><tr><th>链名</th><th>消耗</th><th>回流</th><th>总消耗</th></tr></thead><tbody id="${bodyId}"></tbody></table></div></div></dialog>`;
}

function bindSpendDetail(kind, summaries) {
  const dialog = content.querySelector(`#${kind}DetailDialog`);
  const title = content.querySelector(`#${kind}DetailTitle`);
  const subtitle = content.querySelector(`#${kind}DetailSubtitle`);
  const metrics = content.querySelector(`#${kind}DetailMetrics`);
  const body = content.querySelector(`#${kind}DetailBody`);
  const lookupKey = kind === "shooter" ? "shooter" : "channelGroup";
  const lookup = new Map(summaries.map((summary) => [summary.detailKey || summary[lookupKey], summary]));
  content.querySelectorAll(`[data-${kind}-open]`).forEach((button) => button.addEventListener("click", () => {
    const summary = lookup.get(button.dataset[`${kind}Open`]);
    if (!summary || !dialog) return;
    const chains = summarizeSpendRows(summary.details, "chain");
    title.textContent = summary[lookupKey];
    metrics.innerHTML = `${metric("消耗", summary.spend, "")}${metric("回流", summary.returnSpend, "")}${metric("总消耗", summary.total, "")}`;
    if (kind === "shooter") {
      const channels = summarizeSpendRows(summary.details, "channelGroup");
      const chainCount = new Set(summary.details.map((row) => `${row.channelGroup}\u0000${row.chain}`)).size;
      subtitle.textContent = `${channels.length} 个渠道，${chainCount} 条链`;
      body.innerHTML = channels.map((channel) => {
        const channelChains = summarizeSpendRows(channel.details, "chain");
        return `<tr class="detail-channel-row"><th colspan="4"><span>${escapeHtml(channel.channelGroup)}</span><strong>${formatNumber(channel.total)}</strong></th></tr>${channelChains.map((row) => `<tr><td><strong>${escapeHtml(row.chain)}</strong></td><td>${formatNumber(row.spend)}</td><td>${formatNumber(row.returnSpend)}</td><td><strong>${formatNumber(row.total)}</strong></td></tr>`).join("")}`;
      }).join("");
    } else {
      subtitle.textContent = `${summary.businessDate ? `${summary.businessDate}，` : ""}${chains.length} 条链`;
      body.innerHTML = chains.map((row) => `<tr><td><strong>${escapeHtml(row.chain)}</strong></td><td>${formatNumber(row.spend)}</td><td>${formatNumber(row.returnSpend)}</td><td><strong>${formatNumber(row.total)}</strong></td></tr>`).join("");
    }
    dialog.showModal();
  }));
  content.querySelector(`[data-${kind}-close]`)?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}

function renderChannelSpendPanel() {
  const selectedDate = selectedShooterDate();
  const source = shooterSpendRows(selectedDate);
  const data = spendMetricData(source.rows, source.runs);
  const dates = recentDateRange(selectedDate);
  const dailySummaries = dates.map((businessDate) => {
    const dailySource = shooterSpendRows(businessDate);
    const summaries = summarizeSpendRows(dailySource.rows, "channelGroup").map((summary) => ({
      ...summary,
      businessDate,
      detailKey: encodeURIComponent(`${businessDate}\n${summary.channelGroup}`)
    }));
    return { businessDate, summaries, lookup: new Map(summaries.map((summary) => [summary.channelGroup, summary])) };
  });
  const allSummaries = dailySummaries.flatMap((day) => day.summaries);
  const channelTotals = summarizeSpendRows(allSummaries.flatMap((summary) => summary.details), "channelGroup");
  const channelNames = channelTotals.map((summary) => summary.channelGroup);
  const empty = `<div class="empty-state">${icons.empty}<h3>暂无渠道消耗数据</h3></div>`;
  const body = channelNames.length ? `<div class="table-wrap channel-matrix-wrap"><table class="channel-matrix"><caption class="sr-only">截至 ${escapeHtml(selectedDate)} 最近五天的渠道总消耗</caption><thead><tr><th class="channel-matrix-date" scope="col">日期</th>${channelNames.map((name) => `<th scope="col">${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${dailySummaries.map((day) => `<tr class="${day.businessDate === selectedDate ? "is-selected" : ""}" ${day.businessDate === selectedDate ? 'aria-current="date"' : ""}><th class="channel-matrix-date" scope="row">${escapeHtml(day.businessDate)}</th>${channelNames.map((name) => {
    const summary = day.lookup.get(name);
    return summary
      ? `<td><button class="channel-matrix-value" type="button" data-channel-open="${escapeHtml(summary.detailKey)}" aria-haspopup="dialog" aria-label="查看 ${escapeHtml(name)} ${escapeHtml(day.businessDate)} 链名消耗">${formatNumber(summary.total)}</button></td>`
      : `<td class="channel-matrix-empty" aria-label="无记录">—</td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div>` : empty;
  content.innerHTML = `${spendSummaryMarkup("渠道", channelNames.length, data)}<section class="panel spend-panel"><div class="panel-header spend-panel-header"><div><h2>渠道五日消耗</h2></div><span class="badge neutral">最近 5 天</span></div>${body}</section>${spendDetailDialogMarkup("channel")}`;
  bindSpendDetail("channel", allSummaries);
}

function renderShooterPanel() {
  const selectedDate = selectedShooterDate();
  const source = shooterSpendRows(selectedDate);
  const data = spendMetricData(source.rows, source.runs);
  const shooterTotals = summarizeSpendRows(data.rows, "shooter").map((summary) => {
    const channels = summarizeSpendRows(summary.details, "channelGroup");
    const chainCount = new Set(summary.details.map((row) => `${row.channelGroup}\u0000${row.chain}`)).size;
    return { ...summary, channels, chainCount };
  });
  const empty = `<div class="empty-state">${icons.empty}<h3>暂无投手消耗数据</h3></div>`;
  const body = shooterTotals.length ? `<div class="table-wrap shooter-spend-wrap"><table class="shooter-spend-table"><thead><tr><th>投手</th><th>所在渠道</th><th>链数</th><th>消耗</th><th>回流消耗</th><th>总消耗</th></tr></thead><tbody>${shooterTotals.map((summary) => {
    const searchText = `${summary.shooter} ${summary.channels.map((channel) => channel.channelGroup).join(" ")} ${summary.details.map((row) => row.chain).join(" ")}`.toLowerCase();
    return `<tr data-spend-search-row="${escapeHtml(searchText)}"><td><button class="shooter-row-trigger" type="button" data-shooter-open="${escapeHtml(summary.shooter)}" aria-haspopup="dialog"><span class="shooter-avatar" aria-hidden="true">${escapeHtml(summary.shooter.slice(0, 1))}</span><span class="shooter-row-copy"><strong>${escapeHtml(summary.shooter)}</strong></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></td><td><div class="channel-token-list">${summary.channels.map((channel) => `<span class="channel-token">${escapeHtml(channel.channelGroup)}</span>`).join("")}</div></td><td class="numeric-cell">${summary.chainCount}</td><td class="numeric-cell">${formatNumber(summary.spend)}</td><td class="numeric-cell">${formatNumber(summary.returnSpend)}</td><td class="numeric-cell total-cell">${formatNumber(summary.total)}</td></tr>`;
  }).join("")}<tr class="spend-filter-empty" hidden><td colspan="6">没有匹配的投手、渠道或链名</td></tr></tbody></table></div>` : empty;
  content.innerHTML = `${spendSummaryMarkup("投手", shooterTotals.length, data)}<section class="panel spend-panel"><div class="panel-header spend-panel-header"><div><h2>投手当日消耗</h2></div>${shooterTotals.length ? `<label class="spend-search"><span class="sr-only">搜索投手、渠道或链名</span><input type="search" placeholder="搜索投手、渠道或链名" autocomplete="off"></label>` : ""}</div>${body}</section>${spendDetailDialogMarkup("shooter")}`;
  const searchInput = content.querySelector(".spend-search input");
  const searchRows = [...content.querySelectorAll("[data-spend-search-row]")];
  const filterEmpty = content.querySelector(".spend-filter-empty");
  searchInput?.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    let visible = 0;
    for (const row of searchRows) {
      const matches = !query || row.dataset.spendSearchRow.includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    if (filterEmpty) filterEmpty.hidden = visible > 0;
  });
  bindSpendDetail("shooter", shooterTotals);
}

function beginEditSource(event) {
  const row = event.currentTarget.closest("[data-source-row]");
  const input = row.querySelector("[data-name-input]");
  row.classList.add("inline-editing");
  input.focus();
  input.select();
}

function cancelInlineEdit(input) {
  const source = scenarioData("scenario-1").sources.find((item) => item.id === input.dataset.nameInput);
  input.value = source?.name || input.value;
  input.closest("[data-source-row]")?.classList.remove("inline-editing");
}

async function saveInlineName(input) {
  const row = input.closest("[data-source-row]");
  if (!row?.classList.contains("inline-editing")) return;
  const source = scenarioData("scenario-1").sources.find((item) => item.id === input.dataset.nameInput);
  const name = input.value.trim();
  if (!source) return;
  if (!name) {
    notify("工作簿名不能为空", "error");
    input.value = source.name;
    row.classList.remove("inline-editing");
    return;
  }
  if (name === source.name) {
    row.classList.remove("inline-editing");
    return;
  }
  try {
    const data = await api(scenarioApi("scenario-1", `/sources/${source.id}`), { method: "PATCH", body: JSON.stringify({ name }) });
    Object.assign(source, data.source);
    notify("工作簿名已更新");
    renderSources();
  } catch (error) {
    notify(error.message, "error");
    row.classList.remove("inline-editing");
  }
}

function renderRuns() {
  const runs = scenarioData("scenario-1").runs;
  content.innerHTML = `<section class="panel"><div class="panel-header"><div><h2>情景一运行日志</h2><p>保留最近 50 次预览和正式写入记录</p></div></div>${runs.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>业务日期</th><th>工作簿</th><th>空值跳过</th><th>冲突</th><th>异常</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${new Date(run.createdAt).toLocaleString("zh-CN")}</td><td>${run.type === "run" ? badge("written") : badge("ready")}</td><td>${run.businessDate}</td><td>${run.summary.workbooks}</td><td>${run.summary.blankSkipped}</td><td>${run.summary.conflicts}</td><td>${run.summary.errors}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state">${icons.empty}<h3>暂无运行记录</h3><p>预览和正式写入都会在这里留下可追溯记录。</p></div>`}</section>`;
}

function classifyError(message) {
  const value = String(message || "");
  if (/权限|permission|forbidden|caller/i.test(value)) return "权限错误";
  if (/network|timeout|连接|TLS|socket|fetch failed/i.test(value)) return "网络错误";
  if (/日期|date/i.test(value)) return "日期缺失";
  if (/链名|渠道|匹配|投手|歧义/i.test(value)) return "链名冲突";
  if (/结构|表头|页签|日报/i.test(value)) return "结构错误";
  return "其他错误";
}

function runStatus(run) {
  const summary = run.summary || {};
  return summary.errors || summary.conflicts ? "error" : run.type === "run" ? "written" : "ready";
}

function errorGuidance(category) {
  const guidance = {
    "权限错误": "建议：确认服务账号已被授予该工作簿访问权限。",
    "网络错误": "建议：检查代理、网络连接与 Google API 可达性。",
    "日期缺失": "建议：确认日报页签存在所选业务日期，并检查日期格式。",
    "链名冲突": "建议：检查链名是否存在于目标页签，或是否有多个页签都能匹配。",
    "结构错误": "建议：确认当前页签是日报页签，并检查日期、链名、消耗与回流字段。"
  };
  return guidance[category] || "建议：打开对应工作簿检查原始页签内容与权限。";
}

function openRunDetail(scenario, run) {
  if (!runDetailDrawer) return;
  const summary = run.summary || {};
  runDetailDrawerKicker.textContent = scenario === "scenario-2" ? "情景二 · 运行详情" : "情景一 · 运行详情";
  runDetailDrawerTitle.textContent = run.type === "run" ? "正式写入" : "预览归集";
  const category = runStatus(run) === "error" ? classifyError(run.error || run.results?.find((item) => item.error)?.error) : "";
  runDetailDrawerMeta.textContent = String(run.businessDate || "未设置日期") + " · " + new Date(run.createdAt).toLocaleString("zh-CN") + " · " + (category || "处理完成");
  const insight = category ? '<div class="error-insight"><strong>' + escapeHtml(category) + '</strong><span>' + escapeHtml(run.error || "读取失败") + '</span><small>' + escapeHtml(errorGuidance(category)) + '</small></div>' : "";
  runDetailDrawerBody.innerHTML = insight + (scenario === "scenario-2" ? renderScenario2RunDetails(run) : renderRunDetails(run));
  runDetailDrawer.showModal();
}

function renderRunsModern(scenario = "scenario-1") {
  const filters = state.logFilters;
  const allRuns = scenarioData(scenario).runs || [];
  const runs = allRuns.filter((run) => {
    const status = runStatus(run);
    if (filters.date && run.businessDate !== filters.date) return false;
    if (filters.status !== "all" && status !== filters.status) return false;
    if (filters.type !== "all" && (run.type === "run" ? "written" : "preview") !== filters.type) return false;
    return true;
  });
  const rows = runs.map((run) => {
    const summary = run.summary || {};
    const status = runStatus(run);
    const category = status === "error" ? classifyError(run.error || run.results?.find((item) => item.error)?.error) : "—";
    return '<tr><td>' + escapeHtml(new Date(run.createdAt).toLocaleString("zh-CN")) + '</td><td>' + escapeHtml(run.businessDate || "—") + '</td><td>' + (run.type === "run" ? badge("written") : badge("ready")) + '</td><td>' + formatNumber(summary.workbooks || summary.pairs || 0) + '</td><td>' + formatNumber((summary.written || 0) + (summary.ready || 0)) + '</td><td>' + formatNumber(summary.conflicts || 0) + '</td><td>' + (status === "error" ? badge("error") : '<span class="badge neutral">正常</span>') + '</td><td><button class="log-row-trigger" type="button" data-log-detail="' + escapeHtml(scenario + ":" + run.id) + '">查看详情</button><span class="log-category">' + escapeHtml(category) + '</span></td></tr>';
  }).join("");
  const scenarioLabel = scenario === "scenario-2" ? "情景二" : "情景一";
  content.innerHTML = '<section class="panel"><div class="panel-header"><div><h2>' + scenarioLabel + '运行日志</h2></div></div><div class="log-toolbar"><label>情景<select data-log-filter="scenario"><option value="scenario-1">情景一</option><option value="scenario-2">情景二</option></select></label><label>日期<input type="date" data-log-filter="date" value="' + escapeHtml(filters.date) + '"></label><label>状态<select data-log-filter="status"><option value="all">全部状态</option><option value="ready">待写入</option><option value="written">已写入</option><option value="error">异常</option></select></label><label>类型<select data-log-filter="type"><option value="all">全部类型</option><option value="preview">预览</option><option value="written">正式写入</option></select></label></div>' + (runs.length ? '<div class="table-wrap"><table><thead><tr><th>时间</th><th>业务日期</th><th>类型</th><th>工作簿</th><th>处理项</th><th>冲突</th><th>状态</th><th>详情</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty-state">' + icons.empty + '<h3>暂无符合条件的记录</h3></div>') + '</section>';
  content.querySelector('[data-log-filter="date"]').addEventListener("change", (event) => { state.logFilters.date = event.target.value; renderRunsModern(scenario); });
  content.querySelector('[data-log-filter="status"]').value = filters.status;
  content.querySelector('[data-log-filter="type"]').value = filters.type;
  content.querySelector('[data-log-filter="scenario"]').value = scenario;
  content.querySelector('[data-log-filter="scenario"]').addEventListener("change", (event) => { state.page = event.target.value === "scenario-2" ? "scenario2-runs" : "runs"; render(); });
  content.querySelectorAll('[data-log-filter="status"], [data-log-filter="type"]').forEach((control) => control.addEventListener("change", (event) => { state.logFilters[control.dataset.logFilter] = event.target.value; renderRunsModern(scenario); }));
  content.querySelectorAll("[data-log-detail]").forEach((button) => button.addEventListener("click", () => {
    const [targetScenario, id] = button.dataset.logDetail.split(":");
    const run = scenarioData(targetScenario).runs.find((item) => item.id === id);
    if (run) openRunDetail(targetScenario, run);
  }));
}

function renderPairTable(pairs) {
  if (!pairs.length) return `<div class="empty-state">${icons.sheet}<h3>尚未配置日报配对</h3><p>添加甲方日报和对应的自己的日报表后，系统会在配对范围内识别渠道编号。</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>配对名称</th><th>甲方日报</th><th>自己的日报</th><th>状态</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${pairs.map((pair) => `
    <tr data-search-row="${escapeHtml(`${pair.name} ${pair.client?.spreadsheetId || ""} ${pair.own?.spreadsheetId || ""}`.toLowerCase())}"><td><strong>${escapeHtml(pair.name)}</strong><small class="pair-note">按渠道编号匹配，目标页签：${escapeHtml(pair.targetSheet || "总表")}</small></td><td><a class="table-link" href="${escapeHtml(pair.client.url)}" target="_blank" rel="noreferrer">${escapeHtml(pair.client.name)}</a></td><td><a class="table-link" href="${escapeHtml(pair.own.url)}" target="_blank" rel="noreferrer">${escapeHtml(pair.own.name)}</a></td><td><button class="toggle ${pair.enabled ? "on" : ""}" data-pair-toggle="${pair.id}" role="switch" aria-checked="${pair.enabled}" aria-label="${pair.enabled ? "停用" : "启用"}${escapeHtml(pair.name)}"></button></td><td><div class="actions"><button class="button small danger" data-pair-delete="${pair.id}">移除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function renderScenario2RunDetails(run) {
  return `<div class="table-wrap"><table><thead><tr><th>配对</th><th>渠道</th><th>投手页签</th><th>指标</th><th>源值</th><th>投手日报</th><th>总表</th><th>结果</th><th>说明</th></tr></thead><tbody>${(run.results || []).flatMap((result) => result.rows?.length ? result.rows.map((row) => `
    <tr data-run-detail="${escapeHtml(run.id)}"><td><strong>${escapeHtml(result.pairName)}</strong><small class="pair-note">${escapeHtml(result.sourceName)} → ${escapeHtml(result.targetName)}</small></td><td><div class="channel-cell"><strong>${escapeHtml(row.routeCode || row.channel)}</strong><small class="channel-target">${escapeHtml(row.channel)}</small></div></td><td>${escapeHtml(row.targetSheet || "—")}</td><td>${escapeHtml(row.metric)}</td><td>${formatNumber(row.sourceValue)}</td><td>${row.detail ? `${badge(row.detail.status)}<small class="pair-note">${formatNumber(row.detail.value)}</small>` : "—"}</td><td>${row.total ? `${badge(row.total.status)}<small class="pair-note">${formatNumber(row.total.value)}</small>` : "—"}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.message || row.sourceRange || "—")}</td></tr>`) : [`<tr data-run-detail="${escapeHtml(run.id)}"><td>${escapeHtml(result.pairName || "日报配对")}</td><td colspan="7">${badge("failed")}</td><td>${escapeHtml(result.error || "未知错误")}</td></tr>`]).join("")}</tbody></table></div>`;
}

function renderScenario2Overview() {
  const secondary = scenarioData("scenario-2");
  const latest = secondary.runs[0];
  const summary = latest?.summary || {};
  content.innerHTML = `
    <div class="metric-grid">
      ${metric("已启用日报配对", secondary.pairs.filter((pair) => pair.enabled).length, `共配置 ${secondary.pairs.length} 组甲方与自己的日报`)}
      ${metric("待写入 / 已写入", (summary.ready || 0) + (summary.written || 0), "先写投手日报，再复核写入总表")}
      ${metric("空值跳过", summary.blankSkipped || 0, "消耗与回流按指标分别判断")}
      ${metric("冲突与异常", (summary.conflicts || 0) + (summary.errors || 0), "歧义、缺日期和已有值均不覆盖")}
    </div>
    <section class="panel">
      <div class="panel-header"><div><h2>最近一次情景二处理结果</h2><p>${latest ? `${latest.businessDate} · ${latest.type === "run" ? "正式写入" : "预览"}` : "尚未执行任务"}</p></div>${latest ? `<span class="badge neutral">${new Date(latest.createdAt).toLocaleString("zh-CN")}</span>` : ""}</div>
      ${latest ? renderScenario2RunDetails(latest) : `<div class="empty-state">${icons.sheet}<h3>等待首次预览</h3><p>选择业务日期后先预览，核对渠道编号、投手页签、日期行以及两级目标单元格。</p></div>`}
    </section>
    <section class="panel safety-rules-panel" hidden>
      <div class="panel-header"><div><h2>固定安全规则</h2><p>情景二按配对独立处理，先写投手日报，再复核总表</p></div></div>
      <div class="panel-body"><ul class="rule-list">
        <li>${icons.check}<span><strong>源值为空：</strong>跳过该指标，不写入数值，不清空目标已有值。</span></li>
        <li>${icons.check}<span><strong>目标有不同值：</strong>标记冲突，不自动覆盖。</span></li>
        <li>${icons.check}<span><strong>缺少日期或渠道：</strong>保留异常记录，等待配置修正。</span></li>
      </ul></div>
    </section>`;
  content.querySelectorAll("[data-run-detail]").forEach((row) => row.addEventListener("click", () => { const run = secondary.runs.find((item) => item.id === row.dataset.runDetail); if (run) openRunDetail("scenario-2", run); }));
}

function renderScenario2Config() {
  const secondary = scenarioData("scenario-2");
  content.innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><h2>新增日报配对</h2><p>甲方日报与自己的日报表必须一一对应</p></div></div>
      <div class="panel-body pair-form">
        <label>配对名称<input id="pairName" placeholder="例如：RS9"></label>
        <label>甲方日报链接<input id="clientUrl" placeholder="https://docs.google.com/spreadsheets/d/..."></label>
        <label>自己的日报链接<input id="ownUrl" placeholder="https://docs.google.com/spreadsheets/d/..."></label>
        <button class="button primary" id="addPairButton">${icons.sheet}添加配对</button>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header"><div><h2>工作簿配对</h2><p>完整链名可以变化，系统以配对内唯一渠道编号为主键</p></div></div>
      ${renderPairTable(secondary.pairs)}
    </section>`;
  document.querySelector("#addPairButton").addEventListener("click", addPair);
  content.querySelectorAll("[data-pair-toggle]").forEach((button) => button.addEventListener("click", togglePair));
  content.querySelectorAll("[data-pair-delete]").forEach((button) => button.addEventListener("click", deletePair));
}

function renderPairCards(pairs) {
  if (!pairs.length) return '<div class="empty-state">' + icons.sheet + '<h3>尚未配置日报配对</h3></div>';
  return '<div class="pair-card-list">' + pairs.map((pair) => '<article class="pair-card" data-search-row="' + escapeHtml((pair.name + " " + (pair.client?.spreadsheetId || "") + " " + (pair.own?.spreadsheetId || "")).toLowerCase()) + '"><div><strong>' + escapeHtml(pair.name) + '</strong><div class="pair-card-links"><a class="table-link" href="' + escapeHtml(pair.client.url) + '" target="_blank" rel="noreferrer">甲方日报 · ' + escapeHtml(pair.client.name) + '</a><a class="table-link" href="' + escapeHtml(pair.own.url) + '" target="_blank" rel="noreferrer">自己的日报 · ' + escapeHtml(pair.own.name) + '</a><span>识别模式 · 逐链页签</span></div></div><div class="pair-card-actions"><span class="badge ' + (pair.enabled ? "" : "neutral") + '">' + (pair.enabled ? "已启用" : "已停用") + '</span><button class="toggle ' + (pair.enabled ? "on" : "") + '" data-pair-toggle="' + pair.id + '" role="switch" aria-checked="' + pair.enabled + '" aria-label="' + (pair.enabled ? "停用" : "启用") + escapeHtml(pair.name) + '"></button><button class="button small danger" data-pair-delete="' + pair.id + '">移除</button></div></article>').join("") + '</div>';
}

function renderScenario2ConfigModern() {
  const secondary = scenarioData("scenario-2");
  const drawerMarkup = '<dialog id="pairImportDrawer" class="detail-drawer-dialog config-drawer" aria-labelledby="pairImportTitle"><div class="detail-drawer-card"><button class="detail-close" type="button" data-close-pair-import aria-label="关闭添加配对">×</button><div class="detail-kicker">情景二</div><h2 id="pairImportTitle">添加日报配对</h2><p>为每个甲方日报配置一张自己的日报。</p><div class="drawer-form"><label>配对名称<input id="pairName" placeholder="例如：RS9"></label><label>甲方日报链接<input id="clientUrl" placeholder="https://docs.google.com/spreadsheets/d/..."></label><label>自己的日报链接<input id="ownUrl" placeholder="https://docs.google.com/spreadsheets/d/..."></label><div class="drawer-actions"><button class="button secondary" type="button" data-close-pair-import>取消</button><button class="button primary" id="addPairButton" type="button">' + icons.sheet + '添加配对</button></div></div></div></dialog>';
  content.innerHTML = '<section class="panel"><div class="panel-header"><div><h2>工作簿配置</h2></div><button class="button primary" type="button" data-open-pair-import>' + icons.sheet + '添加配对</button></div><div class="panel-body config-toolbar"><label class="search-field" for="pairSearch"><span class="sr-only">搜索配对</span><input id="pairSearch" type="search" placeholder="搜索配对名称或表格 ID" autocomplete="off"></label><span class="config-count">' + secondary.pairs.length + ' 组配对</span></div></section><section class="panel"><div class="panel-header"><div><h2>情景二日报配对</h2></div></div>' + renderPairCards(secondary.pairs) + '</section>' + drawerMarkup;
  const drawer = content.querySelector("#pairImportDrawer");
  content.querySelector("[data-open-pair-import]")?.addEventListener("click", () => drawer?.showModal());
  content.querySelectorAll("[data-close-pair-import]").forEach((button) => button.addEventListener("click", () => drawer?.close()));
  content.querySelector("#addPairButton")?.addEventListener("click", addPair);
  content.querySelector("#pairSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    content.querySelectorAll("[data-search-row]").forEach((row) => { row.hidden = query && !row.dataset.searchRow.includes(query); });
  });
  content.querySelectorAll("[data-pair-toggle]").forEach((button) => button.addEventListener("click", togglePair));
  content.querySelectorAll("[data-pair-delete]").forEach((button) => button.addEventListener("click", deletePair));
}

function renderChannel(row) {
  const target = row.targetChannel && row.targetChannel !== row.channel
    ? `<small class="channel-target">目标列：${escapeHtml(row.targetChannel)}</small>`
    : "";
  return `<div class="channel-cell"><strong>${escapeHtml(row.channel)}</strong>${target}</div>`;
}

function renderRunDetails(run) {
  return `<div class="table-wrap"><table><thead><tr><th>工作簿</th><th>渠道</th><th>指标</th><th>源值</th><th>目标值</th><th>结果</th><th>说明</th></tr></thead><tbody>${(run.results || []).flatMap((result) => result.rows?.length ? result.rows.map((row) => `<tr data-run-detail="${escapeHtml(run.id)}"><td>${escapeHtml(result.sourceName)}</td><td>${renderChannel(row)}</td><td>${escapeHtml(row.metric)}</td><td>${formatNumber(row.sourceValue)}</td><td>${formatNumber(row.targetValue)}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.message || row.range || "—")}</td></tr>`) : [`<tr data-run-detail="${escapeHtml(run.id)}"><td>${escapeHtml(result.sourceName)}</td><td colspan="5">${badge("error")}</td><td>${escapeHtml(result.error || "未知错误")}</td></tr>`]).join("")}</tbody></table></div>`;
}

function render() {
  const pages = {
    overview: { title: "今日运行", render: renderOverview },
    sources: { title: "工作簿配置", render: renderSources },
    runs: { title: "运行日志", render: () => renderRunsModern("scenario-1") },
    channels: { title: "渠道消耗", render: renderChannelSpendPanel },
    shooters: { title: "投手消耗", render: renderShooterPanel },
    "scenario2-overview": { title: "今日运行", render: renderScenario2Overview },
    "scenario2-config": { title: "工作簿配置", render: renderScenario2ConfigModern },
    "scenario2-runs": { title: "运行日志", render: () => renderRunsModern("scenario-2") }
  };
  const page = pages[state.page] || pages.overview;
  const secondary = state.page.startsWith("scenario2");
  const shooterPage = state.page === "shooters";
  const standalonePage = state.page === "channels" || shooterPage;
  const runPage = state.page === "overview" || state.page === "scenario2-overview";
  pageTitle.textContent = page.title;
  topWorkspaceLabel.textContent = standalonePage ? "独立统计工作台" : secondary ? "配对日报工作台" : "投放统计工作台";
  document.querySelector(".eyebrow").textContent = standalonePage
    ? `独立统计 / ${shooterPage ? "投手消耗" : "渠道消耗"}`
    : secondary
      ? (state.page === "scenario2-overview" ? "情景二 / 配对日报归集" : "情景二 / 工作簿配置")
      : "情景一 / 渠道日报归集";
  document.querySelector(".content-subtitle").textContent = standalonePage
    ? shooterPage ? "按所选日期查看投手消耗。" : "查看截至所选日期最近 5 天的渠道消耗。"
    : state.page === "scenario2-overview"
      ? "查看情景二每日处理状态，确认空值跳过与冲突数据。"
      : secondary
        ? "管理甲方日报与自己的日报配对。"
        : "查看每日归集状态，确认空值跳过与冲突数据。";
  document.querySelectorAll(".menu-item").forEach((button) => {
    const active = button.dataset.page === state.page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".scenario-group").forEach((group) => {
    group.classList.toggle("has-active", Boolean(group.querySelector(`.menu-item[data-page="${state.page}"]`)));
  });
  document.querySelector('[data-scenario-status="scenario-1"]').textContent = scenarioData("scenario-1").sources?.some((source) => source.enabled) ? "已配置" : "待配置";
  document.querySelector('[data-scenario-status="scenario-2"]').textContent = scenarioData("scenario-2").pairs?.some((pair) => pair.enabled) ? "已配置" : "待配置";
  dateInput.closest(".date-field").hidden = !runPage;
  rulesButton.hidden = !runPage;
  previewButton.hidden = !runPage;
  runButton.hidden = !runPage;
  if (!standalonePage) {
    state.shooterDatePickerCleanup?.();
    state.shooterDatePickerCleanup = null;
  }
  pageAuxActions.hidden = !standalonePage;
  pageAuxActions.innerHTML = standalonePage ? shooterDatePickerMarkup(selectedShooterDate()) : "";
  page.render();
  if (standalonePage) initStandaloneDatePicker();
}

function navigateToPage(button) {
  state.page = button.dataset.page;
  const group = button.closest(".scenario-group")?.dataset.scenarioGroup;
  if (group) {
    setScenarioAccordion(group, true);
    localStorage.setItem(`${accordionStorageKey}.${group}`, "1");
  }
  render();
}

async function importSources() {
  const button = document.querySelector("#importButton");
  const text = document.querySelector("#linkInput").value;
  setLoading(button, true);
  try {
    const data = await api(scenarioApi("scenario-1", "/sources/import"), { method: "POST", body: JSON.stringify({ text }) });
    state.scenarios["scenario-1"].sources = data.sources;
    const added = data.results.filter((item) => item.status === "added").length;
    const invalid = data.results.filter((item) => item.status === "invalid").length;
    notify(`成功导入 ${added} 个，重复或无效 ${data.results.length - added} 个${invalid ? `（无效 ${invalid} 个）` : ""}`);
    renderSources();
  } catch (error) { notify(error.message, "error"); }
  finally { setLoading(button, false); }
}

async function toggleSource(event) {
  const source = scenarioData("scenario-1").sources.find((item) => item.id === event.currentTarget.dataset.toggle);
  try {
    const data = await api(scenarioApi("scenario-1", `/sources/${source.id}`), { method: "PATCH", body: JSON.stringify({ enabled: !source.enabled }) });
    Object.assign(source, data.source);
    renderSources();
  } catch (error) { notify(error.message, "error"); }
}

async function deleteSource(event) {
  const source = scenarioData("scenario-1").sources.find((item) => item.id === event.currentTarget.dataset.delete);
  if (!window.confirm(`确认移除“${source.name}”的配置？不会删除 Google 表格；历史运行日志仍保留，但不再计入消耗统计。`)) return;
  try {
    const data = await api(scenarioApi("scenario-1", `/sources/${source.id}`), { method: "DELETE" });
    state.scenarios["scenario-1"].sources = data.sources;
    notify("工作簿配置已移除");
    renderSources();
  } catch (error) { notify(error.message, "error"); }
}

async function addPair() {
  const button = document.querySelector("#addPairButton");
  const name = document.querySelector("#pairName").value;
  const clientUrl = document.querySelector("#clientUrl").value;
  const ownUrl = document.querySelector("#ownUrl").value;
  setLoading(button, true);
  try {
    const data = await api(scenarioApi("scenario-2", "/pairs"), { method: "POST", body: JSON.stringify({ name, clientUrl, ownUrl }) });
    state.scenarios["scenario-2"].pairs = data.pairs;
    notify("日报配对已添加");
    renderScenario2ConfigModern();
  } catch (error) { notify(error.message, "error"); }
  finally { setLoading(button, false); }
}

async function togglePair(event) {
  const pair = scenarioData("scenario-2").pairs.find((item) => item.id === event.currentTarget.dataset.pairToggle);
  try {
    const data = await api(scenarioApi("scenario-2", `/pairs/${pair.id}`), { method: "PATCH", body: JSON.stringify({ enabled: !pair.enabled }) });
    Object.assign(pair, data.pair);
    renderScenario2ConfigModern();
  } catch (error) { notify(error.message, "error"); }
}

async function deletePair(event) {
  const pair = scenarioData("scenario-2").pairs.find((item) => item.id === event.currentTarget.dataset.pairDelete);
  if (!window.confirm(`确认移除“${pair.name}”？不会删除 Google 表格；历史运行日志仍保留，但不再计入消耗统计。`)) return;
  try {
    const data = await api(scenarioApi("scenario-2", `/pairs/${pair.id}`), { method: "DELETE" });
    state.scenarios["scenario-2"].pairs = data.pairs;
    notify("日报配对已移除");
    renderScenario2ConfigModern();
  } catch (error) { notify(error.message, "error"); }
}

async function runJob(type, triggerButton = null) {
  const button = triggerButton || (type === "run" ? runButton : previewButton);
  const scenario = state.page.startsWith("scenario2") ? "scenario-2" : "scenario-1";
  setLoading(button, true);
  try {
    const run = await api(scenarioApi(scenario, `/jobs/${type}`), { method: "POST", body: JSON.stringify({ date: dateInput.value }) });
    state.scenarios[scenario].runs.unshift(run);
    state.page = scenario === "scenario-2" ? "scenario2-overview" : "overview";
    render();
    notify(type === "run" ? `${scenario === "scenario-2" ? "配对日报" : "情景一"}正式写入任务已完成` : "预览已完成");
  } catch (error) { notify(error.message, "error"); }
  finally { setLoading(button, false); }
}

initDatePicker();
runDetailDrawerClose?.addEventListener("click", () => runDetailDrawer?.close());
runDetailDrawer?.addEventListener("click", (event) => { if (event.target === runDetailDrawer) runDetailDrawer.close(); });
rulesButton?.addEventListener("click", () => safetyRulesDialog?.showModal());
safetyRulesClose?.addEventListener("click", () => safetyRulesDialog?.close());
safetyRulesDialog?.addEventListener("click", (event) => { if (event.target === safetyRulesDialog) safetyRulesDialog.close(); });
document.querySelectorAll("[data-scenario-toggle]").forEach((button) => button.addEventListener("click", toggleScenarioAccordion));
setScenarioAccordion("scenario-1", readScenarioAccordion("scenario-1", true));
setScenarioAccordion("scenario-2", readScenarioAccordion("scenario-2", false));
sidebarScroll.addEventListener("click", (event) => {
  const button = event.target.closest(".menu-item[data-page]");
  if (button && sidebarScroll.contains(button)) navigateToPage(button);
});
previewButton.addEventListener("click", () => runJob("preview"));
runButton.addEventListener("click", () => {
  runDialogText.textContent = state.page.startsWith("scenario2")
    ? "系统将先把非空数据安全写入对应投手日报，重新读取确认后再写入总表。目标已有不同值、渠道歧义或缺少日期行时不会覆盖。"
    : "系统将重新读取所选业务日期，只写入总表中的空白目标单元格。源值为空时跳过，已有不同数值不会覆盖。";
  runDialog.showModal();
});
document.querySelector("#confirmRun").addEventListener("click", () => window.setTimeout(() => runJob("run"), 0));
collapseSidebar.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem("miulx.sidebarCollapsed", collapsed ? "1" : "0");
  collapseSidebar.setAttribute("aria-expanded", String(!collapsed));
  collapseSidebar.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
});

try {
  const data = await api("/api/bootstrap");
  state.connection = data.connection || {};
  state.scenarios = data.scenarios || {
    "scenario-1": { sources: data.sources || [], runs: data.runs || [] },
    "scenario-2": { pairs: [], runs: [] }
  };
  const connectionText = data.connection.configured ? "Google 已连接" : "等待 Google 凭据";
  document.querySelector("#connectionLabel").textContent = connectionText;
  document.querySelector("#topConnectionText").textContent = connectionText;
  document.querySelector("#connectionDot").classList.toggle("ok", data.connection.configured);
  render();
} catch (error) {
  notify(`初始化失败：${error.message}`, "error");
}

/**
 * 授权审计页（NEXORA-RBAC-011 / FR-10）：按操作者/对象/动作/时间分页筛选；detail JSON 只读展开。
 * 审计内容不含密码、token、Cookie 或任何凭据（AC-32）。
 */
import { createPager, el, renderFailureIfNeeded, renderState } from './admin.js';
import { formatTime } from './admin-users.js';

/** 动作码中文标签（稳定动作码见服务端 audit-service；此处仅为展示映射）。 */
const ACTION_LABELS = Object.freeze({
  'user.status': '用户启停',
  'user.assign_roles': '用户授权',
  'role.create': '角色新建',
  'role.update': '角色编辑',
  'role.status': '角色启停',
  'role.delete': '角色删除',
  'role.assign_permissions': '角色授权',
  'admin.bootstrap': '引导授权',
});

const RESULT_LABELS = { success: '成功', denied: '被拒绝' };

/**
 * 渲染授权审计页。
 * @param {object} container
 * @param {{doc: Document, apiFetch: Function}} ctx
 */
export async function renderAuditPage(container, ctx) {
  const { doc, apiFetch } = ctx;
  const state = { actor: '', target: '', action: '', from: '', to: '', page: 1, pageSize: 20 };

  container.textContent = '';
  container.appendChild(el(doc, 'h2', { className: 'page-title', text: '授权审计' }));

  // 筛选表单：操作者/对象/动作/时间范围（闭区间毫秒）
  const filters = el(doc, 'div', { className: 'audit-filters' });
  const actorInput = filterInput(filters, '操作者');
  const targetInput = filterInput(filters, '对象');
  const actionSelect = el(doc, 'select', { className: 'audit-filter-input' });
  actionSelect.appendChild(el(doc, 'option', { text: '全部动作', attrs: { value: '' } }));
  for (const [code, label] of Object.entries(ACTION_LABELS)) {
    actionSelect.appendChild(el(doc, 'option', { text: label, attrs: { value: code } }));
  }
  filters.appendChild(actionSelect);
  const fromInput = filterInput(filters, '起始时间', 'datetime-local');
  const toInput = filterInput(filters, '结束时间', 'datetime-local');
  const searchButton = el(doc, 'button', { className: 'pager-button', text: '筛选', attrs: { type: 'button' } });
  searchButton.addEventListener('click', () => {
    state.actor = actorInput.value.trim();
    state.target = targetInput.value.trim();
    state.action = actionSelect.value;
    state.from = fromInput.value ? String(new Date(fromInput.value).getTime()) : '';
    state.to = toInput.value ? String(new Date(toInput.value).getTime()) : '';
    state.page = 1;
    void renderTable();
  });
  filters.appendChild(searchButton);
  container.appendChild(filters);

  const tableHost = el(doc, 'div');
  container.appendChild(tableHost);

  /** 筛选输入框行。 */
  function filterInput(host, placeholder, type = 'text') {
    const input = el(doc, 'input', { className: 'audit-filter-input', attrs: { type, placeholder, maxlength: '64' } });
    host.appendChild(input);
    return input;
  }

  /** 表格 + 分页渲染。 */
  async function renderTable() {
    renderState(tableHost, doc, 'loading');
    const params = new URLSearchParams();
    if (state.actor) params.set('actor', state.actor);
    if (state.target) params.set('target', state.target);
    if (state.action) params.set('action', state.action);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    const result = await apiFetch(`/api/admin/audit-events?${params.toString()}`, { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(tableHost, doc, result)) return;
    tableHost.textContent = '';
    const items = result.body.items ?? [];
    if (items.length === 0) {
      tableHost.appendChild(el(doc, 'p', { className: 'state state-empty', text: '暂无数据' }));
    } else {
      const table = el(doc, 'table', { className: 'data-table' });
      const head = el(doc, 'tr');
      for (const title of ['时间', '操作者', '动作', '对象', '结果', '原因', '差异']) {
        head.appendChild(el(doc, 'th', { text: title }));
      }
      table.appendChild(head);
      for (const item of items) {
        const row = el(doc, 'tr');
        row.appendChild(el(doc, 'td', { text: formatTime(item.createdAt) }));
        row.appendChild(el(doc, 'td', { text: item.actorUsername }));
        row.appendChild(el(doc, 'td', { text: ACTION_LABELS[item.action] ?? item.action }));
        row.appendChild(el(doc, 'td', { text: item.targetLabel || item.targetId || '—' }));
        row.appendChild(el(doc, 'td', {
          text: RESULT_LABELS[item.result] ?? item.result,
          className: item.result === 'denied' ? 'badge-disabled-text' : 'badge-active-text',
        }));
        row.appendChild(el(doc, 'td', { text: item.reason ?? '—' }));
        const detailCell = el(doc, 'td');
        const detailText = JSON.stringify(item.detail);
        if (detailText && detailText !== '{}') {
          const toggle = el(doc, 'button', { className: 'link', text: '展开', attrs: { type: 'button' } });
          const pre = el(doc, 'pre', { className: 'audit-detail', text: JSON.stringify(item.detail, null, 2) });
          pre.hidden = true;
          toggle.addEventListener('click', () => {
            pre.hidden = !pre.hidden;
            toggle.textContent = pre.hidden ? '展开' : '收起';
          });
          detailCell.appendChild(toggle);
          detailCell.appendChild(pre);
        } else {
          detailCell.appendChild(el(doc, 'span', { className: 'muted', text: '—' }));
        }
        row.appendChild(detailCell);
        table.appendChild(row);
      }
      tableHost.appendChild(table);
    }
    tableHost.appendChild(
      createPager(doc, {
        page: state.page,
        pageSize: state.pageSize,
        total: result.body.total ?? 0,
        onPage: (page) => {
          state.page = page;
          void renderTable();
        },
      }),
    );
  }

  await renderTable();
}

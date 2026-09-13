/**
 * 用户管理页（NEXORA-RBAC-011 / FR-02/FR-06）：列表/搜索/分页/详情/启停/角色授权。
 * 四态反馈完整；启停与授权按钮按权限渲染（服务端守卫仍为唯一权威）；
 * 角色授权：可选角色全选/取消全选、已选计数、保存原子化、回显以服务端详情为准（AC-21）。
 */
import { createPager, createSearchBox, el, renderFailureIfNeeded, renderState } from './admin.js';

/** 状态徽标文案。 */
const STATUS_LABEL = { active: '启用', disabled: '禁用' };

/**
 * 渲染用户管理页。
 * @param {object} container 内容容器
 * @param {{doc: Document, apiFetch: Function, hasPermission: (key:string)=>boolean}} ctx
 */
export async function renderUsersPage(container, ctx) {
  const { doc, apiFetch } = ctx;
  const state = { q: '', page: 1, pageSize: 20, detail: null };

  await renderList();

  /** 列表视图（含搜索/分页/四态）。 */
  async function renderList() {
    renderState(container, doc, 'loading');
    const qs = `?q=${encodeURIComponent(state.q)}&page=${state.page}&pageSize=${state.pageSize}`;
    const result = await apiFetch(`/api/admin/users${qs}`, { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(container, doc, result)) return;
    container.textContent = '';
    container.appendChild(el(doc, 'h2', { className: 'page-title', text: '用户管理' }));
    container.appendChild(
      createSearchBox(doc, {
        value: state.q,
        placeholder: '按用户名搜索',
        onSearch: (q) => {
          state.q = q;
          state.page = 1;
          void renderList();
        },
      }),
    );
    const items = result.body.items ?? [];
    if (items.length === 0) {
      container.appendChild(el(doc, 'p', { className: 'state state-empty', text: '暂无数据' }));
    } else {
      const table = el(doc, 'table', { className: 'data-table' });
      const head = el(doc, 'tr');
      for (const title of ['用户名', '状态', '角色', '创建时间', '操作']) {
        head.appendChild(el(doc, 'th', { text: title }));
      }
      table.appendChild(head);
      for (const user of items) {
        const row = el(doc, 'tr');
        row.appendChild(el(doc, 'td', { text: user.username }));
        row.appendChild(statusBadge(user.status));
        const roleCell = el(doc, 'td');
        if (user.roles.length === 0) roleCell.appendChild(el(doc, 'span', { className: 'muted', text: '（无角色）' }));
        for (const role of user.roles) roleCell.appendChild(roleBadge(role));
        row.appendChild(roleCell);
        row.appendChild(el(doc, 'td', { text: formatTime(user.createdAt) }));
        const actionCell = el(doc, 'td');
        const detailButton = el(doc, 'button', { className: 'link', text: '详情', attrs: { type: 'button' } });
        detailButton.addEventListener('click', () => {
          state.detail = user.username;
          void renderDetail();
        });
        actionCell.appendChild(detailButton);
        row.appendChild(actionCell);
        table.appendChild(row);
      }
      container.appendChild(table);
    }
    container.appendChild(
      createPager(doc, {
        page: state.page,
        pageSize: state.pageSize,
        total: result.body.total ?? 0,
        onPage: (page) => {
          state.page = page;
          void renderList();
        },
      }),
    );
  }

  /** 详情视图：基础信息 + 启停操作 + 角色授权。 */
  async function renderDetail() {
    renderState(container, doc, 'loading');
    const result = await apiFetch(`/api/admin/users/${encodeURIComponent(state.detail)}`, { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(container, doc, result)) return;
    const user = result.body.user;
    container.textContent = '';
    const back = el(doc, 'button', { className: 'link', text: '← 返回列表', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      state.detail = null;
      void renderList();
    });
    container.appendChild(back);
    container.appendChild(el(doc, 'h2', { className: 'page-title', text: `用户详情：${user.username}` }));
    const info = el(doc, 'div', { className: 'detail-block' });
    info.appendChild(el(doc, 'p', { text: `用户名：${user.username}` }));
    const statusLine = el(doc, 'p', { text: '状态：' });
    statusLine.appendChild(statusBadge(user.status));
    info.appendChild(statusLine);
    info.appendChild(el(doc, 'p', { text: `创建时间：${formatTime(user.createdAt)}` }));
    const rolesLine = el(doc, 'p', { text: '已绑角色：' });
    if (user.roles.length === 0) rolesLine.appendChild(el(doc, 'span', { className: 'muted', text: '（无角色）' }));
    for (const role of user.roles) rolesLine.appendChild(roleBadge(role));
    info.appendChild(rolesLine);
    container.appendChild(info);

    const feedback = el(doc, 'p', { className: 'error', attrs: { role: 'alert' } });
    feedback.hidden = true;
    container.appendChild(feedback);

    // 启停操作（按权限渲染入口）
    if (ctx.hasPermission('user:status')) {
      const next = user.status === 'active' ? 'disabled' : 'active';
      const toggle = el(doc, 'button', {
        className: 'primary action-button',
        text: user.status === 'active' ? '禁用该用户' : '启用该用户',
        attrs: { type: 'button' },
      });
      toggle.addEventListener('click', async () => {
        if (!ctx.confirm(`确认${user.status === 'active' ? '禁用' : '启用'}用户 ${user.username}？禁用将立即使其全部会话失效。`)) return;
        toggle.disabled = true;
        const res = await apiFetch(`/api/admin/users/${encodeURIComponent(user.username)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: next }),
        }, { protectedCall: true });
        toggle.disabled = false;
        if (res.status === 200) {
          await renderDetail(); // 回显以服务端为准
          return;
        }
        showFeedback(feedback, res);
      });
      container.appendChild(toggle);
    }

    // 角色授权（按权限渲染入口）
    if (ctx.hasPermission('user:assign_roles')) {
      container.appendChild(await buildRoleAssigner(user, feedback));
    }
  }

  /**
   * 角色授权面板：全部启用角色复选（已选含禁用角色时显示禁用徽标且保留勾选）、
   * 全选/取消全选、已选计数、保存/取消（§8.3）。
   */
  async function buildRoleAssigner(user, feedback) {
    const block = el(doc, 'div', { className: 'detail-block' });
    block.appendChild(el(doc, 'h3', { className: 'block-title', text: '角色授权' }));
    const listHost = el(doc, 'div');
    block.appendChild(listHost);
    renderState(listHost, doc, 'loading');
    const result = await apiFetch('/api/admin/roles/enabled', { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(listHost, doc, result)) return block;
    const enabledRoles = result.body.items ?? [];
    // 可选集合 = 全部启用角色 ∪ 用户已绑定的禁用角色（徽标提示，保留勾选）
    const boundDisabled = user.roles.filter((role) => role.status !== 'active');
    const options = [...enabledRoles, ...boundDisabled.filter((r) => !enabledRoles.some((e) => e.id === r.id))];
    const checked = new Set(user.roles.map((role) => role.id));

    listHost.textContent = '';
    const counter = el(doc, 'p', { className: 'muted' });
    const updateCounter = () => {
      counter.textContent = `已选 ${checked.size} 个角色`;
    };
    const toolbar = el(doc, 'div', { className: 'tree-toolbar' });
    const selectAllButton = el(doc, 'button', { className: 'pager-button', text: '全选', attrs: { type: 'button' } });
    selectAllButton.addEventListener('click', () => {
      for (const role of options) checked.add(role.id);
      renderOptions();
    });
    const clearAllButton = el(doc, 'button', { className: 'pager-button', text: '取消全选', attrs: { type: 'button' } });
    clearAllButton.addEventListener('click', () => {
      checked.clear();
      renderOptions();
    });
    toolbar.appendChild(selectAllButton);
    toolbar.appendChild(clearAllButton);
    listHost.appendChild(toolbar);
    const optionsHost = el(doc, 'div', { className: 'check-list' });
    listHost.appendChild(optionsHost);
    listHost.appendChild(counter);

    function renderOptions() {
      optionsHost.textContent = '';
      for (const role of options) {
        const label = el(doc, 'label', { className: 'check-item' });
        const box = el(doc, 'input', { attrs: { type: 'checkbox' } });
        box.checked = checked.has(role.id);
        box.addEventListener('change', () => {
          if (box.checked) checked.add(role.id);
          else checked.delete(role.id);
          updateCounter();
        });
        label.appendChild(box);
        label.appendChild(el(doc, 'span', { text: `${role.name}（${role.key}）` }));
        if (role.status !== 'active') label.appendChild(el(doc, 'span', { className: 'badge badge-disabled', text: '已禁用' }));
        optionsHost.appendChild(label);
      }
      updateCounter();
    }
    renderOptions();

    const actions = el(doc, 'div', { className: 'tree-actions' });
    const save = el(doc, 'button', { className: 'primary action-button', text: '保存', attrs: { type: 'button' } });
    save.addEventListener('click', async () => {
      save.disabled = true;
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(user.username)}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds: [...checked].sort((a, b) => a - b) }),
      }, { protectedCall: true });
      save.disabled = false;
      if (res.status === 200) {
        await renderDetail(); // 保存后按服务端详情重建回显（AC-21）
        return;
      }
      showFeedback(feedback, res);
    });
    const cancel = el(doc, 'button', { className: 'pager-button', text: '取消', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => void renderDetail()); // 取消：丢弃编辑态，按详情重建
    actions.appendChild(save);
    actions.appendChild(cancel);
    listHost.appendChild(actions);
    return block;
  }

  /** 状态徽标。 */
  function statusBadge(status) {
    return el(doc, 'span', {
      className: `badge ${status === 'active' ? 'badge-active' : 'badge-disabled'}`,
      text: STATUS_LABEL[status] ?? status,
    });
  }

  /** 角色徽标（禁用角色带禁用样式）。 */
  function roleBadge(role) {
    return el(doc, 'span', {
      className: `badge ${role.status === 'active' ? 'badge-role' : 'badge-disabled'}`,
      text: role.name,
    });
  }
}

/** 操作失败反馈（400 字段级 / 403 / 409 / 网络），文案取服务端 message。 */
export function showFeedback(elTarget, res) {
  let message = '操作失败，请稍后重试';
  if (res.networkError) message = '网络异常，请检查连接后重试';
  else if (res.body && res.body.error) {
    const fields = res.body.error.fields;
    message = fields ? Object.values(fields).join('；') : res.body.error.message;
  }
  elTarget.textContent = message;
  elTarget.hidden = false;
}

/** 毫秒时间戳格式化（本地时区）。 */
export function formatTime(ms) {
  if (typeof ms !== 'number') return '';
  return new Date(ms).toLocaleString();
}

/**
 * 角色管理页（NEXORA-RBAC-011 / FR-03/FR-05）+ 权限树组件。
 * 权限树状态机为纯函数导出（§8.2，DOM 替身测试直接覆盖 AC-15~AC-18 语义）：
 * 树深 2 层（模块组→权限叶子）；父子联动/半选态；全选全部/取消全选（恒显，作用于全部目录）与
 * 全选当前结果/取消当前结果（仅搜索态，作用于可见匹配、保留筛选外已选）四按钮语义明确分离；
 * 分组节点仅组织展示，不是权限本身；保存为服务端校验后的原子替换，回显以服务端详情为准。
 */
import { createPager, createSearchBox, el, renderFailureIfNeeded, renderState } from './admin.js';
import { formatTime, showFeedback } from './admin-users.js';

/**
 * 权限树状态机（纯函数；catalog 为 GET /api/admin/permissions 的 groups 形状）。
 * @param {Array<{module:string, name:string, items:Array<{key:string, name:string, description:string}>}>} catalog
 * @param {string[]} [initialChecked] 回显初始已选（目录外 key 被忽略——目录为唯一权威）
 */
export function createTreeState(catalog, initialChecked = []) {
  const allKeys = catalog.flatMap((group) => group.items.map((item) => item.key));
  const itemByKey = new Map();
  for (const group of catalog) {
    for (const item of group.items) itemByKey.set(item.key, { ...item, module: group.module });
  }
  const checked = new Set([...initialChecked].filter((key) => itemByKey.has(key)));
  let filter = '';

  /** 叶子是否匹配当前筛选（key/名称/说明，大小写不敏感子串）。 */
  function matches(item) {
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return (
      item.key.toLowerCase().includes(needle) ||
      item.name.toLowerCase().includes(needle) ||
      (item.description ?? '').toLowerCase().includes(needle)
    );
  }

  return {
    /** 当前筛选串。 */
    get filter() {
      return filter;
    },
    /** 设置筛选串。 */
    setFilter(value) {
      filter = String(value ?? '');
    },
    /** 目录全部 key（按目录顺序）。 */
    allKeys: () => [...allKeys],
    /** 当前可见匹配叶子集合 V（空筛选 = 全部）。 */
    visibleKeys: () => allKeys.filter((key) => matches(itemByKey.get(key))),
    /** 渲染用分组视图：组内仅含可见叶子；无可见叶子的组不返回。 */
    visibleGroups() {
      const groups = [];
      for (const group of catalog) {
        const items = group.items.filter((item) => matches(item));
        if (items.length > 0) groups.push({ module: group.module, name: group.name, items });
      }
      return groups;
    },
    /** 叶子勾选态。 */
    isChecked: (key) => checked.has(key),
    /** 勾选/取消叶子。 */
    toggleLeaf(key) {
      if (!itemByKey.has(key)) return;
      if (checked.has(key)) checked.delete(key);
      else checked.add(key);
    },
    /** 组勾选态（对该组全部叶子）：全选→checked；部分→indeterminate（半选）；无→unchecked。 */
    groupState(module) {
      const group = catalog.find((g) => g.module === module);
      if (!group || group.items.length === 0) return 'unchecked';
      const hit = group.items.filter((item) => checked.has(item.key)).length;
      if (hit === 0) return 'unchecked';
      return hit === group.items.length ? 'checked' : 'indeterminate';
    },
    /** 父子联动：组全选 ⇄ 全清（只影响该组叶子）。 */
    toggleGroup(module) {
      const group = catalog.find((g) => g.module === module);
      if (!group) return;
      const allOn = group.items.every((item) => checked.has(item.key));
      for (const item of group.items) {
        if (allOn) checked.delete(item.key);
        else checked.add(item.key);
      }
    },
    /** 「全选全部」：checked = 全部目录 key（恒显入口）。 */
    selectAll() {
      for (const key of allKeys) checked.add(key);
    },
    /** 「取消全选」：checked = ∅（恒显入口）。 */
    clearAll() {
      checked.clear();
    },
    /** 「全选当前结果」：checked ∪= V，仅搜索态显示；保留筛选外已选（AC-17）。 */
    selectVisible() {
      for (const key of this.visibleKeys()) checked.add(key);
    },
    /** 「取消当前结果」：checked -= V，仅搜索态显示；筛选外已选不受影响（AC-17）。 */
    clearVisible() {
      for (const key of this.visibleKeys()) checked.delete(key);
    },
    /** 已选计数。 */
    count: () => checked.size,
    /** 提交载荷：排序后的已选 key 数组。 */
    checkedKeys: () => [...checked].sort(),
  };
}

/**
 * 渲染角色管理页。
 * @param {object} container
 * @param {{doc: Document, apiFetch: Function, hasPermission: (key:string)=>boolean, confirm: (msg:string)=>boolean}} ctx
 */
export async function renderRolesPage(container, ctx) {
  const { doc, apiFetch } = ctx;
  const state = { q: '', page: 1, pageSize: 20, detailId: null, creating: false };

  await renderList();

  /** 列表视图。 */
  async function renderList() {
    renderState(container, doc, 'loading');
    const result = await apiFetch(
      `/api/admin/roles?q=${encodeURIComponent(state.q)}&page=${state.page}&pageSize=${state.pageSize}`,
      { method: 'GET' },
      { protectedCall: true },
    );
    if (renderFailureIfNeeded(container, doc, result)) return;
    container.textContent = '';
    const titleRow = el(doc, 'div', { className: 'page-title-row' });
    titleRow.appendChild(el(doc, 'h2', { className: 'page-title', text: '角色管理' }));
    if (ctx.hasPermission('role:create')) {
      const createButton = el(doc, 'button', { className: 'primary action-button', text: '新建角色', attrs: { type: 'button' } });
      createButton.addEventListener('click', () => {
        state.creating = true;
        void renderCreate();
      });
      titleRow.appendChild(createButton);
    }
    container.appendChild(titleRow);
    container.appendChild(
      createSearchBox(doc, {
        value: state.q,
        placeholder: '按名称或标识搜索',
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
      for (const title of ['名称', '唯一标识', '状态', '权限数', '绑定用户', '更新时间', '操作']) {
        head.appendChild(el(doc, 'th', { text: title }));
      }
      table.appendChild(head);
      for (const role of items) {
        const row = el(doc, 'tr');
        const nameCell = el(doc, 'td');
        nameCell.appendChild(el(doc, 'span', { text: role.name }));
        if (role.isBuiltin) nameCell.appendChild(el(doc, 'span', { className: 'badge badge-builtin', text: '内置' }));
        row.appendChild(nameCell);
        row.appendChild(el(doc, 'td', { text: role.key }));
        row.appendChild(el(doc, 'td', {
          text: role.status === 'active' ? '启用' : '禁用',
          className: role.status === 'active' ? 'badge-active-text' : 'badge-disabled-text',
        }));
        row.appendChild(el(doc, 'td', { text: String(role.permissionCount) }));
        row.appendChild(el(doc, 'td', { text: String(role.userCount) }));
        row.appendChild(el(doc, 'td', { text: formatTime(role.updatedAt) }));
        const actionCell = el(doc, 'td');
        const detail = el(doc, 'button', { className: 'link', text: '详情', attrs: { type: 'button' } });
        detail.addEventListener('click', () => {
          state.detailId = role.id;
          void renderDetail();
        });
        actionCell.appendChild(detail);
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

  /** 新建角色表单。 */
  async function renderCreate() {
    container.textContent = '';
    const back = el(doc, 'button', { className: 'link', text: '← 返回列表', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      state.creating = false;
      void renderList();
    });
    container.appendChild(back);
    container.appendChild(el(doc, 'h2', { className: 'page-title', text: '新建角色' }));
    const feedback = el(doc, 'p', { className: 'error', attrs: { role: 'alert' } });
    feedback.hidden = true;
    const form = buildRoleForm({ name: '', key: '', description: '' }, async (value) => {
      const res = await apiFetch('/api/admin/roles', {
        method: 'POST',
        body: JSON.stringify(value),
      }, { protectedCall: true });
      if (res.status === 201) {
        state.creating = false;
        state.detailId = res.body.role.id;
        await renderDetail();
        return true;
      }
      showFeedback(feedback, res);
      return false;
    });
    container.appendChild(form);
    container.appendChild(feedback);
  }

  /** 详情视图：信息/编辑/启停/删除 + 授权树。 */
  async function renderDetail() {
    renderState(container, doc, 'loading');
    const result = await apiFetch(`/api/admin/roles/${state.detailId}`, { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(container, doc, result)) return;
    const role = result.body.role;
    container.textContent = '';
    const back = el(doc, 'button', { className: 'link', text: '← 返回列表', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      state.detailId = null;
      void renderList();
    });
    container.appendChild(back);
    const title = el(doc, 'h2', { className: 'page-title', text: `角色详情：${role.name}` });
    container.appendChild(title);
    if (role.isBuiltin) {
      container.appendChild(
        el(doc, 'p', { className: 'notice-inline', text: '内置超级管理员角色：拥有全部权限，受保护不可编辑/删除/禁用' }),
      );
    }
    const info = el(doc, 'div', { className: 'detail-block' });
    info.appendChild(el(doc, 'p', { text: `唯一标识：${role.key}` }));
    info.appendChild(el(doc, 'p', { text: `状态：${role.status === 'active' ? '启用' : '禁用'}` }));
    info.appendChild(el(doc, 'p', { text: `说明：${role.description || '（无）'}` }));
    info.appendChild(el(doc, 'p', { text: `绑定用户数：${role.boundUsers}` }));
    info.appendChild(el(doc, 'p', { text: `创建时间：${formatTime(role.createdAt)}；更新时间：${formatTime(role.updatedAt)}` }));
    container.appendChild(info);

    const feedback = el(doc, 'p', { className: 'error', attrs: { role: 'alert' } });
    feedback.hidden = true;
    container.appendChild(feedback);

    if (!role.isBuiltin) {
      // 编辑（role:update）
      if (ctx.hasPermission('role:update')) {
        const editBlock = el(doc, 'div', { className: 'detail-block' });
        editBlock.appendChild(el(doc, 'h3', { className: 'block-title', text: '编辑角色' }));
        editBlock.appendChild(
          buildRoleForm({ name: role.name, key: role.key, description: role.description }, async (value) => {
            const res = await apiFetch(`/api/admin/roles/${role.id}`, {
              method: 'PUT',
              body: JSON.stringify(value),
            }, { protectedCall: true });
            if (res.status === 200) {
              await renderDetail();
              return true;
            }
            showFeedback(feedback, res);
            return false;
          }),
        );
        container.appendChild(editBlock);

        // 启停（role:update）
        const next = role.status === 'active' ? 'disabled' : 'active';
        const toggle = el(doc, 'button', {
          className: 'pager-button action-button',
          text: role.status === 'active' ? '禁用该角色' : '启用该角色',
          attrs: { type: 'button' },
        });
        toggle.addEventListener('click', async () => {
          if (!ctx.confirm(`确认${role.status === 'active' ? '禁用' : '启用'}角色 ${role.name}？禁用后持有该角色用户的对应权限立即失效。`)) return;
          const res = await apiFetch(`/api/admin/roles/${role.id}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: next }),
          }, { protectedCall: true });
          if (res.status === 200) await renderDetail();
          else showFeedback(feedback, res);
        });
        container.appendChild(toggle);
      }

      // 删除（role:delete）
      if (ctx.hasPermission('role:delete')) {
        const remove = el(doc, 'button', { className: 'pager-button action-button danger', text: '删除该角色', attrs: { type: 'button' } });
        remove.addEventListener('click', async () => {
          if (!ctx.confirm(`确认删除角色 ${role.name}？已绑定用户的角色无法删除。`)) return;
          const res = await apiFetch(`/api/admin/roles/${role.id}`, { method: 'DELETE' }, { protectedCall: true });
          if (res.status === 200) {
            state.detailId = null;
            await renderList();
            return;
          }
          showFeedback(feedback, res); // 409 role_in_use 文案含绑定数量与示例用户
        });
        container.appendChild(remove);
      }
    }

    // 授权树（内置角色只读展示；自定义角色按 role:assign_permissions 渲染保存入口）
    const treeBlock = el(doc, 'div', { className: 'detail-block' });
    treeBlock.appendChild(el(doc, 'h3', { className: 'block-title', text: '角色授权（权限树）' }));
    container.appendChild(treeBlock);
    await renderPermissionTree(treeBlock, role, role.isBuiltin || !ctx.hasPermission('role:assign_permissions'));
  }

  /**
   * 权限树组件：数据源 GET /api/admin/permissions；回显源角色详情 permissionKeys；
   * 四按钮 + 搜索 + 计数 + 保存/取消；readonly 模式禁用全部交互（内置角色或无权限）。
   */
  async function renderPermissionTree(host, role, readonly) {
    const treeHost = el(doc, 'div');
    host.appendChild(treeHost);
    renderState(treeHost, doc, 'loading');
    const catalogResult = await apiFetch('/api/admin/permissions', { method: 'GET' }, { protectedCall: true });
    if (renderFailureIfNeeded(treeHost, doc, catalogResult)) return;
    const groups = catalogResult.body.groups ?? [];
    const tree = createTreeState(groups, role.permissionKeys ?? []);

    treeHost.textContent = '';
    const feedback = el(doc, 'p', { className: 'error', attrs: { role: 'alert' } });
    feedback.hidden = true;

    // 工具栏：搜索 + 四按钮 + 计数
    const toolbar = el(doc, 'div', { className: 'tree-toolbar' });
    const searchInput = el(doc, 'input', { className: 'search-input', attrs: { type: 'text', placeholder: '搜索权限 key / 名称 / 说明', maxlength: '64' } });
    searchInput.disabled = readonly;
    searchInput.addEventListener('input', () => {
      tree.setFilter(searchInput.value.trim());
      renderTree();
      renderScopedButtons();
    });
    toolbar.appendChild(searchInput);
    const selectAllBtn = toolbarButton('全选全部', () => { tree.selectAll(); renderTree(); });
    const clearAllBtn = toolbarButton('取消全选', () => { tree.clearAll(); renderTree(); });
    toolbar.appendChild(selectAllBtn);
    toolbar.appendChild(clearAllBtn);
    const scopedHost = el(doc, 'span', { className: 'tree-toolbar-scoped' });
    toolbar.appendChild(scopedHost);
    const counter = el(doc, 'span', { className: 'muted tree-counter' });
    toolbar.appendChild(counter);
    treeHost.appendChild(toolbar);
    treeHost.appendChild(feedback);
    const bodyHost = el(doc, 'div', { className: 'tree-body' });
    treeHost.appendChild(bodyHost);

    function toolbarButton(label, onClick) {
      const button = el(doc, 'button', { className: 'pager-button', text: label, attrs: { type: 'button' } });
      button.disabled = readonly;
      button.addEventListener('click', onClick);
      return button;
    }

    /** 「全选当前结果/取消当前结果」仅搜索态显示（AC-17）。 */
    function renderScopedButtons() {
      scopedHost.textContent = '';
      if (!tree.filter) return;
      const selectVisibleBtn = toolbarButton('全选当前结果', () => { tree.selectVisible(); renderTree(); });
      const clearVisibleBtn = toolbarButton('取消当前结果', () => { tree.clearVisible(); renderTree(); });
      scopedHost.appendChild(selectVisibleBtn);
      scopedHost.appendChild(clearVisibleBtn);
    }

    /** 树体渲染：组头复选（半选态）+ 叶子复选；分组节点仅组织展示。 */
    function renderTree() {
      bodyHost.textContent = '';
      const visibleGroups = tree.visibleGroups();
      if (visibleGroups.length === 0) {
        bodyHost.appendChild(el(doc, 'p', { className: 'state state-empty', text: '暂无数据' }));
      }
      for (const group of visibleGroups) {
        const groupBlock = el(doc, 'div', { className: 'tree-group' });
        const groupLabel = el(doc, 'label', { className: 'tree-group-label' });
        const groupBox = el(doc, 'input', { attrs: { type: 'checkbox' } });
        const groupState = tree.groupState(group.module);
        groupBox.checked = groupState === 'checked';
        groupBox.indeterminate = groupState === 'indeterminate';
        groupBox.disabled = readonly;
        groupBox.addEventListener('change', () => {
          tree.toggleGroup(group.module);
          renderTree();
        });
        groupLabel.appendChild(groupBox);
        groupLabel.appendChild(el(doc, 'strong', { text: group.name }));
        groupBlock.appendChild(groupLabel);
        const leaves = el(doc, 'div', { className: 'tree-leaves' });
        for (const item of group.items) {
          const leaf = el(doc, 'label', { className: 'tree-leaf' });
          const box = el(doc, 'input', { attrs: { type: 'checkbox' } });
          box.checked = tree.isChecked(item.key);
          box.disabled = readonly;
          box.addEventListener('change', () => {
            tree.toggleLeaf(item.key);
            renderTree();
          });
          leaf.appendChild(box);
          leaf.appendChild(el(doc, 'span', { className: 'tree-leaf-name', text: item.name }));
          leaf.appendChild(el(doc, 'span', { className: 'muted', text: `${item.key} · ${item.description}` }));
          leaves.appendChild(leaf);
        }
        groupBlock.appendChild(leaves);
        bodyHost.appendChild(groupBlock);
      }
      counter.textContent = `已选 ${tree.count()} 项权限`;
    }

    renderTree();
    renderScopedButtons();

    if (!readonly) {
      const actions = el(doc, 'div', { className: 'tree-actions' });
      const save = el(doc, 'button', { className: 'primary action-button', text: '保存', attrs: { type: 'button' } });
      save.addEventListener('click', async () => {
        save.disabled = true;
        const res = await apiFetch(`/api/admin/roles/${role.id}/permissions`, {
          method: 'PUT',
          body: JSON.stringify({ permissionKeys: tree.checkedKeys() }),
        }, { protectedCall: true });
        save.disabled = false;
        if (res.status === 200) {
          await renderDetail(); // 保存成功：按服务端详情重建，回显与数据库一致（AC-18）
          return;
        }
        showFeedback(feedback, res);
      });
      const cancel = el(doc, 'button', { className: 'pager-button', text: '取消', attrs: { type: 'button' } });
      cancel.addEventListener('click', () => void renderDetail()); // 取消：丢弃编辑态，按详情重建
      actions.appendChild(save);
      actions.appendChild(cancel);
      treeHost.appendChild(actions);
    }
  }

  /**
   * 角色表单（名称/唯一标识/说明；新建与编辑共用）。
   * @param {{name:string, key:string, description:string}} initial
   * @param {(value:{name:string,key:string,description:string})=>Promise<boolean>} onSubmit 返回是否成功
   */
  function buildRoleForm(initial, onSubmit) {
    const form = el(doc, 'form', { className: 'role-form', attrs: { novalidate: 'novalidate' } });
    const nameInput = formField(form, '名称', 'text', initial.name);
    const keyInput = formField(form, '唯一标识（小写字母开头，字母/数字/下划线）', 'text', initial.key);
    const descInput = formField(form, '说明', 'text', initial.description);
    const submit = el(doc, 'button', { className: 'primary action-button', text: '提交', attrs: { type: 'submit' } });
    form.appendChild(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      await onSubmit({ name: nameInput.value, key: keyInput.value, description: descInput.value });
      submit.disabled = false;
    });
    return form;
  }

  /** 表单字段行。 */
  function formField(form, label, type, value) {
    const wrap = el(doc, 'label', { className: 'field' });
    wrap.appendChild(el(doc, 'span', { className: 'field-label', text: label }));
    const input = el(doc, 'input', { attrs: { type } });
    input.value = value;
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  }
}

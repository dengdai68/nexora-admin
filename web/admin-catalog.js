/**
 * 权限目录页（NEXORA-RBAC-011 / FR-04）：模块/页面/操作分组树，只读浏览与搜索。
 * 每项展示稳定 key、名称、说明、关联页面与 API；目录由代码/版本化种子维护，页面不提供任何创建入口（R-08）。
 */
import { el, renderFailureIfNeeded, renderState } from './admin.js';

/**
 * 渲染权限目录页。
 * @param {object} container
 * @param {{doc: Document, apiFetch: Function}} ctx
 */
export async function renderCatalogPage(container, ctx) {
  const { doc, apiFetch } = ctx;
  renderState(container, doc, 'loading');
  const result = await apiFetch('/api/admin/permissions', { method: 'GET' }, { protectedCall: true });
  if (renderFailureIfNeeded(container, doc, result)) return;
  const groups = result.body.groups ?? [];

  container.textContent = '';
  container.appendChild(el(doc, 'h2', { className: 'page-title', text: '权限目录' }));
  container.appendChild(
    el(doc, 'p', { className: 'muted', text: '目录由系统功能版本化维护，只读浏览；分组节点仅组织展示，不代表可授予权限。' }),
  );
  const search = el(doc, 'input', { className: 'search-input', attrs: { type: 'text', placeholder: '搜索 key / 名称 / 说明', maxlength: '64' } });
  container.appendChild(search);
  const body = el(doc, 'div', { className: 'tree-body' });
  container.appendChild(body);

  /** 按搜索串过滤渲染（key/名称/说明大小写不敏感子串）。 */
  function render() {
    const needle = search.value.trim().toLowerCase();
    body.textContent = '';
    let shown = 0;
    for (const group of groups) {
      const items = group.items.filter(
        (item) =>
          !needle ||
          item.key.toLowerCase().includes(needle) ||
          item.name.toLowerCase().includes(needle) ||
          (item.description ?? '').toLowerCase().includes(needle),
      );
      if (items.length === 0) continue;
      shown += items.length;
      const block = el(doc, 'div', { className: 'tree-group' });
      block.appendChild(el(doc, 'p', { className: 'tree-group-title', text: group.name }));
      for (const item of items) {
        const row = el(doc, 'div', { className: 'catalog-item' });
        row.appendChild(el(doc, 'p', { className: 'catalog-item-head', text: `${item.name}（${item.key}）` }));
        row.appendChild(el(doc, 'p', { className: 'muted', text: item.description }));
        row.appendChild(el(doc, 'p', { className: 'muted', text: `关联页面：${item.page || '—'}` }));
        row.appendChild(el(doc, 'p', { className: 'muted', text: `关联 API：${(item.apis ?? []).join('、') || '—'}` }));
        block.appendChild(row);
      }
      body.appendChild(block);
    }
    if (shown === 0) body.appendChild(el(doc, 'p', { className: 'state state-empty', text: '暂无数据' }));
  }

  search.addEventListener('input', render);
  render();
}

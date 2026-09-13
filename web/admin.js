/**
 * 后台管理壳（NEXORA-RBAC-011 / 架构 §1.1/§3.5，AD-10）：
 * 导航按当前权限渲染（用户管理←user:read，角色管理←role:read，权限目录←permission:read，授权审计←audit:read）；
 * hash 视图路由（#/admin/users|roles|catalog|audit）；四态组件（加载中/空/失败/无权限）；
 * 分页与搜索受控组件供四个页面复用（避免重复实现）。
 * 全部动态文本经 textContent/createElement 写入，禁止 innerHTML 拼接（XSS 防线，AC-31）。
 * 核心逻辑导出以便 DOM 替身测试；不在模块加载时产生副作用。
 */
import { renderUsersPage } from './admin-users.js';
import { renderRolesPage } from './admin-roles.js';
import { renderCatalogPage } from './admin-catalog.js';
import { renderAuditPage } from './admin-audit.js';

/** 管理视图注册表（导航与路由的唯一权威；permission 决定可见性与直达准入）。 */
export const ADMIN_VIEWS = Object.freeze([
  Object.freeze({ id: 'users', title: '用户管理', permission: 'user:read', render: renderUsersPage }),
  Object.freeze({ id: 'roles', title: '角色管理', permission: 'role:read', render: renderRolesPage }),
  Object.freeze({ id: 'catalog', title: '权限目录', permission: 'permission:read', render: renderCatalogPage }),
  Object.freeze({ id: 'audit', title: '授权审计', permission: 'audit:read', render: renderAuditPage }),
]);

/**
 * DOM 元素构造助手：createElement + textContent + 白名单属性（AD-10；不触碰 innerHTML）。
 * @param {Document} doc
 * @param {string} tag
 * @param {{className?:string, text?:string, attrs?:Record<string,string>, children?:Array<Node>}} [options]
 */
export function el(doc, tag, options = {}) {
  const node = doc.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value);
  }
  for (const child of options.children ?? []) node.appendChild(child);
  return node;
}

/** 四态文案（全中文，AC-03）。 */
export const STATE_MESSAGES = Object.freeze({
  loading: '加载中…',
  empty: '暂无数据',
  error: '加载失败，请稍后重试',
  forbidden: '无权限：您没有查看该内容的权限',
});

/**
 * 渲染四态之一到容器（加载中/空/失败/无权限）。
 * @param {object} container
 * @param {Document} doc
 * @param {'loading'|'empty'|'error'|'forbidden'} state
 * @param {string} [message] 覆盖默认文案
 */
export function renderState(container, doc, state, message) {
  container.textContent = '';
  container.appendChild(el(doc, 'p', { className: `state state-${state}`, text: message ?? STATE_MESSAGES[state] }));
}

/**
 * 分页组件：上一页/下一页 + 页码信息；受控（回调驱动外部刷新）。
 * @param {Document} doc
 * @param {{page:number, pageSize:number, total:number, onPage:(page:number)=>void}} options
 */
export function createPager(doc, { page, pageSize, total, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const wrap = el(doc, 'div', { className: 'pager' });
  const prev = el(doc, 'button', { className: 'pager-button', text: '上一页', attrs: { type: 'button' } });
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => onPage(page - 1));
  const next = el(doc, 'button', { className: 'pager-button', text: '下一页', attrs: { type: 'button' } });
  next.disabled = page >= totalPages;
  next.addEventListener('click', () => onPage(page + 1));
  wrap.appendChild(prev);
  wrap.appendChild(el(doc, 'span', { className: 'pager-info', text: `第 ${page} / ${totalPages} 页 · 共 ${total} 条` }));
  wrap.appendChild(next);
  return wrap;
}

/**
 * 搜索组件：输入框 + 搜索按钮（Enter 触发）；受控。
 * @param {Document} doc
 * @param {{value:string, placeholder:string, onSearch:(q:string)=>void}} options
 */
export function createSearchBox(doc, { value, placeholder, onSearch }) {
  const wrap = el(doc, 'div', { className: 'search-box' });
  const input = el(doc, 'input', { className: 'search-input', attrs: { type: 'text', placeholder, maxlength: '64' } });
  input.value = value;
  const button = el(doc, 'button', { className: 'pager-button', text: '搜索', attrs: { type: 'button' } });
  const fire = () => onSearch(input.value.trim());
  button.addEventListener('click', fire);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') fire();
  });
  wrap.appendChild(input);
  wrap.appendChild(button);
  return wrap;
}

/**
 * 通用结果态处理：网络错误 → 失败态；401 已由 apiFetch 统一切登录；403 → 无权限态；其余异常 → 失败态。
 * @returns {boolean} true 表示已渲染终态（调用方应停止后续渲染）
 */
export function renderFailureIfNeeded(container, doc, result) {
  if (result.networkError) {
    renderState(container, doc, 'error');
    return true;
  }
  if (result.status === 403) {
    renderState(container, doc, 'forbidden');
    return true;
  }
  if (result.status !== 200) {
    renderState(container, doc, 'error');
    return true;
  }
  return false;
}

/**
 * 初始化管理壳。
 * @param {Document} doc
 * @param {Function} apiFetch app.js 的统一 fetch 封装（已注入 CSRF 头、401 回登录）
 * @param {{onLogout?: () => void, onBack?: () => void}} [hooks]
 * @returns {{enter:(permissions:string[])=>void, navigate:(viewId:string)=>void}}
 */
export function initAdmin(doc, apiFetch, hooks = {}) {
  const nav = doc.getElementById('admin-nav');
  const content = doc.getElementById('admin-content');
  let permissions = new Set();
  let currentView = null;
  let suppressHashSync = false;
  /** 渲染世代号（DEF-02 并发防护）：每次 renderView 递增，仅最新世代允许写回内容容器。 */
  let renderGeneration = 0;

  const ctx = {
    doc,
    apiFetch,
    hasPermission: (key) => permissions.has(key),
    // 危险操作确认：浏览器用原生 confirm；非浏览器环境（DOM 替身测试）默认确认
    confirm: (message) =>
      typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true,
    refresh: () => {
      if (currentView) void renderView(currentView);
    },
  };

  /** 导航渲染：仅渲染当前权限覆盖的入口（服务端守卫仍是唯一权威，R-09）。 */
  function renderNav() {
    nav.textContent = '';
    for (const view of ADMIN_VIEWS) {
      if (!permissions.has(view.permission)) continue;
      const item = el(doc, 'button', {
        className: `admin-nav-item${view.id === currentView ? ' active' : ''}`,
        text: view.title,
        attrs: { type: 'button', 'data-view': view.id },
      });
      item.addEventListener('click', () => navigate(view.id));
      nav.appendChild(item);
    }
  }

  /** 渲染指定视图；无权限直达 → 无权限态（AC-02）。 */
  async function renderView(viewId) {
    // DEF-02 并发防护：先递增世代号；慢响应晚到时若世代已过期则丢弃其写回，
    // 内容区始终与 currentView/hash 一致（旧视图内部交互写其自身暂存容器，不影响当前视图）。
    const generation = ++renderGeneration;
    const view = ADMIN_VIEWS.find((v) => v.id === viewId);
    currentView = view ? viewId : null;
    renderNav();
    if (!view || !permissions.has(view.permission)) {
      renderState(content, doc, 'forbidden');
      return;
    }
    renderState(content, doc, 'loading');
    const stage = el(doc, 'div', { className: 'admin-view-stage' });
    await view.render(stage, ctx);
    if (generation !== renderGeneration) return; // 已有更新的渲染接管，丢弃过期内容
    content.textContent = '';
    content.appendChild(stage);
  }

  /** 视图切换：同步 hash（可书签/刷新回显）并渲染。 */
  function navigate(viewId) {
    if (typeof window !== 'undefined' && window.location) {
      suppressHashSync = true;
      window.location.hash = `#/admin/${viewId}`;
    }
    void renderView(viewId);
  }

  /** 进入管理壳：按权限渲染导航，落到首个可见视图（或 hash 指定视图）。 */
  function enter(granted) {
    permissions = new Set(granted);
    const fromHash = parseHash();
    const first = ADMIN_VIEWS.find((v) => permissions.has(v.permission));
    const target = fromHash ?? (first ? first.id : null);
    renderNav();
    if (target) void renderView(target);
    else renderState(content, doc, 'forbidden');
  }

  /** 解析 #/admin/<view> hash；非法或未知视图返回 null。 */
  function parseHash() {
    if (typeof window === 'undefined' || !window.location) return null;
    const match = /^#\/admin\/([a-z]+)$/.exec(window.location.hash || '');
    if (!match) return null;
    return ADMIN_VIEWS.some((v) => v.id === match[1]) ? match[1] : null;
  }

  doc.getElementById('admin-back').addEventListener('click', () => {
    if (hooks.onBack) hooks.onBack();
  });
  doc.getElementById('admin-logout').addEventListener('click', () => {
    if (hooks.onLogout) hooks.onLogout();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      if (suppressHashSync) {
        suppressHashSync = false;
        return;
      }
      const viewId = parseHash();
      if (viewId) void renderView(viewId);
    });
  }

  return { enter, navigate };
}

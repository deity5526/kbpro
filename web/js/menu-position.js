/**
 * KBPRO — 浮层菜单定位与关闭策略（纯函数，无 DOM 依赖，便于单测）
 *
 * 为什么单独抽出来：这里曾经有一个真实且严重的 bug。
 *   1) .dropdown 的高度在 CSS 里写死为 max-height: 380px；
 *      文件操作菜单有 14 个条目（自然高度约 470px），于是被截断，
 *      「共享与权限 / 导出为 Markdown / 导出为 HTML / 删除」四项落在可视区之外。
 *   2) dropdown() 在 window 上以**捕获阶段**监听 scroll 并直接关闭菜单。
 *      滚动事件不冒泡，但捕获阶段依然会传到 window —— 所以在菜单内部滚动时，
 *      菜单会把自己关掉，被截断的条目永远点不到。
 *
 * 现在的策略：
 *   · 按锚点上下各自剩余的空间选边，并把 max-height 收敛到可用高度，
 *     让菜单优先「完整展示」，内部滚动只是兜底；
 *   · 菜单自身的滚动不再关闭菜单；其它滚动（列表、页面）照旧关闭，
 *     避免菜单和锚点错位。
 */

/** 菜单与锚点之间的间距 */
export const MENU_GAP = 6;
/** 菜单与视口边缘的最小安全距离 */
export const MENU_PAD = 8;
/** 极端窄窗口下仍然保留的最小可滚动高度 */
export const MENU_MIN_HEIGHT = 96;

/**
 * 计算浮层菜单的位置与最大高度。
 *
 * @param {{top:number,bottom:number,left:number,right:number}} anchorRect 锚点的视口矩形
 * @param {number} menuWidth  菜单自然宽度（已受 CSS max-height 之外的宽度约束）
 * @param {number} menuHeight 菜单自然高度（未受 max-height 限制）
 * @param {{viewportWidth:number,viewportHeight:number,align?:'start'|'end',gap?:number,pad?:number}} opts
 * @returns {{left:number, top:number, maxHeight:number, placedAbove:boolean}}
 */
export function placeMenu(anchorRect, menuWidth, menuHeight, opts = {}) {
  const {
    viewportWidth,
    viewportHeight,
    align = 'end',
    gap = MENU_GAP,
    pad = MENU_PAD
  } = opts;

  let left = align === 'end' ? anchorRect.right - menuWidth : anchorRect.left;
  left = Math.max(pad, Math.min(left, viewportWidth - menuWidth - pad));

  const roomBelow = viewportHeight - anchorRect.bottom - gap - pad;
  const roomAbove = anchorRect.top - gap - pad;

  // 下方放得下就放下方；放不下且上方更宽裕才翻转。
  const placedAbove = menuHeight > roomBelow && roomAbove > roomBelow;
  const room = placedAbove ? roomAbove : roomBelow;
  const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.floor(room));
  const height = Math.min(menuHeight, maxHeight);

  let top = placedAbove ? anchorRect.top - gap - height : anchorRect.bottom + gap;
  // 锚点本身可能被滚出视口（长列表 / 贴边的右键菜单），此时把菜单拉回可视区，
  // 否则整个菜单会落在屏幕之外，看起来像「点了没反应」。
  top = Math.max(pad, Math.min(top, viewportHeight - pad - height));

  return { left, top, maxHeight, placedAbove };
}

/**
 * 收到 scroll 事件时，是否应当关闭菜单。
 *
 * 菜单**自身**的内部滚动必须放行 —— 否则被 max-height 截断的条目永远无法访问。
 * 其它任何滚动（文件列表、页面、目录树）仍然关闭菜单，避免菜单与锚点错位。
 *
 * @param {{contains?:(node:any)=>boolean}} menu 菜单根节点
 * @param {any} target 滚动事件的目标
 * @returns {boolean} true 表示应关闭
 */
export function shouldDismissOnScroll(menu, target) {
  if (target && menu && typeof menu.contains === 'function' && menu.contains(target)) return false;
  return true;
}

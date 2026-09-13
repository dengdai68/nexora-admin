/**
 * 时钟抽象（AD-08）：默认系统时间，测试可注入固定/推进时钟以复现 24h 绝对过期。
 */

/** @returns {{now: () => number}} 系统时钟 */
export function systemClock() {
  return { now: () => Date.now() };
}

/**
 * 可推进的测试时钟。
 * @param {number} startMs 初始毫秒时间戳
 * @returns {{now: () => number, advance: (ms: number) => void, set: (ms: number) => void}}
 */
export function fakeClock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

/**
 * 最小日志器（REQ-014 / AC-10 脱敏契约）：
 * 只允许记录方法、路径、状态码、稳定错误码与内部异常堆栈；
 * 永不记录请求体、明文密码、会话 token 本体、Cookie 头值。
 * 该约束靠调用方遵守（routes/http-server 只传白名单字段），本模块不提供通用对象打印入口，
 * 从接口形状上降低误传敏感对象的概率。
 */

/**
 * 创建日志器。
 * @param {{write?: (line: string) => void}} [sink] 输出目标，默认 stdout
 */
export function createLogger(sink = {}) {
  const write = sink.write ?? ((line) => process.stdout.write(`${line}\n`));
  const emit = (level, message) => {
    write(`${new Date().toISOString()} ${level} ${message}`);
  };
  return {
    /** 请求摘要：仅方法/路径/状态码/错误码。 */
    request: (method, path, status, code = '-') => {
      emit('INFO', `request method=${method} path=${path} status=${status} code=${code}`);
    },
    /** 生命周期事件（启动/停止/迁移/清理计数）。 */
    info: (message) => emit('INFO', message),
    /** 内部异常：message 为稳定描述，stack 为服务端堆栈（不含请求体）。 */
    error: (message, stack) => {
      emit('ERROR', stack ? `${message}\n${stack}` : message);
    },
  };
}
